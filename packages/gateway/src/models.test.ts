import assert from 'node:assert/strict';
import test from 'node:test';


/* -------------------------- advertising a shortlist ------------------------ */

test('a Claude shortlist keeps the newest of each named family, in order', async () => {
  const { shortlistClaudeModels } = await import('./models.js');
  // Deliberately shuffled, and with created_at disagreeing with list order:
  // Anthropic does not promise an order, so only the dates may decide.
  const rows = [
    { id: 'claude-opus-4-8', created_at: '2026-02-01T00:00:00Z' },
    { id: 'claude-sonnet-5', created_at: '2026-06-01T00:00:00Z' },
    { id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z' },
    { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' },
    { id: 'claude-fable-5', created_at: '2026-03-01T00:00:00Z' },
    { id: 'claude-fable-5-1', created_at: '2026-07-01T00:00:00Z' },
    { id: 'claude-opus-4-5-20251101', created_at: '2025-11-01T00:00:00Z' },
  ];
  const out = shortlistClaudeModels(rows, ['opus', 'fable', 'sonnet']);
  assert.deepEqual(
    out.map((r) => r['id']),
    ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5'],
  );
  // Haiku was not asked for, so it is gone even though it is the newest Haiku.
  assert.ok(!out.some((r) => String(r['id']).includes('haiku')));
});

test('a Claude shortlist naming an absent family simply omits it', async () => {
  const { shortlistClaudeModels } = await import('./models.js');
  const rows = [{ id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z' }];
  assert.deepEqual(
    shortlistClaudeModels(rows, ['opus', 'mythos']).map((r) => r['id']),
    ['claude-opus-5'],
  );
});

test('no Claude shortlist means every model is advertised', async () => {
  const { shortlistClaudeModels } = await import('./models.js');
  const rows = [{ id: 'claude-opus-5' }, { id: 'claude-opus-4-8' }];
  assert.equal(shortlistClaudeModels(rows, null).length, 2);
  assert.equal(shortlistClaudeModels(rows, []).length, 2);
});

test('an unclassifiable id is dropped by a shortlist rather than guessed at', async () => {
  const { shortlistClaudeModels } = await import('./models.js');
  const rows = [
    { id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z' },
    { id: 'claude-experimental-thing', created_at: '2026-09-01T00:00:00Z' },
  ];
  assert.deepEqual(
    shortlistClaudeModels(rows, ['opus']).map((r) => r['id']),
    ['claude-opus-5'],
  );
});

test('descriptions are blanked, not omitted, when they are turned off', async () => {
  const { stripDescriptions } = await import('./models.js');
  const out = stripDescriptions([{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5', description: 'x' }]);
  // `??` only falls through on null/undefined, so an empty string is what
  // suppresses the app's canned tier blurb. Dropping the field re-enables it.
  for (const row of out) {
    assert.ok('description' in row, 'the field must be present');
    assert.equal(row['description'], '');
  }
});

test('blanking descriptions also hides the family word inside the id', async () => {
  const { stripDescriptions, hideTierWord, restoreTierWord } = await import('./models.js');
  // Blanking the field alone is not enough — the desktop falls back to the
  // family word in the id, so `claude-opus-5` would still say "Most capable
  // for ambitious work".
  const out = stripDescriptions([{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }]);
  assert.equal(out[0]?.['id'], 'claude-cbxo-5');
  assert.doesNotMatch(String(out[0]?.['id']), /opus|sonnet|haiku|fable|mythos/);
  // The visible name comes from display_name, so it is untouched.
  assert.equal(out[0]?.['display_name'], 'Claude Opus 5');

  // Still claims to be Claude, or both clients drop the row entirely.
  assert.match(String(out[0]?.['id']), /claude|anthropic/);

  // And it has to survive the round trip, because Anthropic has never heard
  // of the neutral name.
  for (const id of [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5-1',
    'claude-opus-4-5-20251101',
  ]) {
    assert.equal(restoreTierWord(hideTierWord(id)), id, `${id} must round-trip`);
  }
});

test('an id with no family word is left exactly as it is', async () => {
  const { hideTierWord, restoreTierWord } = await import('./models.js');
  for (const id of ['claude-bridge-6-astra', 'claude-2-1', '']) {
    assert.equal(hideTierWord(id), id);
    assert.equal(restoreTierWord(id), id);
  }
});

test('the 1M-variant hints are stripped, so a row is not doubled in the picker', async () => {
  const { stripDescriptions } = await import('./models.js');
  // Anthropic's own /v1/models rows carry max_input_tokens; the desktop reads
  // it as "offer a 1M variant" and adds a second entry per model.
  const out = stripDescriptions([
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000, supports_1m: true },
  ]);
  assert.ok(!('max_input_tokens' in (out[0] as object)));
  assert.ok(!('supports_1m' in (out[0] as object)));
  assert.equal(out[0]?.['display_name'], 'Claude Opus 5', 'everything else survives');
});

test("the desktop's own probe rule lands on a Codex model when Codex leads", async () => {
  // Reproduced from Claude Code Desktop: scan ids for haiku, then sonnet, then
  // opus, take the SHORTEST match; if no id contains any of them, take the
  // first row. Neutral ids match none, so order alone decides — which is why
  // `models.codexFirst` exists.
  const probe = (ids: string[]): string | undefined => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      const hits = ids.filter((i) => i.toLowerCase().includes(tier));
      if (hits.length) return hits.reduce((a, b) => (a.length <= b.length ? a : b));
    }
    return ids[0];
  };

  const codex = ['claude-bridge-6-astra', 'claude-bridge-5-5'];
  const claude = ['claude-cbxo-5', 'claude-cbxs-5', 'claude-cbxh-4-5-20251001'];

  // Codex first: the health check tests the gateway's own backend.
  assert.equal(probe([...codex, ...claude]), 'claude-bridge-6-astra');
  // Claude first: it tests a passthrough to Anthropic, whose quota we cannot
  // fix — a 429 there renders as "the gateway returned an error".
  assert.equal(probe([...claude, ...codex]), 'claude-cbxo-5');

  // And a tier word anywhere in any id overrides order entirely, which is the
  // trap: it is why the ids must stay neutral for `codexFirst` to mean anything.
  assert.equal(probe(['claude-bridge-6-astra', 'claude-sonnet-5']), 'claude-sonnet-5');
});
