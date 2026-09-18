import { randomUUID } from 'node:crypto';
import type {
  AnthropicStreamEvent,
  MessagesResponse,
  StopReason,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from '@codex-bridge/shared';
import type { CodexEvent, TokenUsage } from '@codex-bridge/codex-client';
import { codexToolCallToAnthropic, type ToolCall } from './tools.js';

/**
 * CodexEventTranslator
 *
 * Pure protocol translation: Codex turn events in, Anthropic stream events out.
 * It knows nothing about HTTP, sockets, or sessions, which is what makes the
 * whole mapping unit-testable without a Codex install or a listening port.
 *
 * Block model:
 *   Codex text deltas      -> one `text` content block
 *   Codex reasoning deltas -> one `thinking` block, only when the caller enabled thinking
 *   Codex tool calls       -> one `tool_use` block each
 *
 * A turn that issues tool calls does not end on the Codex side; it parks waiting
 * for results. The translator closes the Anthropic message with
 * `stop_reason: "tool_use"` so Claude Code can run the tools and come back.
 */

export interface TranslatorOptions {
  model: string;
  /** Emit `thinking` blocks for Codex reasoning. Only when the client asked for it. */
  exposeThinking: boolean;
  /** Anthropic message id. Generated when omitted. */
  messageId?: string;
  /** `max_tokens` from the request, echoed into `stop_reason` handling. */
  maxTokens?: number;
  /** Codex tool name -> the Anthropic name Claude Code declared. */
  toolNameMap?: Record<string, string>;
}

type BlockKind = 'text' | 'thinking' | 'tool_use';

interface OpenBlock {
  index: number;
  kind: BlockKind;
  /** Accumulated text, for the non-streaming response. */
  text: string;
  tool?: ToolCall;
}

export interface TranslatorResult {
  /** The message as it would be returned by a non-streaming request. */
  message: MessagesResponse;
  /** Tool calls emitted in this message, in order. */
  toolCalls: ToolCall[];
  /** Set when the turn failed rather than completing. */
  failure: { message: string; retryAfterSeconds?: number; rateLimited: boolean } | null;
}

export class CodexEventTranslator {
  private readonly opts: TranslatorOptions;
  private readonly messageId: string;
  private nextIndex = 0;
  private open: OpenBlock | null = null;
  private started = false;
  private finished = false;

  private readonly textParts: string[] = [];
  private readonly thinkingParts: string[] = [];
  private readonly toolCalls: ToolCall[] = [];
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private stopReason: StopReason = null;
  private failure: TranslatorResult['failure'] = null;

  constructor(opts: TranslatorOptions) {
    this.opts = opts;
    this.messageId = opts.messageId ?? `msg_${randomUUID().replace(/-/g, '')}`;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get emittedToolCalls(): ToolCall[] {
    return this.toolCalls;
  }

  /** The `message_start` event. Must be emitted exactly once, first. */
  start(): AnthropicStreamEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...this.usage },
        },
      },
    ];
  }

  /** Translate one Codex event into zero or more Anthropic stream events. */
  handle(event: CodexEvent): AnthropicStreamEvent[] {
    if (this.finished) return [];
    switch (event.type) {
      case 'text_delta':
        return this.appendText(event.text);

      case 'text_done':
        // Deltas already carried the text. Only synthesise when none arrived
        // (some Codex paths complete an item without streaming it).
        if (this.textParts.join('').length === 0 && event.text) return this.appendText(event.text);
        return [];

      case 'reasoning_delta':
        if (!this.opts.exposeThinking) return [];
        return this.appendThinking(event.text);

      case 'reasoning_done':
        if (!this.opts.exposeThinking) return [];
        if (this.thinkingParts.join('').length === 0 && event.text) return this.appendThinking(event.text);
        return [];

      case 'tool_call':
        return this.emitToolCall(event);

      case 'usage':
        this.usage = mergeUsage(this.usage, event.usage);
        return [];

      case 'turn_failed': {
        const detail = describeTurnError(event.error);
        this.failure = detail;
        if (event.willRetry) return [];
        // `null` is not a stop reason Claude Code can act on; a failed turn is
        // a refusal as far as the client is concerned.
        return this.finish('refusal', detail);
      }

      case 'turn_completed':
        return this.finish(this.toolCalls.length ? 'tool_use' : 'end_turn');

      case 'interrupted':
        return this.finish('end_turn');

      case 'native_activity':
      case 'tool_call_settled':
      case 'turn_started':
      case 'rate_limits':
        return [];

      default:
        return [];
    }
  }

  /**
   * Close the message because tool calls are pending. Codex stays parked; Claude
   * Code gets `stop_reason: "tool_use"` and will come back with the results.
   */
  finishForToolUse(): AnthropicStreamEvent[] {
    return this.finish('tool_use');
  }

  /** Close the message for any other reason (client disconnect, timeout). */
  finish(stopReason: StopReason, failure?: TranslatorResult['failure']): AnthropicStreamEvent[] {
    if (this.finished) return [];
    const events: AnthropicStreamEvent[] = [];
    events.push(...this.closeOpenBlock());
    this.finished = true;
    this.stopReason = stopReason;
    if (failure) this.failure = failure;

    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    });
    events.push({ type: 'message_stop' });
    return events;
  }

  /** The assembled non-streaming response. */
  result(): TranslatorResult {
    const content: Array<TextBlock | ToolUseBlock | ThinkingBlock> = [];
    const thinking = this.thinkingParts.join('');
    if (this.opts.exposeThinking && thinking) {
      content.push({ type: 'thinking', thinking, signature: syntheticSignature(this.messageId) });
    }
    const text = this.textParts.join('');
    if (text) content.push({ type: 'text', text });
    for (const call of this.toolCalls) {
      content.push({ type: 'tool_use', id: call.anthropicId, name: call.name, input: call.input });
    }
    return {
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.opts.model,
        content,
        stop_reason: this.stopReason,
        stop_sequence: null,
        usage: this.usage,
      },
      toolCalls: this.toolCalls,
      failure: this.failure,
    };
  }

  /* ------------------------------- internals ------------------------------ */

  private appendText(text: string): AnthropicStreamEvent[] {
    if (!text) return [];
    const events: AnthropicStreamEvent[] = [];
    if (this.open?.kind !== 'text') {
      events.push(...this.closeOpenBlock());
      const index = this.nextIndex++;
      this.open = { index, kind: 'text', text: '' };
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    }
    this.open.text += text;
    this.textParts.push(text);
    events.push({
      type: 'content_block_delta',
      index: this.open.index,
      delta: { type: 'text_delta', text },
    });
    return events;
  }

  private appendThinking(text: string): AnthropicStreamEvent[] {
    if (!text) return [];
    const events: AnthropicStreamEvent[] = [];
    if (this.open?.kind !== 'thinking') {
      events.push(...this.closeOpenBlock());
      const index = this.nextIndex++;
      this.open = { index, kind: 'thinking', text: '' };
      // Both fields are mandatory: Claude Code accumulates `thinking` with no
      // `|| ''` fallback, so omitting it yields a literal "undefined" prefix.
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
    }
    this.open.text += text;
    this.thinkingParts.push(text);
    events.push({
      type: 'content_block_delta',
      index: this.open.index,
      delta: { type: 'thinking_delta', thinking: text },
    });
    return events;
  }

  private emitToolCall(event: Extract<CodexEvent, { type: 'tool_call' }>): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    events.push(...this.closeOpenBlock());

    const call = codexToolCallToAnthropic(
      { callId: event.callId, name: event.name, input: event.input },
      this.opts.toolNameMap ?? {},
    );
    this.toolCalls.push(call);

    const index = this.nextIndex++;
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: call.anthropicId, name: call.name, input: {} },
    });
    // Codex hands us fully-formed arguments, so the whole JSON goes out as a
    // single `input_json_delta` rather than being re-chunked for show.
    const partial = JSON.stringify(call.input ?? {});
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partial },
    });
    events.push({ type: 'content_block_stop', index });
    this.open = null;
    return events;
  }

  private closeOpenBlock(): AnthropicStreamEvent[] {
    if (!this.open) return [];
    const events: AnthropicStreamEvent[] = [];
    if (this.open.kind === 'thinking') {
      events.push({
        type: 'content_block_delta',
        index: this.open.index,
        delta: { type: 'signature_delta', signature: syntheticSignature(this.messageId) },
      });
    }
    events.push({ type: 'content_block_stop', index: this.open.index });
    this.open = null;
    return events;
  }
}

