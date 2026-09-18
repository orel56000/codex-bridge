import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnthropicStreamEvent } from '@codex-bridge/shared';
import type { CodexEvent } from '@codex-bridge/codex-client';
import { CodexEventTranslator, describeTurnError, isSyntheticSignature } from './codex-to-anthropic.js';

/**
 * These tests encode the parts of the Anthropic streaming contract that Claude
 * Code enforces silently — a violation shows up as an empty reply or a dead
 * stream, never as an error, so they are worth pinning down precisely.
 */

function drive(events: CodexEvent[], opts: { exposeThinking?: boolean } = {}): {
  out: AnthropicStreamEvent[];
  translator: CodexEventTranslator;
} {
  const translator = new CodexEventTranslator({
    model: 'codex',
    exposeThinking: opts.exposeThinking ?? false,
  });
  const out: AnthropicStreamEvent[] = [...translator.start()];
  for (const e of events) out.push(...translator.handle(e));
  return { out, translator };
}

function types(events: AnthropicStreamEvent[]): string[] {
  return events.map((e) => e.type);
}

/** Every content block that opens must close, exactly once, in order. */
function assertBlocksBalanced(events: AnthropicStreamEvent[]): void {
  const open = new Map<number, boolean>();
  for (const e of events) {
    if (e.type === 'content_block_start') {
      assert.ok(!open.get(e.index), `block ${e.index} opened twice`);
      open.set(e.index, true);
    } else if (e.type === 'content_block_delta') {
      assert.ok(open.get(e.index), `delta for unopened block ${e.index}`);
    } else if (e.type === 'content_block_stop') {
      assert.ok(open.get(e.index), `block ${e.index} closed without opening`);
      open.set(e.index, false);
    }
  }
  for (const [index, isOpen] of open) assert.ok(!isOpen, `block ${index} never closed`);
}

