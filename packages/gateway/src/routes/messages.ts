import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BridgeError, ERRORS, toBridgeError } from '@codex-bridge/shared';
import type { Logger, MessagesRequest, AnthropicStreamEvent } from '@codex-bridge/shared';
import type { CodexAppServerClient, CodexEvent, DynamicToolCallResponse } from '@codex-bridge/codex-client';
import { CodexEventTranslator } from '../translate/codex-to-anthropic.js';
import {
  buildBaseInstructions,
  collectToolResults,
  extractSessionId,
  extractSystemPrompt,
  fallbackSessionKey,
  fingerprintMessages,
  isInputRole,
  isUtilityRequest,
  messageToUserInput,
  messagesToResponseItems,
} from '../translate/anthropic-to-codex.js';
import { anthropicToolsToCodex } from '../translate/tools.js';
import { codexCallIdToAnthropicId } from '../translate/tools.js';
import type { SessionManager, SessionRecord } from '../session.js';
import { redactKey } from '../session.js';
import { ModelMapper, extractWorkingDirectory } from '../models.js';
import { SseWriter } from '../http/sse.js';
import { sendJson, sendAnthropicError } from '../http/respond.js';
import type { ToolResult } from '../translate/tools.js';

/**
 * POST /v1/messages
 *
 * The heart of the bridge. Claude Code speaks a stateless request/response tool
 * loop; Codex speaks a stateful thread whose turn blocks on a callback. The
 * reconciliation is:
 *
 *   Codex asks for a tool  ->  we emit `tool_use` and close the HTTP response
 *                              with `stop_reason: "tool_use"`, leaving the Codex
 *                              turn parked on an unanswered JSON-RPC request.
 *   Claude Code returns
 *   the tool_result        ->  we settle that parked call, re-attach to the same
 *                              turn, and keep streaming into the new response.
 *
 * The model therefore sees one continuous turn while Claude Code sees the
 * request/response cycle it expects.
 */

export interface MessagesRouteDeps {
  client: CodexAppServerClient;
  sessions: SessionManager;
  models: ModelMapper;
  logger: Logger;
  allowNativeTools: boolean;
  defaultCwd: string;
  requestTimeoutMs: number;
  /**
   * How long to wait for further tool calls before closing the Anthropic
   * message. Codex emits parallel calls back-to-back; this keeps them in one
   * assistant message, which is what Claude Code expects.
   */
  toolCallGraceMs?: number;
  onTurn?(info: { sessionKey: string; model: string; toolCalls: number }): void;
}

