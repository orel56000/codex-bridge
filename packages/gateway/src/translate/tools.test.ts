import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicIdToCodexCallId,
  anthropicToolResultToCodex,
  anthropicToolToCodex,
  anthropicToolsToCodex,
  codexCallIdToAnthropicId,
  codexToolCallToAnthropic,
  decodeToolName,
  encodeToolName,
  normalizeSchema,
} from './tools.js';

test('a Claude Code tool becomes a Codex dynamic tool with its schema intact', () => {
  const result = anthropicToolToCodex({
    name: 'Edit',
    description: 'Replace an exact string in a file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' } },
      required: ['file_path', 'old_string'],
      additionalProperties: false,
    },
  });
  assert.ok(!('error' in result));
  assert.equal(result.type, 'function');
  assert.equal(result.name, 'Edit');
  assert.equal(result.description, 'Replace an exact string in a file.');
  assert.deepEqual(result.inputSchema, {
    type: 'object',
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' } },
    required: ['file_path', 'old_string'],
    additionalProperties: false,
  });
});

test('a tool with no description still gets one, because Codex requires it', () => {
  const result = anthropicToolToCodex({ name: 'Glob', input_schema: { type: 'object', properties: {} } });
  assert.ok(!('error' in result));
  assert.equal(result.description, 'The Glob tool.');
});

test('server-side tools are reported as skipped rather than silently dropped', () => {
  const { tools, skipped } = anthropicToolsToCodex([
    { type: 'web_search_20250305', name: 'web_search' } as never,
    { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'Read');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]?.reason ?? '', /server-side/);
});

test('invalid and duplicate tool names are rejected with a reason', () => {
  const { tools, skipped } = anthropicToolsToCodex([
    { name: 'bad name!', input_schema: { type: 'object' } },
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Read', input_schema: { type: 'object' } },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]?.reason ?? '', /not a valid identifier/);
  assert.match(skipped[1]?.reason ?? '', /duplicate/);
});

test('normalizeSchema always yields an object schema Codex can accept', () => {
  assert.deepEqual(normalizeSchema(undefined), { type: 'object', properties: {}, additionalProperties: false });
  const wrapped = normalizeSchema({ type: 'string' });
  assert.equal(wrapped.type, 'object');
  assert.deepEqual(wrapped.required, ['value']);
  const passthrough = normalizeSchema({ type: 'object' });
  assert.deepEqual(passthrough.properties, {});
});

test('tool call ids round-trip between Codex and Anthropic', () => {
  const codexCallId = 'exec-8a27d451-1557-4253-bafc-5814af7b13a1';
  const anthropicId = codexCallIdToAnthropicId(codexCallId);
  assert.match(anthropicId, /^toolu_[A-Za-z0-9_]+$/);
  assert.equal(anthropicIdToCodexCallId(anthropicId, [codexCallId, 'exec-other']), codexCallId);
  assert.equal(anthropicIdToCodexCallId('toolu_missing', [codexCallId]), null);
});

test('mapping is deterministic, so a restart cannot orphan an in-flight call', () => {
  const id = 'exec-abc-123';
  assert.equal(codexCallIdToAnthropicId(id), codexCallIdToAnthropicId(id));
});

test('a Codex tool call becomes an Anthropic tool_use', () => {
  const call = codexToolCallToAnthropic({
    callId: 'exec-1',
    name: 'Bash',
    input: { command: 'ls -la' },
  });
  assert.equal(call.name, 'Bash');
  assert.deepEqual(call.input, { command: 'ls -la' });
  assert.equal(call.codexCallId, 'exec-1');
  assert.equal(call.anthropicId, 'toolu_exec_1');
});

test('a Codex tool call with null arguments still produces a valid object', () => {
  const call = codexToolCallToAnthropic({ callId: 'exec-2', name: 'X', input: null });
  assert.deepEqual(call.input, {});
});

test('a string tool_result flattens to text', () => {
  const r = anthropicToolResultToCodex({ tool_use_id: 'toolu_1', content: 'file contents here' });
  assert.equal(r.text, 'file contents here');
  assert.equal(r.isError, false);
  assert.deepEqual(r.images, []);
});

test('a block tool_result keeps text and extracts images', () => {
  const r = anthropicToolResultToCodex({
    tool_use_id: 'toolu_2',
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: 'second' },
    ],
  });
  assert.equal(r.text, 'first\n[image]\n[image]\nsecond');
  assert.deepEqual(r.images, [{ url: 'data:image/png;base64,AAAA' }, { url: 'https://example.com/a.png' }]);
});

test('an error tool_result is marked as failed', () => {
  const r = anthropicToolResultToCodex({ tool_use_id: 't', content: 'boom', is_error: true });
  assert.equal(r.isError, true);
});

test('a tool_result with no content does not throw', () => {
  const r = anthropicToolResultToCodex({ tool_use_id: 't' });
  assert.equal(r.text, '');
  assert.equal(r.isError, false);
});

/* --------------------------- tool name encoding --------------------------- */

