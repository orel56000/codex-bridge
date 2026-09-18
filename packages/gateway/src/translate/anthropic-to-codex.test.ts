import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessagesRequest } from '@codex-bridge/shared';
import {
  TOOL_DISCIPLINE_INSTRUCTIONS,
  buildBaseInstructions,
  collectToolResults,
  collectToolUses,
  extractSessionId,
  extractSystemPrompt,
  fallbackSessionKey,
  fingerprintMessage,
  fingerprintMessages,
  isInputRole,
  isUtilityRequest,
  messageToUserInput,
  messagesToResponseItems,
  stableStringify,
} from './anthropic-to-codex.js';

const base = (over: Partial<MessagesRequest> = {}): MessagesRequest => ({
  model: 'codex',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

test('a string system prompt and a block system prompt both flatten', () => {
  assert.equal(extractSystemPrompt('plain'), 'plain');
  assert.equal(
    extractSystemPrompt([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]),
    'first\n\nsecond',
  );
  assert.equal(extractSystemPrompt(undefined), '');
});

test('the tool-discipline rule is appended unless native tools are allowed', () => {
  const withRule = buildBaseInstructions('You are Claude Code.', false);
  assert.ok(withRule.startsWith('You are Claude Code.'));
  assert.ok(withRule.includes(TOOL_DISCIPLINE_INSTRUCTIONS));

  const without = buildBaseInstructions('You are Claude Code.', true);
  assert.equal(without, 'You are Claude Code.');

  // An empty system prompt still gets the rule — Codex must never think it can
  // reach the filesystem itself.
  assert.equal(buildBaseInstructions(undefined, false), TOOL_DISCIPLINE_INSTRUCTIONS);
});

test('a request without tools is treated as a utility call', () => {
  assert.equal(isUtilityRequest(base()), true);
  assert.equal(isUtilityRequest(base({ tools: [] })), true);
  assert.equal(isUtilityRequest(base({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] })), false);
});

test('the session id is read out of metadata.user_id', () => {
  const req = base({
    metadata: { user_id: JSON.stringify({ account_uuid: 'a', session_id: 'sess-123' }) },
  });
  assert.equal(extractSessionId(req), 'sess-123');
});

test('a non-JSON metadata.user_id is used verbatim', () => {
  assert.equal(extractSessionId(base({ metadata: { user_id: 'legacy-id' } })), 'legacy-id');
});

test('a missing metadata.user_id falls back to a content-derived key', () => {
  const req = base({ system: 'sys', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(extractSessionId(req), null);
  const key = fallbackSessionKey(req);
  assert.match(key, /^anon_[0-9a-f]{24}$/);
  // Stable for the same conversation, different for another.
  assert.equal(key, fallbackSessionKey(req));
  assert.notEqual(key, fallbackSessionKey(base({ system: 'other', messages: req.messages })));
});

test('fingerprints ignore cache_control, which Claude Code moves between turns', () => {
  const a = fingerprintMessage({ role: 'user', content: [{ type: 'text', text: 'same' }] });
  const b = fingerprintMessage({
    role: 'user',
    content: [{ type: 'text', text: 'same', cache_control: { type: 'ephemeral' } }],
  });
  assert.equal(a, b);
});

test('fingerprints distinguish role and content', () => {
  const user = fingerprintMessage({ role: 'user', content: 'x' });
  const assistant = fingerprintMessage({ role: 'assistant', content: 'x' });
  assert.notEqual(user, assistant);
  assert.notEqual(user, fingerprintMessage({ role: 'user', content: 'y' }));
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('fingerprintMessages preserves order', () => {
  const msgs = [
    { role: 'user' as const, content: 'one' },
    { role: 'assistant' as const, content: 'two' },
  ];
  const fps = fingerprintMessages(msgs);
  assert.equal(fps.length, 2);
  assert.equal(fps[0], fingerprintMessage(msgs[0]!));
});

test('a user message becomes Codex user input, text first', () => {
  const input = messageToUserInput({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: 'look at this' },
    ],
  });
  assert.equal(input.length, 2);
  assert.deepEqual(input[0], { type: 'text', text: 'look at this', text_elements: [] });
  assert.deepEqual(input[1], { type: 'image', url: 'https://example.com/a.png' });
});

test('base64 images become data URLs', () => {
  const input = messageToUserInput({
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
  });
  assert.deepEqual(input[0], { type: 'image', url: 'data:image/png;base64,AAAA' });
});

test('tool_result blocks are not turned into user text', () => {
  const input = messageToUserInput({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }],
  });
  assert.deepEqual(input, []);
});

test('collectToolResults only reads the user side', () => {
  const results = collectToolResults({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'b', is_error: true },
      { type: 'text', text: 'ignored' },
    ],
  });
  assert.deepEqual(
    results.map((r) => [r.toolUseId, r.text, r.isError]),
    [
      ['t1', 'a', false],
      ['t2', 'b', true],
    ],
  );
  assert.deepEqual(collectToolResults({ role: 'assistant', content: 'x' }), []);
  assert.deepEqual(collectToolResults(undefined), []);
});

