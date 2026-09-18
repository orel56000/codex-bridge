import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countRequestTokens, estimateTokens } from './count-tokens.js';

/**
 * The estimate must never UNDER-count: Claude Code uses it to decide when to
 * compact, and an under-count lets a conversation overflow the model's context.
 */

test('an empty request costs nothing', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(countRequestTokens({ model: 'codex', messages: [] }), 0);
});

test('the estimate grows with content and errs high', () => {
  const short = countRequestTokens({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });
  const long = countRequestTokens({
    model: 'codex',
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
  });
  assert.ok(short > 0);
  assert.ok(long > short * 10);
  // ~3.6 chars per token, plus overhead and a safety margin.
  assert.ok(long > 4000 / 4, 'must not under-count');
});

test('the system prompt is counted', () => {
  const withSystem = countRequestTokens({
    model: 'codex',
    system: 'a'.repeat(1000),
    messages: [{ role: 'user', content: 'hi' }],
  });
  const without = countRequestTokens({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(withSystem > without + 200);
});

test('tool definitions are counted', () => {
  const withTools = countRequestTokens({
    model: 'codex',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'Read',
        description: 'd'.repeat(500),
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
  });
  const without = countRequestTokens({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(withTools > without + 100);
});

test('every block type contributes, including tool traffic and images', () => {
  const n = countRequestTokens({
    model: 'codex',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } },
          { type: 'thinking', thinking: 'hmm' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'contents' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  });
  // The image alone is worth well over a thousand tokens.
  assert.ok(n > 1500, `expected an image-dominated count, got ${n}`);
});

test('the count is deterministic', () => {
  const req = { model: 'codex', messages: [{ role: 'user' as const, content: 'stable' }] };
  assert.equal(countRequestTokens(req), countRequestTokens(req));
});

/* ----------------------------- model aliases ------------------------------ */

test("Claude Code's context-window suffix is stripped from a model name", async () => {
  const { stripContextSuffix } = await import('../models.js');
  // With the 1M-context beta on, Claude Code asks for `sonnet[1m]` — and with
  // our aliases in place, `codex[1m]`, which it then logs as unrecognised.
  assert.equal(stripContextSuffix('codex[1m]'), 'codex');
  assert.equal(stripContextSuffix('claude-sonnet-bridge[1m]'), 'claude-sonnet-bridge');
  assert.equal(stripContextSuffix('codex'), 'codex');
  assert.equal(stripContextSuffix(''), '');
});