const DEFAULT_TOOL_GRACE_MS = 200;

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: MessagesRequest,
  deps: MessagesRouteDeps,
): Promise<void> {
  const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const log = deps.logger.child('messages');

  const account = await deps.client.getAccount();
  if (!account) throw ERRORS.notAuthenticated();

  // Claude Code verifies credentials, and validates a `/model` switch, with a
  // real inference request (max_tokens:1, one "test" message, no tools). Round
  // -tripping that through Codex would burn a turn of the user's quota every
  // time a session starts or the model is changed. We answer it directly — but
  // only after `account/read` above proved the ChatGPT session is live, which
  // is exactly what the probe is asking.
  if (isCredentialProbe(body)) {
    const probeModel = (await deps.models.resolve(body.model)).reportedModel;
    respondToProbe(res, probeModel, body.stream === true, requestId);
    return;
  }

  const resolution = await deps.models.resolve(body.model);
  const wantsStream = body.stream === true;
  const exposeThinking = body.thinking?.type === 'enabled';

  const systemText = extractSystemPrompt(body.system);
  const baseInstructions = buildBaseInstructions(body.system, deps.allowNativeTools);
  const { tools, skipped, nameMap } = anthropicToolsToCodex(body.tools);
  if (skipped.length) log.debug('tools without a Codex equivalent were dropped', { skipped });

  const abort = new AbortController();
  let clientGone = false;
  const onClose = (): void => {
    if (res.writableEnded) return;
    clientGone = true;
    abort.abort();
  };
  req.on('aborted', onClose);
  req.on('close', onClose);

  const timeout = setTimeout(() => abort.abort(), deps.requestTimeoutMs);
  timeout.unref?.();

  try {
    /* ------------------------- utility (tool-less) ------------------------- */
    if (isUtilityRequest(body)) {
      await runOneShot(res, body, {
        ...deps,
        requestId,
        codexModel: resolution.codexModel,
        reportedModel: resolution.reportedModel,
        effort: resolution.effort,
        baseInstructions,
        cwd: extractWorkingDirectory(systemText, deps.defaultCwd),
        wantsStream,
        exposeThinking,
        signal: abort.signal,
      });
      return;
    }

    /* --------------------------- session lookup ---------------------------- */
    const lastMessage = body.messages[body.messages.length - 1];
    const toolResults = collectToolResults(lastMessage);

    // A continuation is identified by the tool_use ids it answers — exact, and
    // independent of whether the client sent usable metadata.
    let session: SessionRecord | undefined;
    for (const r of toolResults) {
      const found = deps.sessions.findByParkedToolUse(r.toolUseId);
      if (found) {
        session = found;
        break;
      }
    }

    const sessionKey = session?.key ?? extractSessionId(body) ?? fallbackSessionKey(body);
    const fingerprints = fingerprintMessages(body.messages);
    const cwd = extractWorkingDirectory(systemText, deps.defaultCwd);

    const resumable =
      session &&
      session.parkedTurnId !== null &&
      toolResults.some(
        (r) => session?.parked[r.toolUseId] && deps.client.hasPendingToolCall(session.parked[r.toolUseId] as string),
      );

    let events: AsyncIterable<CodexEvent>;
    let turnId: string;
    let interrupt: () => Promise<void>;

    if (resumable && session) {
      /* ------------------ resume the parked Codex turn ------------------- */
      turnId = session.parkedTurnId as string;
      const settled: string[] = [];
      for (const r of toolResults) {
        const codexCallId = session.parked[r.toolUseId];
        if (!codexCallId) continue;
        const ok = deps.client.settleToolCall(codexCallId, toDynamicToolResponse(r));
        if (ok) settled.push(r.toolUseId);
      }
      deps.sessions.unpark(session.key, settled);
      deps.sessions.markConsumed(session.key, fingerprints);
      events = deps.client.turnEvents(turnId);
      const threadId = session.threadId;
      interrupt = async () => {
        await deps.client.interruptTurn(threadId, turnId, 'The client went away.');
      };
      log.debug('resumed parked turn', { key: redactKey(session.key), turnId, settled: settled.length });
    } else {
      /* ---------------------- start (or rebuild) a turn ------------------- */
      const ensured = await ensureWithReservedNameRecovery(deps, {
        key: sessionKey,
        baseInstructions,
        tools,
        toolNameMap: nameMap,
        cwd,
        model: resolution.codexModel,
        fingerprints,
      }, body, log);
      session = ensured.session;

      // Replay anything Codex has not seen. On a fresh thread that is the whole
      // conversation so far; in steady state it is just the new user message.
      const alreadySeen = ensured.consumedCount;
      const pending = body.messages.slice(alreadySeen);
      const trailing = pending[pending.length - 1];

      const history = trailing && isInputRole(trailing.role) ? pending.slice(0, -1) : pending;
      if (history.length) {
        const items = messagesToResponseItems(history);
        if (items.length) {
          try {
            await deps.client.injectItems(session.threadId, items);
          } catch (err) {
            log.warn('history replay failed; continuing without it', { err });
          }
        }
      }

      let input = trailing && isInputRole(trailing.role) ? messageToUserInput(trailing) : [];
      let toolOutput: { name: string; namespace: null; output: string } | null = null;

      if (!input.length) {
        // The client sent tool results we can no longer match to a parked call
        // (gateway restarted, or the thread was rebuilt). Hand the last result
        // to Codex as a turn tool output so the conversation still continues.
        const orphan = toolResults[toolResults.length - 1];
        if (orphan) {
          toolOutput = {
            name: 'tool_result',
            namespace: null,
            output: orphan.isError ? `Error: ${orphan.text || 'tool failed'}` : orphan.text || '(no output)',
          };
        } else {
          input = [{ type: 'text', text: 'Continue.', text_elements: [] }];
        }
      }

      const handle = deps.client.runTurn(session.threadId, {
        input,
        ...(toolOutput ? { toolOutput } : {}),
        model: resolution.codexModel,
        // Explicit, so the bridge behaves the same for everyone instead of
        // inheriting whatever `model_reasoning_effort` the user set in their
        // own ~/.codex/config.toml (an `xhigh` there makes every turn minutes long).
        ...(resolution.effort ? { effort: resolution.effort } : {}),
        signal: abort.signal,
      });
      events = handle.events;
      interrupt = handle.interrupt;
      turnId = await handle.turnId;
      deps.sessions.markConsumed(session.key, fingerprints);
      log.debug('started turn', {
        key: redactKey(session.key),
        turnId,
        model: resolution.codexModel,
        rebuilt: ensured.created,
        reason: ensured.rebuildReason,
        replayed: history.length,
      });
    }

    /* ------------------------------ streaming ------------------------------ */
    const translator = new CodexEventTranslator({
      model: resolution.reportedModel,
      exposeThinking,
      maxTokens: body.max_tokens,
      toolNameMap: session.toolNameMap ?? nameMap,
    });

    const sse = wantsStream ? new SseWriter(res, { requestId }) : null;
    sse?.writeAll(translator.start());

    const graceMs = deps.toolCallGraceMs ?? DEFAULT_TOOL_GRACE_MS;
    const outcome = await pump({
      events,
      translator,
      graceMs,
      signal: abort.signal,
      emit: (evts) => sse?.writeAll(evts),
    });

    // Whatever happened, tool calls Codex already issued must be recorded, or
    // their promises are stranded and the Codex turn blocks forever.
    const parkEmitted = (): void => {
      if (!translator.emittedToolCalls.length || !session) return;
      const mapping: Record<string, string> = {};
      for (const call of translator.emittedToolCalls) mapping[call.anthropicId] = call.codexCallId;
      deps.sessions.park(session.key, turnId, mapping);
    };

    if (outcome === 'aborted') {
      deps.client.detachTurn(turnId);
      if (clientGone) {
        // The client is gone; nothing will ever answer these tool calls.
        await interrupt();
        sse?.end();
        return;
      }
      // Timed out rather than disconnected. Park anything already emitted so a
      // retry can still answer it, then close the message cleanly.
      parkEmitted();
      sse?.writeAll(translator.finish(translator.emittedToolCalls.length ? 'tool_use' : 'max_tokens'));
    }

    if (outcome === 'tool_use') {
      deps.client.detachTurn(turnId);
      parkEmitted();
      sse?.writeAll(translator.finishForToolUse());
    }

    const result = translator.result();
    deps.onTurn?.({
      sessionKey: session.key,
      model: resolution.codexModel,
      toolCalls: result.toolCalls.length,
    });

    if (result.failure) {
      const err = result.failure.rateLimited
        ? ERRORS.usageLimit(result.failure.retryAfterSeconds, result.failure.message)
        : new BridgeError('codex_protocol_error', result.failure.message);
      // Surface the failure even when partial output was already streamed.
      // Closing cleanly after half a sentence makes Claude Code treat a
      // truncated answer as a finished turn and never retry.
      if (sse) {
        sse.error(err.anthropicType, err.userMessage);
        sse.end();
      } else if (!result.message.content.length) {
        sendAnthropicError(res, err, requestId);
      } else {
        sendJson(res, 200, { ...result.message, stop_reason: 'refusal' }, { 'request-id': requestId });
      }
      return;
    }

    if (sse) {
      sse.end();
    } else {
      sendJson(res, 200, result.message, { 'request-id': requestId });
    }
  } catch (err) {
    const bridgeErr = toBridgeError(err);
    if (clientGone) {
      log.debug('client disconnected mid-request', { code: bridgeErr.code });
      if (!res.writableEnded) res.end();
      return;
    }
    if (res.headersSent) {
      // Already streaming: the only valid way to report is an SSE error event.
      const sse = new SseWriterAdapter(res);
      sse.error(bridgeErr.anthropicType, bridgeErr.userMessage);
      sse.end();
      return;
    }
    throw bridgeErr;
  } finally {
    clearTimeout(timeout);
    req.off('aborted', onClose);
    req.off('close', onClose);
  }
}

