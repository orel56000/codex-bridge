import { BridgeError, ERRORS } from '@codex-bridge/shared';
import type { Logger } from '@codex-bridge/shared';
import { BRIDGE_CLIENT_NAME, BRIDGE_CLIENT_TITLE, BRIDGE_VERSION } from '@codex-bridge/shared';
import { JsonRpcConnection } from './jsonrpc.js';
import { CodexProcess, type CodexProcessOptions } from './process.js';
import { AsyncQueue, deferred, type Deferred } from './queue.js';
import {
  describeWindow,
  type CodexAccount,
  type CodexEvent,
  type LoginSession,
  type RateLimitInfo,
  type RateLimitWindowInfo,
} from './events.js';
import type {
  Account,
  AccountLoginCompletedNotification,
  AskForApproval,
  CodexModel,
  DynamicToolSpec,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ErrorNotification,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  InitializeResponse,
  ItemLifecycleNotification,
  LoginAccountResponse,
  ModelListResponse,
  RateLimitSnapshot,
  RateLimitsUpdatedNotification,
  ReasoningEffort,
  SandboxMode,
  ThreadStartResponse,
  TokenUsageNotification,
  TurnLifecycleNotification,
  TurnStartResponse,
  TurnToolOutput,
  UserInput,
} from './protocol.js';

export interface CodexClientOptions extends CodexProcessOptions {
  /**
   * Let Codex use its own shell/patch tools. Off by default — see
   * {@link BridgeConfig.codex.allowNativeTools}.
   */
  allowNativeTools?: boolean;
  /** How long to wait for `initialize` before giving up. */
  initializeTimeoutMs?: number;
  /**
   * How the ChatGPT sign-in presents itself.
   *
   * Defaults keep the whole flow in the browser and hand you back to the
   * terminal. `useHostedSuccessPage: true` finishes on OpenAI's hosted page,
   * which with `appBrand: 'chatgpt'` offers to open the ChatGPT desktop app —
   * a surprising detour when you were signing in from a CLI.
   */
  login?: {
    appBrand?: 'codex' | 'chatgpt';
    useHostedSuccessPage?: boolean;
  };
}

export interface CreateThreadOptions {
  cwd?: string;
  model?: string;
  /** Replaces Codex's own agent instructions with the caller's system prompt. */
  baseInstructions?: string;
  tools?: DynamicToolSpec[];
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  ephemeral?: boolean;
}

export interface CodexThread {
  id: string;
  model: string;
  cwd: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface RunTurnOptions {
  input: UserInput[];
  /**
   * Start the turn from a tool result rather than a user message. Used when a
   * parked call could not be matched (e.g. after a gateway restart) so the
   * conversation can still continue instead of dead-ending.
   */
  toolOutput?: TurnToolOutput | null;
  model?: string;
  effort?: ReasoningEffort | null;
  signal?: AbortSignal;
}

export interface TurnHandle {
  events: AsyncIterable<CodexEvent>;
  /** Resolves once the turn id is known. */
  turnId: Promise<string>;
  /** Ask Codex to stop. Safe to call more than once. */
  interrupt(): Promise<void>;
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/**
 * Typed client for the Codex App Server.
 *
 * The only place in the bridge that knows the JSON-RPC method names. Everything
 * it exposes is plain TypeScript, so the gateway can be unit-tested against a
 * fake without a Codex install.
 */
export class CodexAppServerClient {
  private proc: CodexProcess | null = null;
  private conn: JsonRpcConnection | null = null;
  private initialized: Promise<InitializeResponse> | null = null;
  private readonly logger: Logger;
  private readonly opts: CodexClientOptions;

