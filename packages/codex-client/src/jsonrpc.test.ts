import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { nullLogger } from '@codex-bridge/shared';
import { JsonRpcConnection } from './jsonrpc.js';
import { AsyncQueue, deferred } from './queue.js';

let lastWritten: string[] = [];
function pairWritten(_conn: JsonRpcConnection): string {
  return lastWritten[0] ?? '{}';
}

function pair(
  handlers: {
    onNotification?(m: string, p: unknown): void;
    onServerRequest?(m: string, p: unknown): unknown;
  } = {},
  opts: { maxLineBytes?: number } = {},
): { conn: JsonRpcConnection; toClient: PassThrough; fromClient: PassThrough; written: string[] } {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const written: string[] = [];
  lastWritten = written;
  fromClient.on('data', (c: Buffer) => {
    for (const line of c.toString().split('\n')) if (line.trim()) written.push(line);
  });
  const conn = new JsonRpcConnection({
    input: toClient,
    output: fromClient,
    logger: nullLogger(),
    onNotification: handlers.onNotification ?? (() => undefined),
    onServerRequest: handlers.onServerRequest ?? (() => ({})),
    ...(opts.maxLineBytes !== undefined ? { maxLineBytes: opts.maxLineBytes } : {}),
  });
  return { conn, toClient, fromClient, written };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test('a request is answered by its matching response', async () => {
  const { conn, toClient, written } = pair();
  const p = conn.request<{ ok: boolean }>('thing/do', { x: 1 });
  await flush();

  const sent = JSON.parse(written[0]!) as { id: number; method: string; params: unknown };
  assert.equal(sent.method, 'thing/do');
  assert.deepEqual(sent.params, { x: 1 });

  toClient.write(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`);
  assert.deepEqual(await p, { ok: true });
});

test('a JSON-RPC error rejects with the server message', async () => {
  const { conn, toClient, written } = pair();
  const p = conn.request('thing/do');
  await flush();
  const sent = JSON.parse(written[0]!) as { id: number };
  toClient.write(`${JSON.stringify({ id: sent.id, error: { code: -1, message: 'nope' } })}\n`);
  await assert.rejects(p, /nope/);
});

test('messages split across chunks are reassembled', async () => {
  const { conn, toClient, written } = pair();
  const p = conn.request<{ v: number }>('x');
  await flush();
  const id = (JSON.parse(written[0]!) as { id: number }).id;
  const payload = JSON.stringify({ id, result: { v: 42 } });
  toClient.write(payload.slice(0, 10));
  await flush();
  toClient.write(`${payload.slice(10)}\n`);
  assert.deepEqual(await p, { v: 42 });
});

test('several messages in one chunk are all delivered', async () => {
  const seen: string[] = [];
  const { toClient } = pair({ onNotification: (m) => seen.push(m) });
  toClient.write(
    `${JSON.stringify({ method: 'a' })}\n${JSON.stringify({ method: 'b' })}\n${JSON.stringify({ method: 'c' })}\n`,
  );
  await flush();
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('a non-JSON line is skipped, not fatal', async () => {
  const seen: string[] = [];
  const { conn, toClient } = pair({ onNotification: (m) => seen.push(m) });
  toClient.write(`this is not json\n${JSON.stringify({ method: 'still-works' })}\n`);
  await flush();
  assert.deepEqual(seen, ['still-works']);
  assert.equal(conn.isClosed, false);
});

test('a server request is answered on the same id', async () => {
  const { toClient, written } = pair({
    onServerRequest: (method, params) => {
      assert.equal(method, 'item/tool/call');
      assert.deepEqual(params, { tool: 'Read' });
      return { contentItems: [], success: true };
    },
  });
  toClient.write(`${JSON.stringify({ id: 'srv-1', method: 'item/tool/call', params: { tool: 'Read' } })}\n`);
  await flush();
  await flush();
  const reply = JSON.parse(written.at(-1)!) as { id: string; result: unknown };
  assert.equal(reply.id, 'srv-1');
  assert.deepEqual(reply.result, { contentItems: [], success: true });
});

test('a server request whose handler throws gets an error reply, not a hang', async () => {
  const { toClient, written } = pair({
    onServerRequest: () => {
      throw new Error('handler exploded');
    },
  });
  toClient.write(`${JSON.stringify({ id: 'srv-2', method: 'x' })}\n`);
  await flush();
  await flush();
  const reply = JSON.parse(written.at(-1)!) as { id: string; error: { message: string } };
  assert.equal(reply.id, 'srv-2');
  assert.match(reply.error.message, /exploded/);
});

test('closing rejects every in-flight request', async () => {
  const { conn } = pair();
  const a = conn.request('a');
  const b = conn.request('b');
  await flush();
  conn.close(new Error('app server died'));
  await assert.rejects(a, /app server died/);
  await assert.rejects(b, /app server died/);
  await assert.rejects(conn.request('c'), /app server died/);
});

test('the stream ending closes the connection', async () => {
  const { conn, toClient } = pair();
  const p = conn.request('a');
  await flush();
  toClient.end();
  await assert.rejects(p, /closed its output stream/);
  assert.equal(conn.isClosed, true);
});

test('a partial message is buffered, not treated as an error', async () => {
  const { conn, toClient } = pair();
  const p = conn.request<{ ok: boolean }>('a');
  await flush();
  const id = (JSON.parse(pairWritten(conn)) as { id: number }).id;
  void id;
  // No newline yet: the connection must simply wait.
  toClient.write('{"partial":');
  await flush();
  assert.equal(conn.isClosed, false);
  conn.close(new Error('done'));
  await assert.rejects(p, /done/);
});

test('an oversized message closes the connection instead of exhausting memory', async () => {
  // The production cap is 64MB; a small one here exercises the same guard
  // without allocating hundreds of megabytes in the test process.
  const { conn, toClient } = pair({}, { maxLineBytes: 1024 });
  // The rejection happens synchronously inside the stream's data handler, so
  // the expectation has to be attached before the write.
  const expectation = assert.rejects(conn.request('a'), /oversized/i);
  await flush();
  // A peer that never sends a newline must not be able to grow our buffer
  // without bound.
  toClient.write('y'.repeat(4096));
  await expectation;
  assert.equal(conn.isClosed, true);
});

/* --------------------------------- queue --------------------------------- */

test('the queue delivers items pushed before and after iteration starts', async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  const seen: number[] = [];
  const done = (async () => {
    for await (const v of q) {
      seen.push(v);
      if (seen.length === 3) break;
    }
  })();
  q.push(2);
  q.push(3);
  await done;
  assert.deepEqual(seen, [1, 2, 3]);
});

test('releaseWaiters ends the current iterator without losing later items', async () => {
  const q = new AsyncQueue<string>();
  const first: string[] = [];
  const consumer = (async () => {
    for await (const v of q) first.push(v);
  })();

  q.push('a');
  await flush();
  // The gateway does this when it closes an Anthropic message on a tool call.
  q.releaseWaiters();
  await consumer;
  assert.deepEqual(first, ['a']);

  // A later event must still reach whoever attaches next.
  q.push('b');
  const second: string[] = [];
  const resumed = (async () => {
    for await (const v of q) {
      second.push(v);
      break;
    }
  })();
  await resumed;
  assert.deepEqual(second, ['b']);
});

test('a failed queue surfaces the error to its consumer', async () => {
  const q = new AsyncQueue<number>();
  q.fail(new Error('boom'));
  await assert.rejects(async () => {
    for await (const _ of q) void _;
  }, /boom/);
});

test('deferred settles once and never rejects unobserved', async () => {
  const d = deferred<number>();
  d.resolve(1);
  d.resolve(2);
  assert.equal(await d.promise, 1);
  assert.equal(d.settled, true);

  const e = deferred<number>();
  e.reject(new Error('x'));
  await assert.rejects(e.promise, /x/);
});