/* ------------------------------- the pump -------------------------------- */

type PumpOutcome = 'completed' | 'tool_use' | 'aborted';

/**
 * Drive the Codex event stream into Anthropic events.
 *
 * The only subtle part is the tool-call grace window. When Codex parks on a
 * tool call no further events arrive until we answer it, so the iterator would
 * hang forever. After the first tool call we therefore race the next event
 * against a short timer and close the message when the timer wins — which also
 * gives parallel tool calls a chance to land in the same assistant message.
 */
async function pump(opts: {
  events: AsyncIterable<CodexEvent>;
  translator: CodexEventTranslator;
  graceMs: number;
  signal: AbortSignal;
  emit(events: AnthropicStreamEvent[]): void;
}): Promise<PumpOutcome> {
  const it = opts.events[Symbol.asyncIterator]();
  let sawToolCall = false;
  let pendingNext: Promise<IteratorResult<CodexEvent>> | null = null;

  for (;;) {
    if (opts.signal.aborted) return 'aborted';
    if (!pendingNext) pendingNext = it.next();

    let settled: IteratorResult<CodexEvent> | 'grace' | 'abort';
    if (sawToolCall) {
      settled = await Promise.race<IteratorResult<CodexEvent> | 'grace' | 'abort'>([
        pendingNext,
        delay(opts.graceMs).then(() => 'grace' as const),
        abortPromise(opts.signal),
      ]);
    } else {
      settled = await Promise.race<IteratorResult<CodexEvent> | 'abort'>([pendingNext, abortPromise(opts.signal)]);
    }

    if (settled === 'grace') return 'tool_use';
    if (settled === 'abort') return 'aborted';

    pendingNext = null;
    if (settled.done) return sawToolCall ? 'tool_use' : 'completed';

    const event = settled.value;
    if (event.type === 'tool_call') sawToolCall = true;
    opts.emit(opts.translator.handle(event));
    if (opts.translator.isFinished) return 'completed';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function abortPromise(signal: AbortSignal): Promise<'abort'> {
  if (signal.aborted) return Promise.resolve('abort');
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('abort'), { once: true }));
}

