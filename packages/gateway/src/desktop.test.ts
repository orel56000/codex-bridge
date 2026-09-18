import assert from 'node:assert/strict';
import test from 'node:test';
import { predictProbeModel, probeDesktop } from './desktop.js';

/* ------------------------- the desktop's probe rule ------------------------ */

test('the probe rule prefers haiku, then sonnet, then opus — by substring', () => {
  assert.equal(predictProbeModel(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']), 'claude-haiku-4-5');
  assert.equal(predictProbeModel(['claude-opus-5', 'claude-sonnet-5']), 'claude-sonnet-5');
  // Shortest, not newest and not first: 'claude-opus-5' is 13 characters,
  // 'claude-opus-4-8' is 15.
  assert.equal(predictProbeModel(['claude-opus-4-8', 'claude-opus-5']), 'claude-opus-5');
});

test('within a tier the SHORTEST id wins, which is not the first or the newest', () => {
  // The real trap: `claude-sonnet-5` (15 chars) beats `claude-sonnet-bridge-5-5`
  // (24), so a Codex row named with a tier word never gets probed while a
  // shorter Claude one exists.
  assert.equal(
    predictProbeModel(['claude-sonnet-bridge-5-5', 'claude-sonnet-bridge-6-astra', 'claude-sonnet-5']),
    'claude-sonnet-5',
  );
});

test('with no tier word anywhere, the FIRST row is probed — so order decides', () => {
  const codexFirst = ['claude-bridge-6-astra', 'claude-cbxo-5', 'claude-cbxs-5'];
  assert.equal(predictProbeModel(codexFirst), 'claude-bridge-6-astra');
  assert.equal(predictProbeModel([...codexFirst].reverse()), 'claude-cbxs-5');
});

test('an empty list probes nothing rather than throwing', () => {
  assert.equal(predictProbeModel([]), null);
});

/* --------------------- the installed app's own id filter ------------------- */

test('the desktop id filter is recovered from the installed app, not hardcoded', (t) => {
  const probe = probeDesktop();
  if (!probe.installed) {
    t.skip('Claude Desktop is not installed on this machine');
    return;
  }
  // Recovering this is the whole point: the rules are undocumented and change
  // between versions, so they are read from the build that is actually here.
  assert.equal(probe.filterSource, 'bundle', 'the id filter could not be read from the bundle');
  assert.ok(probe.idFilter);
  assert.ok(probe.version, 'the installed version should be readable');

  const accept = probe.idFilter as (id: string) => boolean;

  // What we advertise today must pass, or the picker silently empties.
  for (const id of [
    'claude-bridge-6-astra',
    'claude-bridge-5-6-sol',
    'claude-bridge-5-5',
    'claude-cbxo-5',
    'claude-cbxs-5',
    'claude-cbxh-4-5-20251001',
  ]) {
    assert.equal(accept(id), true, `${id} must be accepted`);
  }

  // And the names that caused the original outage must still be rejected —
  // if these ever start passing, the workaround is no longer needed.
  for (const id of ['claude-codex-sonnet', 'claude-codex-gpt-5.6-sol', 'gpt-5', 'deepseek-chat']) {
    assert.equal(accept(id), false, `${id} must be rejected`);
  }

  // A real Anthropic id passes, which is why passthrough works at all.
  assert.equal(accept('claude-opus-5'), true);
});