test('a plain text turn produces the canonical event sequence', () => {
  const { out } = drive([
    { type: 'turn_started', turnId: 't1' },
    { type: 'text_delta', itemId: 'm1', text: 'Hello' },
    { type: 'text_delta', itemId: 'm1', text: ' world' },
    { type: 'turn_completed', turn: { id: 't1', status: 'completed', error: null } },
  ]);

  assert.deepEqual(types(out), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assertBlocksBalanced(out);

  const start = out[0];
  assert.ok(start?.type === 'message_start');
  assert.equal(start.message.role, 'assistant');
  assert.equal(start.message.model, 'codex');
  assert.deepEqual(start.message.content, []);
  assert.match(start.message.id, /^msg_/);

  const delta = out.find((e) => e.type === 'message_delta');
  assert.ok(delta?.type === 'message_delta');
  assert.equal(delta.delta.stop_reason, 'end_turn');
  // Claude Code dereferences usage.output_tokens with no optional chaining.
  assert.equal(typeof delta.usage.output_tokens, 'number');
});

test('the SSE event name always matches the payload type', () => {
  const { out } = drive([
    { type: 'text_delta', itemId: 'm', text: 'x' },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  for (const e of out) assert.equal(typeof e.type, 'string');
});

test('a tool call closes the text block and emits a complete tool_use block', () => {
  const { out, translator } = drive([
    { type: 'text_delta', itemId: 'm1', text: 'Let me check.' },
    { type: 'tool_call', callId: 'exec-1', name: 'Read', namespace: null, input: { file_path: '/a.txt' } },
  ]);
  out.push(...translator.finishForToolUse());

  assert.deepEqual(types(out), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assertBlocksBalanced(out);

  const toolStart = out.filter((e) => e.type === 'content_block_start')[1];
  assert.ok(toolStart?.type === 'content_block_start');
  assert.ok(toolStart.content_block.type === 'tool_use');
  assert.equal(toolStart.content_block.name, 'Read');
  assert.deepEqual(toolStart.content_block.input, {});

  const jsonDelta = out.find(
    (e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta',
  );
  assert.ok(jsonDelta?.type === 'content_block_delta' && jsonDelta.delta.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(jsonDelta.delta.partial_json), { file_path: '/a.txt' });

  const md = out.find((e) => e.type === 'message_delta');
  assert.ok(md?.type === 'message_delta');
  assert.equal(md.delta.stop_reason, 'tool_use');
});

test('parallel tool calls become separate tool_use blocks in one message', () => {
  const { out, translator } = drive([
    { type: 'tool_call', callId: 'exec-1', name: 'Read', namespace: null, input: { file_path: '/a' } },
    { type: 'tool_call', callId: 'exec-2', name: 'Read', namespace: null, input: { file_path: '/b' } },
  ]);
  out.push(...translator.finishForToolUse());
  assertBlocksBalanced(out);
  assert.equal(out.filter((e) => e.type === 'content_block_start').length, 2);
  assert.equal(translator.emittedToolCalls.length, 2);
  assert.deepEqual(
    translator.emittedToolCalls.map((c) => c.codexCallId),
    ['exec-1', 'exec-2'],
  );
});

test('deltas never target a block of the wrong kind', () => {
  // Text after a tool call must open a NEW text block, not reuse the tool index.
  const { out } = drive([
    { type: 'tool_call', callId: 'exec-1', name: 'Read', namespace: null, input: {} },
    { type: 'text_delta', itemId: 'm1', text: 'done' },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  assertBlocksBalanced(out);

  const kindByIndex = new Map<number, string>();
  for (const e of out) {
    if (e.type === 'content_block_start') kindByIndex.set(e.index, e.content_block.type);
    if (e.type === 'content_block_delta') {
      const kind = kindByIndex.get(e.index);
      const expected =
        e.delta.type === 'text_delta'
          ? 'text'
          : e.delta.type === 'input_json_delta'
            ? 'tool_use'
            : 'thinking';
      assert.equal(kind, expected, `delta ${e.delta.type} sent to a ${kind} block`);
    }
  }
});

test('reasoning is dropped unless the client enabled thinking', () => {
  const { out } = drive([
    { type: 'reasoning_delta', itemId: 'r1', text: 'thinking hard' },
    { type: 'text_delta', itemId: 'm1', text: 'answer' },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  assert.equal(out.filter((e) => e.type === 'content_block_start').length, 1);
  const only = out.find((e) => e.type === 'content_block_start');
  assert.ok(only?.type === 'content_block_start');
  assert.equal(only.content_block.type, 'text');
});

test('a thinking block carries both required fields and a closing signature', () => {
  const { out } = drive(
    [
      { type: 'reasoning_delta', itemId: 'r1', text: 'step one' },
      { type: 'text_delta', itemId: 'm1', text: 'answer' },
      { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
    ],
    { exposeThinking: true },
  );
  assertBlocksBalanced(out);

  const start = out.find((e) => e.type === 'content_block_start');
  assert.ok(start?.type === 'content_block_start' && start.content_block.type === 'thinking');
  // Omitting either field makes Claude Code render a literal "undefined".
  assert.equal(start.content_block.thinking, '');
  assert.equal(start.content_block.signature, '');

  const sig = out.find((e) => e.type === 'content_block_delta' && e.delta.type === 'signature_delta');
  assert.ok(sig?.type === 'content_block_delta' && sig.delta.type === 'signature_delta');
  assert.ok(isSyntheticSignature(sig.delta.signature));
});

test('usage from Codex is carried into the Anthropic response', () => {
  const { out, translator } = drive([
    { type: 'text_delta', itemId: 'm', text: 'hi' },
    {
      type: 'usage',
      usage: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
    },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  const md = out.find((e) => e.type === 'message_delta');
  assert.ok(md?.type === 'message_delta');
  assert.equal(md.usage.output_tokens, 20);

  const { message } = translator.result();
  assert.equal(message.usage.input_tokens, 100);
  assert.equal(message.usage.cache_read_input_tokens, 40);
  assert.equal(message.usage.cache_creation_input_tokens, 10);
});

test('the non-streaming result matches what was streamed', () => {
  const { translator } = drive([
    { type: 'text_delta', itemId: 'm', text: 'Hello ' },
    { type: 'text_delta', itemId: 'm', text: 'world' },
    { type: 'tool_call', callId: 'exec-9', name: 'Bash', namespace: null, input: { command: 'ls' } },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  const { message } = translator.result();
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'toolu_exec_9', name: 'Bash', input: { command: 'ls' } },
  ]);
});

test('text_done does not duplicate text already streamed', () => {
  const { translator } = drive([
    { type: 'text_delta', itemId: 'm', text: 'Hello' },
    { type: 'text_done', itemId: 'm', text: 'Hello' },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  const text = translator.result().message.content.find((b) => b.type === 'text');
  assert.ok(text?.type === 'text');
  assert.equal(text.text, 'Hello');
});

test('text_done fills in text when no deltas arrived', () => {
  const { translator } = drive([
    { type: 'text_done', itemId: 'm', text: 'Only final' },
    { type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } },
  ]);
  const text = translator.result().message.content.find((b) => b.type === 'text');
  assert.ok(text?.type === 'text');
  assert.equal(text.text, 'Only final');
});

test('a retryable failure does not end the message', () => {
  const translator = new CodexEventTranslator({ model: 'codex', exposeThinking: false });
  translator.start();
  const events = translator.handle({
    type: 'turn_failed',
    error: { message: 'transient' },
    willRetry: true,
  });
  assert.deepEqual(events, []);
  assert.equal(translator.isFinished, false);
});

test('a terminal failure closes the stream exactly once', () => {
  const translator = new CodexEventTranslator({ model: 'codex', exposeThinking: false });
  const out = [...translator.start()];
  out.push(...translator.handle({ type: 'turn_failed', error: { message: 'dead' }, willRetry: false }));
  out.push(...translator.handle({ type: 'turn_completed', turn: { id: 't', status: 'failed', error: null } }));

  assert.equal(out.filter((e) => e.type === 'message_stop').length, 1);
  assert.equal(translator.result().failure?.message, 'dead');
});

test('start() is idempotent — a second message_start would kill the turn', () => {
  const translator = new CodexEventTranslator({ model: 'codex', exposeThinking: false });
  assert.equal(translator.start().length, 1);
  assert.deepEqual(translator.start(), []);
});

test('an interrupted turn still closes the message', () => {
  const { out } = drive([
    { type: 'text_delta', itemId: 'm', text: 'partial' },
    { type: 'interrupted' },
  ]);
  assertBlocksBalanced(out);
  assert.equal(types(out).at(-1), 'message_stop');
});

test('describeTurnError recognises rate limiting and a reset time', () => {
  const plain = describeTurnError({ message: 'Something went wrong' });
  assert.equal(plain.rateLimited, false);

  const limited = describeTurnError({ message: 'You have hit your usage limit' });
  assert.equal(limited.rateLimited, true);

  const withRetry = describeTurnError({ message: 'rate limit', retryAfter: 90 });
  assert.equal(withRetry.retryAfterSeconds, 90);

  const withReset = describeTurnError({
    message: 'rate limit',
    resetsAt: Math.floor(Date.now() / 1000) + 120,
  });
  assert.ok((withReset.retryAfterSeconds ?? 0) > 100);
});

test('events arriving after the message is closed are ignored', () => {
  const translator = new CodexEventTranslator({ model: 'codex', exposeThinking: false });
  translator.start();
  translator.handle({ type: 'turn_completed', turn: { id: 't', status: 'completed', error: null } });
  assert.deepEqual(translator.handle({ type: 'text_delta', itemId: 'm', text: 'late' }), []);
});