/* ------------------------------- one-shots -------------------------------- */

/**
 * Claude Code's tool-less utility calls (conversation titles, topic detection).
 * They run in a throwaway Codex thread so the coding conversation's context is
 * never polluted by them.
 */
async function runOneShot(
  res: ServerResponse,
  body: MessagesRequest,
  deps: MessagesRouteDeps & {
    requestId: string;
    codexModel: string;
    reportedModel: string;
    effort: string | null;
    baseInstructions: string;
    cwd: string;
    wantsStream: boolean;
    exposeThinking: boolean;
    signal: AbortSignal;
  },
): Promise<void> {
  const thread = await deps.client.createThread({
    cwd: deps.cwd,
    model: deps.codexModel,
    baseInstructions: deps.baseInstructions,
    ephemeral: true,
  });

  const history = body.messages.slice(0, -1);
  const trailing = body.messages[body.messages.length - 1];
  if (history.length) {
    const items = messagesToResponseItems(history);
    if (items.length) {
      try {
        await deps.client.injectItems(thread.id, items);
      } catch {
        /* a utility call is not worth failing over */
      }
    }
  }

  const input = trailing ? messageToUserInput(trailing) : [];
  const handle = deps.client.runTurn(thread.id, {
    input: input.length ? input : [{ type: 'text', text: 'Continue.', text_elements: [] }],
    model: deps.codexModel,
    ...(deps.effort ? { effort: deps.effort } : {}),
    signal: deps.signal,
  });

  const translator = new CodexEventTranslator({
    model: deps.reportedModel,
    exposeThinking: deps.exposeThinking,
  });
  const sse = deps.wantsStream ? new SseWriter(res, { requestId: deps.requestId }) : null;
  sse?.writeAll(translator.start());

  const outcome = await pump({
    events: handle.events,
    translator,
    graceMs: deps.toolCallGraceMs ?? DEFAULT_TOOL_GRACE_MS,
    signal: deps.signal,
    emit: (evts) => sse?.writeAll(evts),
  });
  if (outcome !== 'completed') sse?.writeAll(translator.finish('end_turn'));

  if (sse) sse.end();
  else sendJson(res, 200, translator.result().message, { 'request-id': deps.requestId });
}

