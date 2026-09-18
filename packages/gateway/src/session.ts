import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Logger } from '@codex-bridge/shared';
import { bridgeSessionsFile, writeFileSecure } from '@codex-bridge/shared';
import type { CodexAppServerClient, CodexThread, DynamicToolSpec } from '@codex-bridge/codex-client';

/**
 * Claude Code conversation  <->  Codex thread.
 *
 * Claude Code is stateless on the wire (it re-sends the whole history every
 * turn) while Codex threads are stateful. The mapping here is what stops the
 * bridge from opening a brand-new Codex conversation on every HTTP request,
 * which would throw away the model's context (and its cached reasoning) each
 * time a tool came back.
 *
 * Nothing credential-shaped is persisted: the on-disk file holds thread ids and
 * timestamps only.
 */

export interface SessionRecord {
  key: string;
  threadId: string;
  model: string;
  cwd: string;
  /** Hash of the system prompt + tool set the thread was created with. */
  shape: string;
  /** Codex tool name -> the Anthropic name Claude Code declared. */
  toolNameMap: Record<string, string>;
  /** Fingerprints of the messages already handed to Codex, in order. */
  consumed: string[];
  /** anthropic tool_use id -> codex callId, for calls parked across requests. */
  parked: Record<string, string>;
  /** The Codex turn that is parked, if any. */
  parkedTurnId: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface EnsureSessionInput {
  key: string;
  baseInstructions: string;
  tools: DynamicToolSpec[];
  cwd: string;
  model: string;
  /** Codex tool name -> the Anthropic name Claude Code declared. */
  toolNameMap: Record<string, string>;
  /** Fingerprints of every message in the incoming request. */
  fingerprints: string[];
}

export interface EnsureSessionResult {
  session: SessionRecord;
  /** True when a fresh Codex thread was created for this request. */
  created: boolean;
  /** Why a thread was rebuilt, for logs and `/codex-doctor`. */
  rebuildReason: string | null;
  /** Number of leading messages Codex already knows about. */
  consumedCount: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logger: Logger;
  private readonly client: CodexAppServerClient;
  private readonly idleTtlMs: number;
  private readonly maxThreads: number;
  private readonly persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  /**
   * In-flight `ensure` calls, keyed by session.
   *
   * `ensure` awaits `createThread`, so two concurrent requests for the same
   * conversation (parallel sub-agents share a session id) would both create a
   * thread and the second would overwrite the first — stranding the first
   * thread and mis-filing its parked tool calls.
   */
  private readonly inFlight = new Map<string, Promise<EnsureSessionResult>>();

  constructor(opts: {
    client: CodexAppServerClient;
    logger: Logger;
    idleTtlMs: number;
    maxThreads: number;
    persistPath?: string;
  }) {
    this.client = opts.client;
    this.logger = opts.logger.child('sessions');
    this.idleTtlMs = opts.idleTtlMs;
    this.maxThreads = opts.maxThreads;
    this.persistPath = opts.persistPath ?? bridgeSessionsFile();
    this.load();
  }

