import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redact, redactHeaders, redactString } from './redact.js';

/**
 * Secret redaction is the one thing that must not regress: the bridge sits next
 * to a live ChatGPT OAuth session, and a leaked token in a log file is a real
 * compromise. These tests use realistically-shaped fake secrets.
 */

const FAKE_JWT =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const FAKE_REFRESH = 'rt.1.AABFhaN0aGlzaXNhZmFrZXJlZnJlc2h0b2tlbnZhbHVlMTIzNDU2';
const FAKE_OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

test('redactString removes JWTs', () => {
  const out = redactString(`access_token is ${FAKE_JWT} ok`);
  assert.ok(!out.includes(FAKE_JWT));
  assert.ok(out.includes(REDACTED));
});

test('redactString removes OpenAI refresh tokens and API keys', () => {
  for (const secret of [FAKE_REFRESH, FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY]) {
    const out = redactString(`value=${secret}`);
    assert.ok(!out.includes(secret), `leaked ${secret.slice(0, 8)}…`);
  }
});

test('redact replaces values of sensitive keys wholesale', () => {
  const input = {
    tokens: { access_token: FAKE_JWT, refresh_token: FAKE_REFRESH, account_id: 'acct-123' },
    authorization: `Bearer ${FAKE_JWT}`,
    nested: { apiKey: FAKE_OPENAI_KEY, safe: 'visible' },
  };
  const out = redact(input) as Record<string, Record<string, unknown>>;

  assert.equal(out['tokens']?.['access_token'], REDACTED);
  assert.equal(out['tokens']?.['refresh_token'], REDACTED);
  // Even a benign-looking key inside a `tokens` container is redacted.
  assert.equal(out['tokens']?.['account_id'], REDACTED);
  assert.equal(out['authorization'], REDACTED);
  assert.equal(out['nested']?.['apiKey'], REDACTED);
  assert.equal(out['nested']?.['safe'], 'visible');

  const serialized = JSON.stringify(out);
  for (const secret of [FAKE_JWT, FAKE_REFRESH, FAKE_OPENAI_KEY]) {
    assert.ok(!serialized.includes(secret));
  }
});

test('redact survives cycles, deep nesting and huge strings', () => {
  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic['self'] = cyclic;
  assert.doesNotThrow(() => redact(cyclic));
  assert.equal((redact(cyclic) as Record<string, unknown>)['self'], '[Circular]');

  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  const out = JSON.stringify(redact(deep));
  assert.ok(out.includes('[Truncated]'));

  const big = redact({ text: 'x'.repeat(10_000) }) as Record<string, string>;
  assert.ok((big['text'] ?? '').length < 3_000);
});

test('redact caps long arrays instead of dumping them', () => {
  const out = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as Record<string, unknown[]>;
  const items = out['items'] as unknown[];
  assert.equal(items.length, 101);
  assert.equal(items[100], '[+400 more]');
});

test('redact preserves Error shape but scrubs the message', () => {
  const err = new Error(`failed with token ${FAKE_JWT}`);
  const out = redact({ err }) as Record<string, Record<string, string>>;
  assert.equal(out['err']?.['name'], 'Error');
  assert.ok(!out['err']?.['message']?.includes(FAKE_JWT));
});

test('redactHeaders keeps header names but hides credentials', () => {
  const out = redactHeaders({
    authorization: `Bearer ${FAKE_JWT}`,
    'x-api-key': FAKE_ANTHROPIC_KEY,
    cookie: 'session=abc',
    'content-type': 'application/json',
  });
  assert.equal(out['authorization'], REDACTED);
  assert.equal(out['x-api-key'], REDACTED);
  assert.equal(out['cookie'], REDACTED);
  assert.equal(out['content-type'], 'application/json');
});

/* ---------------------------- binary discovery ---------------------------- */

test('whichSync finds a bare name using PATHEXT semantics', async () => {
  const { whichSync } = await import('./platform.js');
  // On POSIX this proves the bare-name path; on Windows it proves PATHEXT is
  // consulted. Either way the point is that an npm-installed `codex` (a .cmd
  // shim on Windows) must be discoverable by its bare name.
  const found = whichSync(process.platform === 'win32' ? 'node' : 'node');
  assert.ok(found, 'node must be discoverable on PATH');
  assert.match(found, /node(\.exe|\.cmd)?$/i);
  assert.equal(whichSync('definitely-not-a-real-binary-xyz'), null);
});