  /** turnId → queue of events for that turn. */
  private readonly turnQueues = new Map<string, AsyncQueue<CodexEvent>>();
  /** threadId → turnId, for events that arrive before `turn/start` returns. */
  private readonly threadToTurn = new Map<string, string>();
  /**
   * Queues of turns that already ended, kept briefly so a `turn/start` response
   * that lands after the turn is over still finds the events it produced.
   */
  private readonly finishedTurns = new Map<string, AsyncQueue<CodexEvent>>();
  /** callId → parked Codex tool call awaiting a Claude Code tool_result. */
  private readonly pendingToolCalls = new Map<string, Deferred<DynamicToolCallResponse>>();
  /** callId → turnId, so a stale settle can be attributed. */
  private readonly toolCallTurn = new Map<string, string>();
  /** loginId → waiter for `account/login/completed`. */
  private readonly loginWaiters = new Map<string, Deferred<{ success: boolean; error: string | null }>>();

  private lastRateLimits: RateLimitSnapshot | null = null;
  private lastAccount: Account | null = null;
  private modelCache: { models: CodexModel[]; at: number } | null = null;

  readonly listeners = {
    onAccountUpdated: new Set<(a: Account | null) => void>(),
    onRateLimits: new Set<(s: RateLimitSnapshot) => void>(),
    onExit: new Set<(info: { code: number | null; expected: boolean }) => void>(),
  };

  constructor(opts: CodexClientOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('codex-client');
  }

  get isRunning(): boolean {
    return this.proc?.running === true && this.conn?.isClosed === false;
  }

  get codexBinary(): string | null {
    return this.proc?.binPath ?? null;
  }

