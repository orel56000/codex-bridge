import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nullLogger } from '@codex-bridge/shared';
import type { CodexAppServerClient, DynamicToolSpec } from '@codex-bridge/codex-client';
import { SessionManager, isPrefix, shapeHash } from './session.js';

/**
 * The session map is what keeps a Claude Code conversation on one Codex thread.
 * Its failure modes are subtle — a wrongly-reused thread silently feeds the
 * model a context the user never wrote — so the rebuild rules are pinned here.
 */

const TOOLS: DynamicToolSpec[] = [
  { type: 'function', name: 'Read', description: 'read', inputSchema: { type: 'object' } },
];

let created = 0;
let abandoned: Array<{ turnId: string; reason: string }> = [];

function fakeClient(): CodexAppServerClient {
  return {
    createThread: async () => {
      created += 1;
      return { id: `thread-${created}`, model: 'm', cwd: '/w', reasoningEffort: null };
    },
    abandonToolCalls: (turnId: string, reason: string) => {
      abandoned.push({ turnId, reason });
    },
  } as unknown as CodexAppServerClient;
}

function manager(opts: { idleTtlMs?: number; maxThreads?: number } = {}): SessionManager {
  created = 0;
  abandoned = [];
  const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-')), 'sessions.json');
  return new SessionManager({
    client: fakeClient(),
    logger: nullLogger(),
    idleTtlMs: opts.idleTtlMs ?? 60_000,
    maxThreads: opts.maxThreads ?? 8,
    persistPath,
  });
}

const input = (over: Partial<Parameters<SessionManager['ensure']>[0]> = {}) => ({
  key: 'sess-1',
  baseInstructions: 'system',
  tools: TOOLS,
  cwd: '/w',
  model: 'm',
  toolNameMap: { Read: 'Read' },
  fingerprints: ['a'],
  ...over,
});

test('the same conversation reuses one Codex thread', async () => {
  const m = manager();
  const first = await m.ensure(input());
  m.markConsumed('sess-1', ['a']);
  const second = await m.ensure(input({ fingerprints: ['a', 'b'] }));

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session.threadId, first.session.threadId);
  assert.equal(second.consumedCount, 1, 'should know Codex already saw the first message');
  assert.equal(created, 1);
});

test('a changed system prompt forces a new thread', async () => {
  const m = manager();
  await m.ensure(input());
  const next = await m.ensure(input({ baseInstructions: 'different' }));
  assert.equal(next.created, true);
  assert.match(next.rebuildReason ?? '', /system prompt or tool set/);
  assert.equal(created, 2);
});

test('a changed tool set forces a new thread', async () => {
  const m = manager();
  await m.ensure(input());
  const next = await m.ensure({
    ...input(),
    tools: [...TOOLS, { type: 'function', name: 'Write', description: 'w', inputSchema: { type: 'object' } }],
  });
  assert.equal(next.created, true);
  assert.match(next.rebuildReason ?? '', /tool set/);
});

test('a rewritten history forces a new thread', async () => {
  const m = manager();
  await m.ensure(input({ fingerprints: ['a', 'b', 'c'] }));
  m.markConsumed('sess-1', ['a', 'b', 'c']);

  // Compaction replaces the transcript: the stored prefix no longer matches.
  const next = await m.ensure(input({ fingerprints: ['z'] }));
  assert.equal(next.created, true);
  assert.match(next.rebuildReason ?? '', /rewritten/);
});

test('a changed working directory forces a new thread', async () => {
  const m = manager();
  await m.ensure(input());
  const next = await m.ensure(input({ cwd: '/elsewhere' }));
  assert.equal(next.created, true);
  assert.match(next.rebuildReason ?? '', /working directory/);
});

test('rebuilding a session frees the Codex turn it had parked', async () => {
  const m = manager();
  await m.ensure(input());
  m.park('sess-1', 'turn-1', { toolu_a: 'exec-a' });
  await m.ensure(input({ baseInstructions: 'changed' }));
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.turnId, 'turn-1');
});