test('collectToolUses only reads the assistant side', () => {
  const uses = collectToolUses({
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    ],
  });
  assert.equal(uses.length, 1);
  assert.equal(uses[0]?.id, 'toolu_1');
  assert.deepEqual(collectToolUses({ role: 'user', content: 'x' }), []);
});

test('history replays as structured Responses items, not one flattened string', () => {
  const items = messagesToResponseItems([
    { role: 'user', content: 'fix the bug' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.py' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'def add(): ...' }] },
  ]) as Array<Record<string, unknown>>;

  assert.deepEqual(items[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] });
  assert.equal(items[1]?.['type'], 'function_call');
  assert.equal(items[1]?.['call_id'], 'toolu_1');
  assert.equal(items[1]?.['name'], 'Read');
  assert.deepEqual(JSON.parse(String(items[1]?.['arguments'])), { file_path: '/a.py' });
  assert.equal(items[2]?.['type'], 'message');
  assert.equal(items[3]?.['type'], 'function_call_output');
  assert.equal(items[3]?.['call_id'], 'toolu_1');
});

test('thinking blocks are not replayed — their signatures are meaningless to Codex', () => {
  const items = messagesToResponseItems([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal', signature: 'sig' },
        { type: 'text', text: 'visible' },
      ],
    },
  ]) as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  const content = items[0]?.['content'] as Array<{ text: string }>;
  assert.equal(content[0]?.text, 'visible');
});

test('an empty assistant message produces no item', () => {
  assert.deepEqual(messagesToResponseItems([{ role: 'assistant', content: [] }]), []);
});

/* --------------------------- system-role messages -------------------------- */

test('a system message inside messages[] is treated as model input', () => {
  // Claude Code really sends these mid-conversation; rejecting them 400s every
  // real session.
  assert.equal(isInputRole('user'), true);
  assert.equal(isInputRole('system'), true);
  assert.equal(isInputRole('assistant'), false);
});

test('a system message is labelled so the model does not answer it as a question', () => {
  const input = messageToUserInput({ role: 'system', content: 'Reminder: be terse.' });
  assert.equal(input.length, 1);
  assert.ok(input[0]?.type === 'text');
  assert.match(input[0].text, /^\[system\]\n/);
  assert.match(input[0].text, /be terse/);
});

test('a system message replays as a developer item, not a user turn', () => {
  const items = messagesToResponseItems([
    { role: 'system', content: 'context' },
    { role: 'user', content: 'question' },
  ]) as Array<Record<string, unknown>>;
  assert.equal(items[0]?.['role'], 'developer');
  assert.equal(items[1]?.['role'], 'user');
});

test('tool results replay in the shape Codex accepts', () => {
  // FunctionCallOutputBody is `string | ContentItem[]` — an object with
  // {content, success} is rejected as "not a valid response item".
  const items = messagesToResponseItems([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the output' }] },
  ]) as Array<Record<string, unknown>>;
  const out = items[0]!;
  assert.equal(out['type'], 'function_call_output');
  assert.ok(Array.isArray(out['output']), 'output must be a string or an array of content items');
  const content = out['output'] as Array<Record<string, unknown>>;
  assert.equal(content[0]?.['type'], 'input_text');
  assert.equal(content[0]?.['text'], 'the output');
});

test('an error tool result replays with its error marked in the text', () => {
  const items = messagesToResponseItems([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] },
  ]) as Array<Record<string, unknown>>;
  const content = items[0]!['output'] as Array<Record<string, unknown>>;
  assert.match(String(content[0]?.['text']), /^Error: boom/);
});