  get size(): number {
    return this.sessions.size;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  get(key: string): SessionRecord | undefined {
    return this.sessions.get(key);
  }

  /**
   * Find the session that is waiting on a given Anthropic tool_use id.
   *
   * This is the exact way to attribute a continuation request to a conversation
   * even when `metadata.user_id` is missing or a client reuses session ids.
   */
  findByParkedToolUse(anthropicId: string): SessionRecord | undefined {
    for (const s of this.sessions.values()) {
      if (s.parked[anthropicId]) return s;
    }
    return undefined;
  }

  /** Get or create the Codex thread backing a Claude Code conversation. */
  async ensure(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    const running = this.inFlight.get(input.key);
    if (running) {
      // Wait for the creation already under way, then re-evaluate: the thread
      // it produced may or may not satisfy this request's shape.
      await running.catch(() => undefined);
    }
    const promise = this.ensureOnce(input).finally(() => {
      if (this.inFlight.get(input.key) === promise) this.inFlight.delete(input.key);
    });
    this.inFlight.set(input.key, promise);
    return promise;
  }

  private async ensureOnce(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    this.evictExpired();
    const shape = shapeHash(input.baseInstructions, input.tools);
    const existing = this.sessions.get(input.key);

    let rebuildReason: string | null = null;
    if (existing) {
      if (existing.shape !== shape) {
        // The system prompt or tool set changed: Codex bound both at
        // `thread/start`, so the thread can no longer represent this request.
        rebuildReason = 'system prompt or tool set changed';
      } else if (!isPrefix(existing.consumed, input.fingerprints)) {
        // Claude Code rewrote its history (compaction, edit, rewind). Codex's
        // context no longer matches what the client believes was said.
        rebuildReason = 'conversation history was rewritten';
      } else if (existing.cwd !== input.cwd) {
        rebuildReason = 'working directory changed';
      }
    }

    if (existing && !rebuildReason) {
      existing.lastUsedAt = Date.now();
      existing.toolNameMap = input.toolNameMap;
      this.schedulePersist();
      return {
        session: existing,
        created: false,
        rebuildReason: null,
        consumedCount: existing.consumed.length,
      };
    }

    if (existing) {
      this.logger.info('rebuilding Codex thread', { key: redactKey(input.key), reason: rebuildReason });
      this.release(input.key, `session rebuilt: ${rebuildReason}`);
    }

    const thread = await this.client.createThread({
      cwd: input.cwd,
      model: input.model,
      baseInstructions: input.baseInstructions,
      tools: input.tools,
    });

    const record: SessionRecord = {
      key: input.key,
      threadId: thread.id,
      model: thread.model,
      cwd: thread.cwd,
      shape,
      toolNameMap: input.toolNameMap,
      consumed: [],
      parked: {},
      parkedTurnId: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(input.key, record);
    this.enforceCap();
    this.schedulePersist();
    return { session: record, created: true, rebuildReason, consumedCount: 0 };
  }

  /** Record that Codex has now seen messages up to `fingerprints`. */
  markConsumed(key: string, fingerprints: string[]): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.consumed = fingerprints.slice();
    s.lastUsedAt = Date.now();
    this.schedulePersist();
  }

  park(key: string, turnId: string, mapping: Record<string, string>): void {
    const s = this.sessions.get(key);
    if (!s) return;
    s.parkedTurnId = turnId;
    Object.assign(s.parked, mapping);
    s.lastUsedAt = Date.now();
    this.schedulePersist();
  }

  unpark(key: string, anthropicIds: string[]): void {
    const s = this.sessions.get(key);
    if (!s) return;
    for (const id of anthropicIds) delete s.parked[id];
    if (Object.keys(s.parked).length === 0) s.parkedTurnId = null;
    s.lastUsedAt = Date.now();
    this.schedulePersist();
  }

  /** Drop a session, freeing any Codex turn it had parked. */
  release(key: string, reason: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    if (s.parkedTurnId) this.client.abandonToolCalls(s.parkedTurnId, reason);
    this.schedulePersist();
  }

  clear(reason = 'cleared'): void {
    for (const key of [...this.sessions.keys()]) this.release(key, reason);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [key, s] of this.sessions) {
      if (s.lastUsedAt < cutoff) {
        this.logger.debug('evicting idle session', { key: redactKey(key) });
        this.release(key, 'session idle');
      }
    }
  }

  private enforceCap(): void {
    if (this.sessions.size <= this.maxThreads) return;
    const ordered = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const excess = this.sessions.size - this.maxThreads;
    for (let i = 0; i < excess; i += 1) {
      const victim = ordered[i];
      if (victim) this.release(victim.key, 'session limit reached');
    }
  }

  /* ------------------------------ persistence ----------------------------- */

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 1_000);
    this.persistTimer.unref?.();
  }

  persist(): void {
    try {
      const payload = {
        version: 1,
        savedAt: Date.now(),
        // Parked tool calls are in-memory promises; they cannot survive a
        // restart, so they are deliberately not written out.
        sessions: this.list().map(({ parked, parkedTurnId, ...rest }) => {
          void parked;
          void parkedTurnId;
          return rest;
        }),
      };
      writeFileSecure(this.persistPath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (err) {
      this.logger.debug('failed to persist sessions', { err });
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw: unknown = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      const list = (raw as { sessions?: unknown })?.sessions;
      if (!Array.isArray(list)) return;
      const cutoff = Date.now() - this.idleTtlMs;
      for (const item of list) {
        const s = item as Partial<SessionRecord>;
        if (typeof s.key !== 'string' || typeof s.threadId !== 'string') continue;
        if ((s.lastUsedAt ?? 0) < cutoff) continue;
        this.sessions.set(s.key, {
          key: s.key,
          threadId: s.threadId,
          model: s.model ?? '',
          cwd: s.cwd ?? '',
          shape: s.shape ?? '',
          toolNameMap: (s.toolNameMap as Record<string, string> | undefined) ?? {},
          consumed: Array.isArray(s.consumed) ? s.consumed : [],
          parked: {},
          parkedTurnId: null,
          createdAt: s.createdAt ?? Date.now(),
          lastUsedAt: s.lastUsedAt ?? Date.now(),
        });
      }
      this.logger.debug('restored sessions', { count: this.sessions.size });
    } catch (err) {
      this.logger.debug('failed to load sessions', { err });
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Identity of the thread's immutable configuration. Codex binds
 * `baseInstructions` and `dynamicTools` at `thread/start`, so a change to
 * either means the existing thread can no longer serve the request.
 */
export function shapeHash(baseInstructions: string, tools: DynamicToolSpec[]): string {
  const h = createHash('sha256');
  h.update(baseInstructions);
  for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    h.update(t.name);
    h.update(t.description);
    h.update(JSON.stringify(t.inputSchema));
  }
  return h.digest('hex').slice(0, 24);
}

export function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

/** Session keys can embed a client session id; keep only a stable short hash in logs. */
export function redactKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export type { CodexThread };