test('Codex-reserved tool names are escaped, reversibly', () => {
  // This is not hypothetical: every Claude Code MCP tool is named mcp__*, and
  // Codex refuses that prefix outright ("dynamic tool name is reserved").
  const mcp = 'mcp__blender__bpy_api_lookup';
  const encoded = encodeToolName(mcp);
  assert.notEqual(encoded, mcp);
  assert.ok(!encoded.startsWith('mcp__'));
  assert.equal(decodeToolName(encoded), mcp);
});

test("Codex's own built-in tool names are escaped too", () => {
  for (const name of ['shell', 'apply_patch', 'exec_command', 'view_image', 'update_plan']) {
    const encoded = encodeToolName(name);
    assert.notEqual(encoded, name, `${name} must not shadow a Codex built-in`);
    assert.equal(decodeToolName(encoded), name);
  }
});

test('ordinary tool names pass through untouched', () => {
  for (const name of ['Read', 'Edit', 'Bash', 'TodoWrite', 'WebFetch']) {
    assert.equal(encodeToolName(name), name);
    assert.equal(decodeToolName(name), name);
  }
});

test('escaping is a bijection even for a name that looks pre-escaped', () => {
  const tricky = 'cbx_mcp__thing';
  const encoded = encodeToolName(tricky);
  assert.notEqual(encoded, tricky);
  assert.equal(decodeToolName(encoded), tricky);
});

test('over-long names are truncated without colliding', () => {
  const base = 'a'.repeat(200);
  const a = encodeToolName(`${base}one`);
  const b = encodeToolName(`${base}two`);
  assert.ok(a.length <= 64);
  assert.ok(b.length <= 64);
  assert.notEqual(a, b, 'two different long names must not collapse to one');
});

test('a name Codex rejected at runtime is escaped on the retry', () => {
  const first = anthropicToolsToCodex([{ name: 'Weird', input_schema: { type: 'object' } }]);
  assert.equal(first.tools[0]?.name, 'Weird');

  const retried = anthropicToolsToCodex(
    [{ name: 'Weird', input_schema: { type: 'object' } }],
    new Set(['Weird']),
  );
  assert.notEqual(retried.tools[0]?.name, 'Weird');
  assert.equal(retried.nameMap[retried.tools[0]!.name], 'Weird');
});

test('the name map lets a Codex tool call be reported under its Anthropic name', () => {
  const { tools, nameMap } = anthropicToolsToCodex([
    { name: 'mcp__srv__do_thing', description: 'd', input_schema: { type: 'object' } },
  ]);
  const codexName = tools[0]!.name;
  const call = codexToolCallToAnthropic({ callId: 'exec-1', name: codexName, input: {} }, nameMap);
  assert.equal(call.name, 'mcp__srv__do_thing');
});

test('tool names are trimmed before validation', () => {
  const result = anthropicToolToCodex({ name: '  Read  ', input_schema: { type: 'object' } });
  assert.ok(!('error' in result));
  assert.equal(result.name, 'Read');
});

/* --------------------------- provider routing ----------------------------- */

test('routing sends Claude models upstream and keeps Codex models local', async () => {
  const { isAnthropicModel } = await import('../passthrough.js');
  const { isBridgeModelId } = await import('../models.js');

  // Ours — must never be billed to an Anthropic credential. Note the tier
  // slots share no prefix with the pinned-model ids, which is why routing asks
  // a predicate rather than testing one string prefix.
  for (const m of [
    'claude-sonnet-bridge',
    'claude-opus-bridge',
    'claude-haiku-bridge',
    'claude-bridge-5-6-sol',
    'codex',
    'codex-default',
    'claude-sonnet-bridge[1m]',
    'claude-bridge-5-5[1m]',
    'claude-opus-bridge[1m]',
  ]) {
    assert.equal(isAnthropicModel(m, isBridgeModelId), false, `${m} must stay on Codex`);
  }

  // Anthropic's — must go upstream so the picker can really offer them.
  for (const m of [
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'opus',
    'sonnet',
    'fable',
    'claude-fable-5-1[1m]',
  ]) {
    assert.equal(isAnthropicModel(m, isBridgeModelId), true, `${m} must go to Anthropic`);
  }

  // Unknown names stay local: misrouting must never silently spend money.
  for (const m of [undefined, '', 'gpt-4', 'some-random-model']) {
    assert.equal(isAnthropicModel(m, isBridgeModelId), false, `${String(m)} must not be sent upstream`);
  }
});

test('Codex only claims the tier defaults when it is the only provider', async () => {
  const { ModelMapper } = await import('../models.js');
  const { nullLogger } = await import('@codex-bridge/shared');
  const mapper = new ModelMapper(
    { listModels: async () => [] } as never,
    nullLogger(),
    { model: 'auto', aliases: {} },
  );

  const alone = mapper.listForApi({ claimTierDefaults: true });
  assert.ok(alone.some((r) => r.anthropic_family_tier === 'opus' && r.is_family_default));

  // With real Claude models present, picking "Opus" must not hand you Codex.
  const shared = mapper.listForApi({ claimTierDefaults: false });
  assert.ok(shared.length > 0);
  assert.ok(!shared.some((r) => r.is_family_default), 'Codex must yield the tier defaults');
});