/* -------------------------------- helpers -------------------------------- */

function mergeUsage(current: Usage, tokenUsage: TokenUsage): Usage {
  return {
    input_tokens: tokenUsage.inputTokens ?? current.input_tokens,
    output_tokens: tokenUsage.outputTokens ?? current.output_tokens,
    cache_read_input_tokens: tokenUsage.cachedInputTokens ?? current.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: tokenUsage.cacheWriteInputTokens ?? current.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Codex reasoning has no cryptographic signature of the kind Anthropic returns.
 * We emit a stable, clearly-synthetic marker so the stream is well-formed; the
 * gateway drops these blocks on the way back in, so nothing ever verifies them.
 */
export function syntheticSignature(messageId: string): string {
  return `codexbridge-unsigned-${messageId}`;
}

export function isSyntheticSignature(sig: string | undefined): boolean {
  return typeof sig === 'string' && sig.startsWith('codexbridge-unsigned-');
}

const RATE_LIMIT_HINTS = /rate.?limit|usage limit|quota|too many requests|429/i;

export function describeTurnError(error: unknown): NonNullable<TranslatorResult['failure']> {
  const obj = (error ?? {}) as Record<string, unknown>;
  const message =
    (typeof obj['message'] === 'string' && obj['message']) ||
    (typeof obj['type'] === 'string' && obj['type']) ||
    'Codex turn failed.';
  const rateLimited = RATE_LIMIT_HINTS.test(message) || obj['type'] === 'usageLimitReached';

  let retryAfterSeconds: number | undefined;
  for (const key of ['retryAfter', 'retry_after', 'retryAfterSeconds', 'resetsInSeconds']) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      retryAfterSeconds = v;
      break;
    }
  }
  const resetsAt = obj['resetsAt'];
  if (retryAfterSeconds === undefined && typeof resetsAt === 'number') {
    retryAfterSeconds = Math.max(0, resetsAt - Math.floor(Date.now() / 1000));
  }

  return {
    message,
    rateLimited,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