  get cachedRateLimits(): RateLimitSnapshot | null {
    return this.lastRateLimits;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Start the App Server (if needed) and perform the `initialize` handshake. */
  initialize(): Promise<InitializeResponse> {
    if (this.initialized) return this.initialized;
    this.initialized = this.doInitialize().catch((err) => {
      this.initialized = null;
      throw err;
    });
    return this.initialized;
  }

  private async doInitialize(): Promise<InitializeResponse> {
    const proc = new CodexProcess(this.opts);
    this.proc = proc;
    const child = proc.start();

    proc.on('exit', (info) => {
      const err = new BridgeError(
        'codex_crashed',
        info.expected ? 'Codex App Server stopped.' : 'Codex App Server exited unexpectedly.',
        info.expected ? {} : { hint: 'It will be restarted on the next request.' },
      );
      // `initialized` is cleared below, so the next call to initialize() builds
      // a fresh process AND a fresh connection. Restarting the child on its own
      // would leave a running App Server with no JSON-RPC peer.
      if (this.proc === proc) this.proc = null;
      this.conn?.close(err);
      this.conn = null;
      this.initialized = null;
      for (const q of this.turnQueues.values()) q.fail(err);
      this.turnQueues.clear();
      for (const d of this.pendingToolCalls.values()) d.reject(err);
      this.pendingToolCalls.clear();
      for (const l of this.listeners.onExit) l({ code: info.code, expected: info.expected });
    });

    const conn = new JsonRpcConnection({
      input: child.stdout,
      output: child.stdin,
      logger: this.logger,
      onNotification: (m, p) => this.onNotification(m, p),
      onServerRequest: (m, p) => this.onServerRequest(m, p),
    });
    this.conn = conn;

    const timeoutMs = this.opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    const res = await withTimeout(
      conn.request<InitializeResponse>('initialize', {
        clientInfo: { name: BRIDGE_CLIENT_NAME, title: BRIDGE_CLIENT_TITLE, version: BRIDGE_VERSION },
        // `experimentalApi` is what unlocks `thread/start.dynamicTools`, which is
        // how Claude Code's tools reach the model.
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      timeoutMs,
      () =>
        new BridgeError('codex_start_failed', 'Codex App Server did not respond to initialize.', {
          hint: `Waited ${Math.round(timeoutMs / 1000)}s. Try: codex doctor`,
        }),
    );
    conn.notify('initialized');
    proc.markHealthy();
    this.logger.info('Codex App Server ready', { userAgent: res.userAgent, codexHome: res.codexHome });
    return res;
  }

  async shutdown(): Promise<void> {
    this.conn?.close(new BridgeError('cancelled', 'Shutting down.'));
    this.conn = null;
    this.initialized = null;
    await this.proc?.stop();
    this.proc = null;
  }

  private requireConn(): JsonRpcConnection {
    const conn = this.conn;
    if (!conn || conn.isClosed) {
      throw new BridgeError('codex_crashed', 'Codex App Server is not connected.', {
        hint: 'Run /codex-restart.',
      });
    }
    return conn;
  }

  /* ------------------------------- account ------------------------------- */

  async getAccount(refreshToken = false): Promise<CodexAccount | null> {
    await this.initialize();
    const res = await this.requireConn().request<GetAccountResponse>('account/read', { refreshToken });
    this.lastAccount = res.account;
    return toAccount(res.account);
  }

  /** Raw `account/read`, for callers that need `requiresOpenaiAuth`. */
  async readAccountRaw(refreshToken = false): Promise<GetAccountResponse> {
    await this.initialize();
    return this.requireConn().request<GetAccountResponse>('account/read', { refreshToken });
  }

  /**
   * Start the official managed ChatGPT login.
   *
   * Codex owns the OAuth exchange and the resulting tokens end-to-end; the
   * bridge only sees a login id and a URL to open.
   */
  async startLogin(mode: 'browser' | 'deviceCode' = 'browser'): Promise<LoginSession> {
    await this.initialize();
    const params =
      mode === 'deviceCode'
        ? { type: 'chatgptDeviceCode' as const }
        : {
            type: 'chatgpt' as const,
            // `false` makes Codex serve its own completion page from the local
            // callback server, so the browser tab finishes the job and you come
            // straight back here.
            useHostedLoginSuccessPage: this.opts.login?.useHostedSuccessPage ?? false,
            appBrand: this.opts.login?.appBrand ?? 'codex',
          };
    const res = await this.requireConn().request<LoginAccountResponse>('account/login/start', params);

    if (res.type === 'chatgpt') {
      const waiter = deferred<{ success: boolean; error: string | null }>();
      this.loginWaiters.set(res.loginId, waiter);
      return { kind: 'browser', loginId: res.loginId, url: res.authUrl, completed: waiter.promise };
    }
    if (res.type === 'chatgptDeviceCode') {
      const waiter = deferred<{ success: boolean; error: string | null }>();
      this.loginWaiters.set(res.loginId, waiter);
      return {
        kind: 'deviceCode',
        loginId: res.loginId,
        url: res.verificationUrl,
        userCode: res.userCode,
        completed: waiter.promise,
      };
    }
    throw new BridgeError('login_failed', 'Codex returned an unexpected login type.');
  }

  async cancelLogin(loginId: string): Promise<void> {
    const waiter = this.loginWaiters.get(loginId);
    this.loginWaiters.delete(loginId);
    waiter?.resolve({ success: false, error: 'cancelled' });
    try {
      await this.requireConn().request('account/login/cancel', { loginId });
    } catch (err) {
      this.logger.debug('login cancel failed (already finished?)', { err });
    }
  }

  async logout(): Promise<void> {
    await this.initialize();
    await this.requireConn().request('account/logout', undefined);
    this.lastAccount = null;
    this.lastRateLimits = null;
  }

  async getRateLimits(): Promise<RateLimitInfo | null> {
    await this.initialize();
    try {
      const res = await this.requireConn().request<GetAccountRateLimitsResponse>(
        'account/rateLimits/read',
        { excludeResetCreditDetails: true },
      );
      this.lastRateLimits = res.rateLimits;
      return toRateLimitInfo(res.ordinaryUsageAllowed, res.rateLimits);
    } catch (err) {
      // Usage data is optional: never fabricate it, just report that it is absent.
      this.logger.debug('rate limit read failed', { err });
      return null;
    }
  }

  /* -------------------------------- models -------------------------------- */

  async listModels(force = false): Promise<CodexModel[]> {
    await this.initialize();
    const fresh = this.modelCache && Date.now() - this.modelCache.at < 5 * 60_000;
    if (!force && fresh && this.modelCache) return this.modelCache.models;

    const out: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res: ModelListResponse = await this.requireConn().request<ModelListResponse>('model/list', {
        limit: 50,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...res.data);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    this.modelCache = { models: out, at: Date.now() };
    return out;
  }

  /** The model Codex itself considers default. Never hardcoded. */
  async defaultModel(): Promise<string | null> {
    const models = await this.listModels();
    return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null;
  }

  /* -------------------------------- threads ------------------------------- */

  async createThread(opts: CreateThreadOptions = {}): Promise<CodexThread> {
    await this.initialize();
    const allowNative = this.opts.allowNativeTools === true;
    const params: Record<string, unknown> = {
      cwd: opts.cwd ?? process.cwd(),
      ephemeral: opts.ephemeral ?? false,
      // Claude Code executes every tool itself. Unless the user opts in, Codex
      // must not be able to touch the machine: read-only sandbox, and every
      // command escalated to an approval we decline.
      approvalPolicy: opts.approvalPolicy ?? (allowNative ? 'on-request' : 'untrusted'),
      sandbox: opts.sandbox ?? (allowNative ? 'workspace-write' : 'read-only'),
    };
    if (opts.model) params['model'] = opts.model;
    if (opts.baseInstructions) params['baseInstructions'] = opts.baseInstructions;
    if (opts.tools?.length) params['dynamicTools'] = opts.tools;

    const res = await this.requireConn().request<ThreadStartResponse>('thread/start', params);
    return {
      id: res.thread.id,
      model: res.model,
      cwd: res.cwd,
      reasoningEffort: res.reasoningEffort,
    };
  }

  async resumeThread(threadId: string, opts: { cwd?: string; baseInstructions?: string } = {}): Promise<CodexThread> {
    await this.initialize();
    const res = await this.requireConn().request<ThreadStartResponse>('thread/resume', {
      threadId,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.baseInstructions ? { baseInstructions: opts.baseInstructions } : {}),
    });
    return { id: res.thread.id, model: res.model, cwd: res.cwd, reasoningEffort: res.reasoningEffort };
  }

  /**
   * Append raw Responses API items to a thread's model-visible history.
   *
   * Used to replay a Claude Code conversation into a freshly created thread
   * without spending turns on it, so continuity survives a thread rebuild.
   */
  async injectItems(threadId: string, items: unknown[]): Promise<void> {
    if (!items.length) return;
    await this.requireConn().request('thread/inject_items', { threadId, items });
  }

  /* --------------------------------- turns -------------------------------- */

  /**
   * Start a turn and stream its events.
   *
   * A turn that issues a tool call stays *open* on the Codex side: the
   * `item/tool/call` JSON-RPC request is parked until
   * {@link settleToolCall} is called, which may be during a later HTTP request.
   * That is what gives Claude Code's request/response tool loop conversation
   * continuity on a protocol that expects an inline callback.
   */
  runTurn(threadId: string, opts: RunTurnOptions): TurnHandle {
    // The queue is NOT created here. Codex can coalesce the `turn/start`
    // response and the whole turn's notifications into one stdout chunk, so by
    // the time this promise resolves the turn may already be over. Everything
    // routes through the single queue `queueFor(turnId)` owns, which the
    // notification handler creates on demand; a second queue would silently
    // swallow the entire turn.
    const pending = new AsyncQueue<CodexEvent>();
    let queue: AsyncQueue<CodexEvent> = pending;
    const turnIdDeferred = deferred<string>();
    let resolvedTurnId: string | null = null;

    const params: Record<string, unknown> = { threadId, input: opts.input };
    if (opts.toolOutput) params['toolOutput'] = opts.toolOutput;
    if (opts.model) params['model'] = opts.model;
    if (opts.effort) params['effort'] = opts.effort;

    const startPromise = (async () => {
      const res = await this.requireConn().request<TurnStartResponse>('turn/start', params);
      const turnId = res.turn.id;
      resolvedTurnId = turnId;
      this.threadToTurn.set(threadId, turnId);
      // `queueFor` returns the queue the notification handler has been filling,
      // creating it only if nothing has arrived yet. `finishedTurns` covers the
      // case where the turn already completed and its queue was removed.
      queue = this.finishedTurns.get(turnId) ?? this.queueFor(turnId);
      queue.push({ type: 'turn_started', turnId });
      turnIdDeferred.resolve(turnId);
      return turnId;
    })();

    startPromise.catch((err) => {
      turnIdDeferred.reject(err);
      pending.fail(err);
      queue.fail(err);
    });

    const interrupt = async (): Promise<void> => {
      let turnId = resolvedTurnId;
      if (!turnId) {
        try {
          turnId = await withTimeout(turnIdDeferred.promise, 2_000, () => new Error('no turn id'));
        } catch {
          return;
        }
      }
      // Free any parked tool calls first so Codex is not blocked on us.
      for (const [callId, d] of this.pendingToolCalls) {
        if (this.toolCallTurn.get(callId) === turnId) {
          d.resolve({ contentItems: [{ type: 'inputText', text: 'Cancelled by the client.' }], success: false });
          this.pendingToolCalls.delete(callId);
          this.toolCallTurn.delete(callId);
        }
      }
      try {
        await this.requireConn().request('turn/interrupt', { threadId, turnId });
      } catch (err) {
        this.logger.debug('interrupt failed', { err });
      }
      queue.push({ type: 'interrupted' });
      queue.end();
    };

    if (opts.signal) {
      if (opts.signal.aborted) void interrupt();
      else opts.signal.addEventListener('abort', () => void interrupt(), { once: true });
    }

    // Hand back an iterable that resolves to the real queue once it is known,
    // so a caller can start consuming before `turn/start` has answered.
    const events: AsyncIterable<CodexEvent> = {
      [Symbol.asyncIterator]: () => {
        let inner: AsyncIterator<CodexEvent> | null = null;
        return {
          next: async (): Promise<IteratorResult<CodexEvent>> => {
            if (!inner) {
              await turnIdDeferred.promise.catch(() => undefined);
              inner = queue[Symbol.asyncIterator]();
            }
            return inner.next();
          },
        };
      },
    };

    return { events, turnId: turnIdDeferred.promise, interrupt };
  }

  /**
   * Re-attach to a turn that is still open.
   *
   * A turn that parked on a tool call outlives the HTTP response that started
   * it: the next Claude Code request settles the tool and resumes streaming
   * from the same queue.
   */
  turnEvents(turnId: string): AsyncQueue<CodexEvent> {
    return this.queueFor(turnId);
  }

  /** True when the turn is still open on the Codex side. */
  hasOpenTurn(turnId: string): boolean {
    return this.turnQueues.has(turnId);
  }

  /**
   * Stop consuming a turn's events without ending it. Any iterator currently
   * awaiting an event is released so no future event is delivered to nobody.
   */
  detachTurn(turnId: string): void {
    this.turnQueues.get(turnId)?.releaseWaiters();
  }

  /**
   * Interrupt a turn by id.
   *
   * `runTurn` returns an `interrupt`, but a turn that parked on a tool call is
   * resumed by a *different* HTTP request that never saw that handle. Without
   * this, abandoning a resumed turn leaves Codex running with nobody listening.
   */
  async interruptTurn(threadId: string, turnId: string, reason: string): Promise<void> {
    this.abandonToolCalls(turnId, reason);
    try {
      await this.requireConn().request('turn/interrupt', { threadId, turnId });
    } catch (err) {
      this.logger.debug('interrupt failed', { err });
    }
    const q = this.turnQueues.get(turnId);
    if (q) {
      q.push({ type: 'interrupted' });
      q.end();
      this.turnQueues.delete(turnId);
    }
  }

  /** Answer a parked Codex tool call with a Claude Code tool result. */
  settleToolCall(callId: string, response: DynamicToolCallResponse): boolean {
    const d = this.pendingToolCalls.get(callId);
    if (!d) return false;
    this.pendingToolCalls.delete(callId);
    const turnId = this.toolCallTurn.get(callId);
    this.toolCallTurn.delete(callId);
    d.resolve(response);
    if (turnId) this.turnQueues.get(turnId)?.push({ type: 'tool_call_settled', callId, success: response.success });
    return true;
  }

  hasPendingToolCall(callId: string): boolean {
    return this.pendingToolCalls.has(callId);
  }

  pendingToolCallIds(): string[] {
    return [...this.pendingToolCalls.keys()];
  }

  /** Abandon parked calls for a turn (e.g. the HTTP client vanished). */
  abandonToolCalls(turnId: string, reason: string): void {
    for (const [callId, d] of this.pendingToolCalls) {
      if (this.toolCallTurn.get(callId) !== turnId) continue;
      this.pendingToolCalls.delete(callId);
      this.toolCallTurn.delete(callId);
      d.resolve({ contentItems: [{ type: 'inputText', text: reason }], success: false });
    }
  }

  /* ------------------------------ dispatching ----------------------------- */

  /**
   * Retire a turn: drop its queue and settle anything still parked on it.
   *
   * Every exit path for a turn goes through here, so a parked `item/tool/call`
   * can never outlive the turn that issued it.
   */
  private retireTurn(turnId: string, reason: string): void {
    const q = this.turnQueues.get(turnId);
    this.turnQueues.delete(turnId);
    if (q) {
      this.finishedTurns.set(turnId, q);
      // Bounded: only the most recent few matter, and only for a moment.
      if (this.finishedTurns.size > 32) {
        const oldest = this.finishedTurns.keys().next().value;
        if (oldest !== undefined) this.finishedTurns.delete(oldest);
      }
    }
    this.abandonToolCalls(turnId, reason);
  }

  private queueFor(turnId: string): AsyncQueue<CodexEvent> {
    let q = this.turnQueues.get(turnId);
    if (!q) {
      q = new AsyncQueue<CodexEvent>();
      this.turnQueues.set(turnId, q);
    }
    return q;
  }

  private onNotification(method: string, rawParams: unknown): void {
    const params = rawParams as Record<string, unknown>;
    switch (method) {
      case 'item/agentMessage/delta': {
        const p = params as unknown as { turnId: string; itemId: string; delta: string };
        this.queueFor(p.turnId).push({ type: 'text_delta', itemId: p.itemId, text: p.delta });
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const p = params as unknown as { turnId: string; itemId: string; delta: string };
        this.queueFor(p.turnId).push({ type: 'reasoning_delta', itemId: p.itemId, text: p.delta });
        return;
      }
      case 'item/completed': {
        const p = params as unknown as ItemLifecycleNotification;
        const item = p.item as Record<string, unknown>;
        const q = this.queueFor(p.turnId);
        if (item['type'] === 'agentMessage') {
          q.push({ type: 'text_done', itemId: String(item['id']), text: String(item['text'] ?? '') });
        } else if (item['type'] === 'reasoning') {
          const summary = Array.isArray(item['summary']) ? (item['summary'] as string[]).join('\n') : '';
          const content = Array.isArray(item['content']) ? (item['content'] as string[]).join('\n') : '';
          q.push({ type: 'reasoning_done', itemId: String(item['id']), text: summary || content });
        } else if (item['type'] === 'commandExecution' || item['type'] === 'fileChange' || item['type'] === 'mcpToolCall') {
          q.push({ type: 'native_activity', item: p.item });
        }
        return;
      }
      case 'turn/started': {
        const p = params as unknown as TurnLifecycleNotification;
        this.threadToTurn.set(p.threadId, p.turn.id);
        return;
      }
      case 'turn/completed': {
        const p = params as unknown as TurnLifecycleNotification;
        const q = this.queueFor(p.turn.id);
        q.push({ type: 'turn_completed', turn: p.turn });
        q.end();
        this.retireTurn(p.turn.id, 'The Codex turn ended before this tool result arrived.');
        this.threadToTurn.delete(p.threadId);
        this.proc?.markHealthy();
        return;
      }
      case 'error': {
        const p = params as unknown as ErrorNotification;
        if (!p.turnId) return;
        const q = this.queueFor(p.turnId);
        q.push({ type: 'turn_failed', error: p.error, willRetry: p.willRetry });
        if (!p.willRetry) {
          q.end();
          // A failed turn can never answer a parked tool call. Leaving those
          // promises behind makes the NEXT request resume a dead turn and hang
          // until the request timeout.
          this.retireTurn(p.turnId, 'The Codex turn failed before this tool result arrived.');
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = params as unknown as TokenUsageNotification;
        this.turnQueues.get(p.turnId)?.push({ type: 'usage', usage: p.tokenUsage.last ?? p.tokenUsage.total });
        return;
      }
      case 'account/rateLimits/updated': {
        const p = params as unknown as RateLimitsUpdatedNotification;
        this.lastRateLimits = p.rateLimits;
        for (const l of this.listeners.onRateLimits) l(p.rateLimits);
        return;
      }
      case 'account/updated': {
        this.lastAccount = null;
        for (const l of this.listeners.onAccountUpdated) l(null);
        return;
      }
      case 'account/login/completed': {
        const p = params as unknown as AccountLoginCompletedNotification;
        const key = p.loginId ?? [...this.loginWaiters.keys()][0];
        if (key) {
          const waiter = this.loginWaiters.get(key);
          this.loginWaiters.delete(key);
          waiter?.resolve({ success: p.success, error: p.error });
        }
        return;
      }
      default:
        this.logger.debug('unhandled notification', { method });
    }
  }

  private async onServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case 'item/tool/call': {
        const p = rawParams as DynamicToolCallParams;
        const d = deferred<DynamicToolCallResponse>();
        this.pendingToolCalls.set(p.callId, d);
        this.toolCallTurn.set(p.callId, p.turnId);
        this.queueFor(p.turnId).push({
          type: 'tool_call',
          callId: p.callId,
          name: p.tool,
          namespace: p.namespace,
          input: p.arguments,
        });
        // Parked until the gateway sees the matching tool_result.
        return d.promise;
      }

      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval':
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
      case 'item/permissions/requestApproval': {
        if (this.opts.allowNativeTools) return { decision: 'acceptForSession' };
        this.logger.debug('declining Codex native action', { method });
        return { decision: 'decline' };
      }

      case 'item/tool/requestUserInput': {
        // Claude Code owns the user interaction; answer with nothing so Codex
        // continues rather than hanging.
        return { answers: {} };
      }

      case 'mcpServer/elicitation/request':
        return { action: 'decline' };

      default:
        this.logger.debug('unhandled server request', { method });
        return {};
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

function toAccount(account: Account | null): CodexAccount | null {
  if (!account) return null;
  if (account.type === 'chatgpt') {
    return { kind: 'chatgpt', email: account.email, planType: account.planType ?? null };
  }
  if (account.type === 'apiKey') return { kind: 'apiKey', email: null, planType: null };
  return { kind: 'other', email: null, planType: null };
}

function toRateLimitInfo(
  ordinaryUsageAllowed: boolean | null,
  snap: RateLimitSnapshot | null,
): RateLimitInfo | null {
  if (!snap) return null;
  const win = (w: typeof snap.primary): RateLimitWindowInfo | null =>
    w
      ? {
          usedPercent: w.usedPercent,
          windowDurationMins: w.windowDurationMins,
          resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000) : null,
          label: describeWindow(w.windowDurationMins),
        }
      : null;
  return {
    ordinaryUsageAllowed,
    primary: win(snap.primary),
    secondary: win(snap.secondary),
    planType: snap.planType ?? null,
    rateLimitReachedType: snap.rateLimitReachedType ?? null,
    credits: snap.credits
      ? { hasCredits: snap.credits.hasCredits, unlimited: snap.credits.unlimited, balance: snap.credits.balance }
      : null,
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export { ERRORS };