test('a parked tool call identifies its session exactly', async () => {
  const m = manager();
  await m.ensure(input({ key: 'A' }));
  await m.ensure(input({ key: 'B' }));
  m.park('A', 'turn-A', { toolu_1: 'exec-1' });
  m.park('B', 'turn-B', { toolu_2: 'exec-2' });

  assert.equal(m.findByParkedToolUse('toolu_1')?.key, 'A');
  assert.equal(m.findByParkedToolUse('toolu_2')?.key, 'B');
  assert.equal(m.findByParkedToolUse('toolu_missing'), undefined);
});

test('unparking the last call clears the parked turn', async () => {
  const m = manager();
  await m.ensure(input());
  m.park('sess-1', 'turn-1', { toolu_1: 'exec-1', toolu_2: 'exec-2' });
  m.unpark('sess-1', ['toolu_1']);
  assert.equal(m.get('sess-1')?.parkedTurnId, 'turn-1');
  m.unpark('sess-1', ['toolu_2']);
  assert.equal(m.get('sess-1')?.parkedTurnId, null);
});

test('idle sessions are evicted', async () => {
  const m = manager({ idleTtlMs: 1 });
  await m.ensure(input({ key: 'old' }));
  await new Promise((r) => setTimeout(r, 15));
  await m.ensure(input({ key: 'new' }));
  assert.equal(m.get('old'), undefined);
  assert.ok(m.get('new'));
});

test('the thread cap evicts the least recently used session', async () => {
  const m = manager({ maxThreads: 2 });
  await m.ensure(input({ key: 'a' }));
  await m.ensure(input({ key: 'b' }));
  await m.ensure(input({ key: 'c' }));
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), undefined);
  assert.ok(m.get('c'));
});

test('persisted state carries thread ids but never a parked promise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-p-'));
  const persistPath = path.join(dir, 'sessions.json');
  created = 0;
  const m = new SessionManager({
    client: fakeClient(),
    logger: nullLogger(),
    idleTtlMs: 60_000,
    maxThreads: 8,
    persistPath,
  });
  const { session } = await m.ensure(input());
  m.park('sess-1', 'turn-1', { toolu_1: 'exec-1' });
  m.persist();

  const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8')) as {
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(raw.sessions.length, 1);
  assert.equal(raw.sessions[0]?.['threadId'], session.threadId);
  assert.ok(!('parked' in (raw.sessions[0] ?? {})), 'in-memory promises must not be serialised');
  assert.ok(!('parkedTurnId' in (raw.sessions[0] ?? {})));

  // Restoring keeps the thread mapping.
  const restored = new SessionManager({
    client: fakeClient(),
    logger: nullLogger(),
    idleTtlMs: 60_000,
    maxThreads: 8,
    persistPath,
  });
  assert.equal(restored.get('sess-1')?.threadId, session.threadId);
});

test('a corrupt session file is ignored rather than fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-c-'));
  const persistPath = path.join(dir, 'sessions.json');
  fs.writeFileSync(persistPath, 'not json at all');
  assert.doesNotThrow(() => {
    const m = new SessionManager({
      client: fakeClient(),
      logger: nullLogger(),
      idleTtlMs: 60_000,
      maxThreads: 8,
      persistPath,
    });
    assert.equal(m.size, 0);
  });
});

test('shapeHash is order-independent across tools but sensitive to content', () => {
  const a: DynamicToolSpec[] = [
    { type: 'function', name: 'A', description: 'a', inputSchema: {} },
    { type: 'function', name: 'B', description: 'b', inputSchema: {} },
  ];
  const reversed = [...a].reverse();
  assert.equal(shapeHash('sys', a), shapeHash('sys', reversed));
  assert.notEqual(shapeHash('sys', a), shapeHash('other', a));
  assert.notEqual(
    shapeHash('sys', a),
    shapeHash('sys', [{ type: 'function', name: 'A', description: 'changed', inputSchema: {} }, a[1]!]),
  );
});

test('isPrefix accepts growth and rejects divergence', () => {
  assert.equal(isPrefix([], ['a']), true);
  assert.equal(isPrefix(['a'], ['a', 'b']), true);
  assert.equal(isPrefix(['a', 'b'], ['a']), false);
  assert.equal(isPrefix(['a', 'x'], ['a', 'b']), false);
});