/* ------------------------ reserved-name recovery ------------------------- */

/** Codex tells us which name it refused; this pulls it out of the message. */
const RESERVED_NAME_RE = /dynamic tool name is reserved:\s*([^\s,;]+)/i;

/**
 * Create the thread, escaping any tool name Codex rejects as reserved.
 *
 * The reserved list lives in the Codex binary and changes between releases, so
 * a static list would eventually be wrong in a way that breaks every session
 * for a user with the wrong MCP server attached. This learns the name from the
 * rejection and retries, bounded.
 */
async function ensureWithReservedNameRecovery(
  deps: MessagesRouteDeps,
  input: Parameters<SessionManager['ensure']>[0],
  body: MessagesRequest,
  log: Logger,
): Promise<Awaited<ReturnType<SessionManager['ensure']>>> {
  const extraReserved = new Set<string>();
  let attempt = { ...input };

  for (let i = 0; i < 4; i += 1) {
    try {
      return await deps.sessions.ensure(attempt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refused = RESERVED_NAME_RE.exec(message)?.[1];
      if (!refused) throw err;
      // Map the Codex name Codex refused back to what Claude Code called it.
      const anthropicName = attempt.toolNameMap[refused] ?? refused;
      if (extraReserved.has(anthropicName)) throw err;
      extraReserved.add(anthropicName);
      log.info('Codex refused a tool name as reserved; escaping it', { name: refused });
      const retried = anthropicToolsToCodex(body.tools, extraReserved);
      attempt = { ...attempt, tools: retried.tools, toolNameMap: retried.nameMap };
    }
  }
  return deps.sessions.ensure(attempt);
}

/* --------------------------- credential probe ---------------------------- */

/**
 * Recognise Claude Code's credential/model validation probe.
 *
 * Deliberately narrow: one short user message, a max_tokens of 1, and no tools.
 * A real conversation never looks like this.
 */
export function isCredentialProbe(body: MessagesRequest): boolean {
  if (body.max_tokens > 1) return false;
  if (body.tools && body.tools.length) return false;
  if (body.messages.length !== 1) return false;
  const only = body.messages[0];
  if (!only || only.role !== 'user') return false;
  const text =
    typeof only.content === 'string'
      ? only.content
      : only.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
  return text.length <= 32;
}

function respondToProbe(res: ServerResponse, model: string, stream: boolean, requestId: string): void {
  const id = `msg_${randomUUID().replace(/-/g, '')}`;
  const message = {
    id,
    type: 'message' as const,
    role: 'assistant' as const,
    model,
    content: [{ type: 'text' as const, text: 'OK' }],
    stop_reason: 'max_tokens' as const,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!stream) {
    sendJson(res, 200, message, { 'request-id': requestId });
    return;
  }
  const sse = new SseWriter(res, { requestId, pingIntervalMs: 0 });
  sse.writeAll([
    { type: 'message_start', message: { ...message, content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
  sse.end();
}

/* -------------------------------- helpers -------------------------------- */

function toDynamicToolResponse(result: ToolResult): DynamicToolCallResponse {
  const contentItems: DynamicToolCallResponse['contentItems'] = [];
  if (result.text) contentItems.push({ type: 'inputText', text: result.text });
  for (const img of result.images) contentItems.push({ type: 'inputImage', imageUrl: img.url });
  if (!contentItems.length) {
    contentItems.push({ type: 'inputText', text: result.isError ? 'Error (no output)' : '(no output)' });
  }
  return { contentItems, success: !result.isError };
}

/** Minimal writer for the case where headers were already sent by SseWriter. */
class SseWriterAdapter {
  constructor(private readonly res: ServerResponse) {}
  error(type: string, message: string): void {
    if (this.res.writableEnded) return;
    this.res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`);
  }
  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }
}

export { codexCallIdToAnthropicId };
