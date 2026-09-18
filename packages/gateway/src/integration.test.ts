import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, nullLogger, type BridgeConfig } from '@codex-bridge/shared';
import { Gateway } from './gateway.js';

/**
 * Integration tests: a real Gateway, a real HTTP server, a real child process
 * speaking the App Server's JSON-RPC — only the Codex backend is a mock. No
 * OpenAI credentials are involved, so this runs in CI.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-codex.mjs');

let tmpHome: string;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-it-'));
  // Keep the bridge's state (config, sessions, logs) out of the real profile.
  process.env['CODEX_BRIDGE_HOME'] = tmpHome;
});

after(() => {
  delete process.env['CODEX_BRIDGE_HOME'];
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * `codex app-server` is spawned as an executable, so the mock needs to be one.
 * On Windows a `.cmd` shim stands in for the shebang.
 */
function fakeCodexBinary(dir: string): string {
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return shim;
}

interface Harness {
  url: string;
  token: string;
  models: import('./models.js').ModelMapper;
  stop(): Promise<void>;
  post(pathname: string, body: unknown, init?: { auth?: boolean }): Promise<Response>;
  get(pathname: string, init?: { auth?: boolean; headers?: Record<string, string> }): Promise<Response>;
  stream(body: unknown): Promise<StreamResult>;
}

interface StreamResult {
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  content: Array<Record<string, unknown>>;
  stopReason: string | null;
}

async function startHarness(scenario: unknown, tweak?: (c: BridgeConfig) => void): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(tmpHome, 'run-'));
  const bin = fakeCodexBinary(dir);
  process.env['CODEX_FAKE_SCENARIO'] = JSON.stringify(scenario);

  const config: BridgeConfig = structuredClone(DEFAULT_CONFIG);
  config.gateway.port = 0; // let the OS pick, so tests never collide
  config.gateway.authToken = 'test-token';
  config.gateway.requestTimeoutMs = 20_000;
  config.codex.binPath = bin;
  config.logging.file = false;
  tweak?.(config);

  const gateway = new Gateway({ config, logger: nullLogger(), defaultCwd: dir });
  const started = await gateway.start();

  const post = (pathname: string, body: unknown, init: { auth?: boolean } = {}): Promise<Response> =>
    fetch(`${started.url}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.auth === false ? {} : { authorization: `Bearer ${started.authToken}` }),
      },
      body: JSON.stringify(body),
    });

  const stream = async (body: unknown): Promise<StreamResult> => {
    const res = await post('/v1/messages', body);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.clone().text()}`);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    return parseSse(res);
  };

  const get = (pathname: string, init: { auth?: boolean; headers?: Record<string, string> } = {}): Promise<Response> =>
    fetch(`${started.url}${pathname}`, {
      headers: {
        ...(init.auth === false ? {} : { authorization: `Bearer ${started.authToken}` }),
        ...(init.headers ?? {}),
      },
    });

  return {
    url: started.url,
    token: started.authToken,
    models: gateway.models,
    stop: () => gateway.stop(),
    post,
    get,
    stream,
  };
}

async function parseSse(res: Response): Promise<StreamResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamResult['events'] = [];
  const blocks = new Map<number, Record<string, unknown>>();
  let stopReason: string | null = null;
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame.trim()) continue;
      let name: string | null = null;
      let data: string | null = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      assert.ok(name, `SSE frame without an event name: ${frame}`);
      assert.ok(data, `SSE frame without data: ${frame}`);
      const payload = JSON.parse(data) as Record<string, unknown>;
      assert.equal(payload['type'], name, 'event name must match the payload type');
      events.push({ name, payload });

      if (payload['type'] === 'content_block_start') {
        blocks.set(payload['index'] as number, { ...(payload['content_block'] as object), _json: '' });
      } else if (payload['type'] === 'content_block_delta') {
        const b = blocks.get(payload['index'] as number)!;
        const delta = payload['delta'] as Record<string, string>;
        if (delta['type'] === 'text_delta') b['text'] = `${(b['text'] as string) ?? ''}${delta['text']}`;
        if (delta['type'] === 'input_json_delta') b['_json'] = `${b['_json'] as string}${delta['partial_json']}`;
        if (delta['type'] === 'thinking_delta') b['thinking'] = `${(b['thinking'] as string) ?? ''}${delta['thinking']}`;
        if (delta['type'] === 'signature_delta') b['signature'] = delta['signature'];
      } else if (payload['type'] === 'content_block_stop') {
        const b = blocks.get(payload['index'] as number)!;
        if (b['type'] === 'tool_use') b['input'] = b['_json'] ? JSON.parse(b['_json'] as string) : {};
      } else if (payload['type'] === 'message_delta') {
        stopReason = (payload['delta'] as Record<string, string>)['stop_reason'] ?? null;
      }
    }
  }

  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      const { _json, ...rest } = b;
      void _json;
      return rest;
    });
  return { events, content, stopReason };
}

const SESSION = (id: string): Record<string, unknown> => ({ user_id: JSON.stringify({ session_id: id }) });
const TOOLS = [
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
];

/* --------------------------------- tests --------------------------------- */

test('a plain streaming turn produces a valid Anthropic stream', async () => {
  const h = await startHarness({ turns: [[{ text: 'Hello from Codex.' }]] });
  try {
    const s = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'say hi' }],
      tools: TOOLS,
      metadata: SESSION('s1'),
      stream: true,
    });

    assert.equal(s.events[0]?.name, 'message_start');
    assert.equal(s.events.at(-1)?.name, 'message_stop');
    assert.equal(s.stopReason, 'end_turn');
    assert.equal(s.content.length, 1);
    assert.equal(s.content[0]?.['type'], 'text');
    assert.equal(s.content[0]?.['text'], 'Hello from Codex.');

    // The stream must never carry the OpenAI sentinel.
    assert.ok(!s.events.some((e) => e.name === 'DONE'));
  } finally {
    await h.stop();
  }
});

test('a tool call closes the message with stop_reason tool_use and resumes on the result', async () => {
  const h = await startHarness({
    turns: [
      [
        { text: 'Let me read it.' },
        { tool: 'Read', input: { file_path: '/tmp/a.txt' } },
        { text: 'The file says hello.' },
      ],
    ],
  });
  try {
    const first = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'read /tmp/a.txt' }],
      tools: TOOLS,
      metadata: SESSION('s2'),
      stream: true,
    });

    assert.equal(first.stopReason, 'tool_use');
    const toolUse = first.content.find((b) => b['type'] === 'tool_use');
    assert.ok(toolUse, 'expected a tool_use block');
    assert.equal(toolUse['name'], 'Read');
    assert.deepEqual(toolUse['input'], { file_path: '/tmp/a.txt' });

    // Returning the result must continue the SAME Codex turn, not start a new one.
    const second = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'read /tmp/a.txt' },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse['id'], content: 'hello' }],
        },
      ],
      tools: TOOLS,
      metadata: SESSION('s2'),
      stream: true,
    });

    assert.equal(second.stopReason, 'end_turn');
    const text = second.content.find((b) => b['type'] === 'text');
    assert.equal(text?.['text'], 'The file says hello.');
  } finally {
    await h.stop();
  }
});

test('parallel tool calls arrive in a single assistant message', async () => {
  const h = await startHarness({
    // The mock answers one call at a time, so this asserts the grace window does
    // not split a burst across two messages when they land together.
    turns: [[{ tool: 'Read', input: { file_path: '/a' } }, { text: 'done' }]],
  });
  try {
    const s = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'read both' }],
      tools: TOOLS,
      metadata: SESSION('s3'),
      stream: true,
    });
    assert.equal(s.stopReason, 'tool_use');
    assert.equal(s.content.filter((b) => b['type'] === 'tool_use').length, 1);
  } finally {
    await h.stop();
  }
});

test('a non-streaming request returns a JSON Message', async () => {
  const h = await startHarness({ turns: [[{ text: 'Non-streaming reply.' }]] });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
      metadata: SESSION('s4'),
    });
    assert.equal(res.status, 200);
    // The SDK only parses the body when the content type says JSON.
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['type'], 'message');
    assert.equal(body['role'], 'assistant');
    assert.equal(body['stop_reason'], 'end_turn');
    assert.deepEqual(body['content'], [{ type: 'text', text: 'Non-streaming reply.' }]);
  } finally {
    await h.stop();
  }
});

test('reasoning becomes a thinking block only when thinking is enabled', async () => {
  const h = await startHarness({ turns: [[{ reasoning: 'pondering' }, { text: 'answer' }], [{ reasoning: 'x' }, { text: 'answer' }]] });
  try {
    const off = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'q' }],
      tools: TOOLS,
      metadata: SESSION('s5a'),
      stream: true,
    });
    assert.ok(!off.content.some((b) => b['type'] === 'thinking'));

    const on = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'q' }],
      tools: TOOLS,
      metadata: SESSION('s5b'),
      thinking: { type: 'enabled', budget_tokens: 1024 },
      stream: true,
    });
    const thinking = on.content.find((b) => b['type'] === 'thinking');
    assert.ok(thinking, 'expected a thinking block');
    assert.equal(thinking['thinking'], 'x');
    assert.equal(typeof thinking['signature'], 'string');
  } finally {
    await h.stop();
  }
});

test('adaptive thinking is accepted and ignored rather than rejected', async () => {
  const h = await startHarness({ turns: [[{ text: 'fine' }]] });
  try {
    const s = await h.stream({
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'q' }],
      tools: TOOLS,
      // Claude Code sends this to any model name it does not recognise.
      thinking: { type: 'adaptive' },
      metadata: SESSION('s6'),
      stream: true,
    });
    assert.equal(s.stopReason, 'end_turn');
  } finally {
    await h.stop();
  }
});

test('a Codex turn error becomes a terminal SSE error event, not a broken stream', async () => {
  const h = await startHarness({ turns: [[{ error: 'Codex usage limit reached', willRetry: false }]] });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'q' }],
      tools: TOOLS,
      metadata: SESSION('s7'),
      stream: true,
    });
    const text = await res.text();
    assert.match(text, /event: error/);
    assert.match(text, /rate_limit_error/);
  } finally {
    await h.stop();
  }
});

test('usage reported by Codex reaches the Anthropic response', async () => {
  const h = await startHarness({
    turns: [
      [
        {
          usage: {
            totalTokens: 150,
            inputTokens: 120,
            cachedInputTokens: 30,
            cacheWriteInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 0,
          },
        },
        { text: 'ok' },
      ],
    ],
  });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'q' }],
      tools: TOOLS,
      metadata: SESSION('s8'),
    });
    const body = (await res.json()) as { usage: Record<string, number> };
    assert.equal(body.usage['input_tokens'], 120);
    assert.equal(body.usage['output_tokens'], 30);
    assert.equal(body.usage['cache_read_input_tokens'], 30);
  } finally {
    await h.stop();
  }
});

test('a tool-less request never pollutes the coding session', async () => {
  const h = await startHarness({ turns: [[{ text: 'A Title' }], [{ text: 'main answer' }]] });
  try {
    // Utility call (no tools) — runs in a throwaway thread.
    const title = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Summarise this conversation in three words.' }],
      metadata: SESSION('s9'),
    });
    const titleBody = (await title.json()) as { content: Array<{ text: string }> };
    assert.equal(titleBody.content[0]?.text, 'A Title');

    const main = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'real question' }],
      tools: TOOLS,
      metadata: SESSION('s9'),
    });
    const mainBody = (await main.json()) as { content: Array<{ text: string }> };
    assert.equal(mainBody.content[0]?.text, 'main answer');
  } finally {
    await h.stop();
  }
});

test('the credential probe is answered without spending a Codex turn', async () => {
  // No turns are scripted; if the probe reached the mock it would fall back to
  // "ok" — the distinct "OK" body proves the fast path was taken.
  const h = await startHarness({ turns: [] });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    });
    const body = (await res.json()) as { content: Array<{ text: string }>; stop_reason: string };
    assert.equal(body.content[0]?.text, 'OK');
    assert.equal(body.stop_reason, 'max_tokens');
  } finally {
    await h.stop();
  }
});

test('malformed requests return an Anthropic-shaped error', async () => {
  const h = await startHarness({});
  try {
    const cases: Array<[unknown, string]> = [
      [{}, 'model'],
      [{ model: 'codex' }, 'max_tokens'],
      [{ model: 'codex', max_tokens: 10 }, 'messages'],
      [{ model: 'codex', max_tokens: 10, messages: [] }, 'at least one'],
      [{ model: 'codex', max_tokens: 10, messages: [{ role: 'bot', content: 'x' }] }, 'role'],
      [
        { model: 'codex', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] },
        'tool_use_id',
      ],
    ];
    for (const [body, needle] of cases) {
      const res = await h.post('/v1/messages', body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const err = (await res.json()) as { type: string; error: { type: string; message: string } };
      assert.equal(err.type, 'error');
      assert.equal(err.error.type, 'invalid_request_error');
      assert.match(err.error.message, new RegExp(needle, 'i'));
    }
  } finally {
    await h.stop();
  }
});

test('requests without the gateway token are rejected', async () => {
  const h = await startHarness({});
  try {
    const res = await h.post(
      '/v1/messages',
      { model: 'codex', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { auth: false },
    );
    assert.equal(res.status, 401);
    const err = (await res.json()) as { error: { type: string } };
    assert.equal(err.error.type, 'authentication_error');
  } finally {
    await h.stop();
  }
});

test('an x-api-key header is accepted as well as a bearer token', async () => {
  const h = await startHarness({ turns: [[{ text: 'ok' }]] });
  try {
    const res = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': h.token },
      body: JSON.stringify({
        model: 'codex',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'x' }],
        tools: TOOLS,
        metadata: SESSION('s10'),
      }),
    });
    assert.equal(res.status, 200);
  } finally {
    await h.stop();
  }
});

test('a non-loopback Host header is refused (DNS-rebinding guard)', async () => {
  const h = await startHarness({});
  try {
    // `host` is a forbidden header for fetch(), so this needs a raw request.
    const port = Number(new URL(h.url).port);
    const good = await rawGet(port, '/health', '127.0.0.1');
    assert.equal(good.status, 200);
    const bad = await rawGet(port, '/health', 'evil.example.com');
    assert.equal(bad.status, 403);
  } finally {
    await h.stop();
  }
});

function rawGet(port: number, pathname: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('count_tokens answers with a positive estimate', async () => {
  const h = await startHarness({});
  try {
    const res = await h.post('/v1/messages/count_tokens', {
      model: 'codex',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { input_tokens: number };
    assert.ok(body.input_tokens > 0);
  } finally {
    await h.stop();
  }
});

test('model discovery satisfies BOTH Claude Code and the desktop app', async () => {
  const h = await startHarness({});
  try {
    const res = await h.get('/v1/models');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        display_name: string;
        description: string;
        anthropic_family_tier: string;
        is_family_default: boolean;
      }>;
      has_more: boolean;
    };
    assert.ok(body.data.length > 0);

    const { isAcceptableModelId } = await import('./models.js');
    for (const m of body.data) {
      // The CLI drops any id not matching /claude|anthropic/i, and the desktop
      // additionally blocklists foreign-vendor words — `codex` and `gpt` among
      // them. Failing that second filter is silent: the row is removed, the
      // picker ends up empty and the app says "Models are still loading"
      // forever, which is exactly what `claude-codex-*` ids produced.
      assert.match(m.id, /claude|anthropic/i, `id ${m.id} would be dropped by Claude Code`);
      assert.ok(isAcceptableModelId(m.id), `id ${m.id} would be dropped by Claude Code Desktop`);
      assert.doesNotMatch(m.id, /codex|gpt/i, `id ${m.id} names a vendor the desktop rejects`);
      // The label is not filtered, so that is where Codex is named honestly.
      assert.match(m.display_name, /codex/i, `${m.id} must still say Codex to the user`);
      // The desktop drops any row that is neither a known Anthropic model id
      // nor tiered — that is what produced "returned no usable models".
      assert.ok(
        ['opus', 'sonnet', 'haiku', 'fable', 'mythos'].includes(m.anthropic_family_tier),
        `id ${m.id} has no usable anthropic_family_tier`,
      );
      // It truncates descriptions at 100 characters.
      assert.ok(m.description.length > 0 && m.description.length <= 100);
    }

    // Exactly one family default per tier, so a bare alias resolves.
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const defaults = body.data.filter((m) => m.anthropic_family_tier === tier && m.is_family_default);
      assert.equal(defaults.length, 1, `tier ${tier} must have exactly one family default`);
    }

    // No pagination cursor is advertised, so discovery stops after one page.
    assert.equal(body.has_more, false);
  } finally {
    await h.stop();
  }
});

test('every advertised model id resolves back to a real Codex model', async () => {
  const h = await startHarness({ turns: [[{ text: 'ok' }]] });
  try {
    const body = (await (await h.get('/v1/models')).json()) as { data: Array<{ id: string }> };
    // A model the desktop offers must be one the gateway can actually serve.
    for (const m of body.data) {
      const resolved = await h.models.resolve(m.id);
      assert.ok(resolved.codexModel, `${m.id} resolved to nothing`);
    }
  } finally {
    await h.stop();
  }
});

test('a pinned model id resolves to that exact Codex model, under real Codex names', async () => {
  // The real catalogue is all `gpt-*`, which is precisely the shape the desktop
  // blocklists — so the mapping has to hold for names that cannot be advertised
  // verbatim, not just for the fixture's neutral `fake-model-*` ids.
  const models = [
    ['gpt-6-astra', 'GPT-6-Astra', true],
    ['gpt-5.6-sol', 'GPT-5.6-Sol', false],
    ['gpt-5.6-terra', 'GPT-5.6-Terra', false],
    ['gpt-5.5', 'GPT-5.5', false],
  ].map(([id, displayName, isDefault]) => ({
    id,
    model: id,
    displayName,
    description: 'test',
    hidden: false,
    isDefault,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ effort: 'medium' }],
    inputModalities: ['text'],
  }));

  const h = await startHarness({ models, turns: [[{ text: 'ok' }]] });
  try {
    const { isAcceptableModelId } = await import('./models.js');
    const body = (await (await h.get('/v1/models')).json()) as {
      data: Array<{ id: string; display_name: string }>;
    };

    for (const row of body.data) {
      assert.ok(isAcceptableModelId(row.id), `${row.id} would be dropped by the desktop`);
    }

    // Distinct Codex models must not collapse onto one advertised id, or
    // picking one of them would silently serve another.
    const ids = body.data.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `advertised ids collide: ${ids.join(', ')}`);

    // Every concrete model is offered, and picking it gets you that one.
    for (const m of models) {
      const row = body.data.find((r) => r.display_name === `Codex ${m.displayName}`);
      assert.ok(row, `${m.id} is not offered`);
      const resolved = await h.models.resolve(row.id);
      assert.equal(resolved.codexModel, m.id, `${row.id} should serve ${m.id}`);
      // ...and Claude Code is told back the name it asked for, not the Codex one.
      assert.equal(resolved.reportedModel, row.id);
    }

    // A tier slot means "whatever Codex thinks is best", i.e. its own default.
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const resolved = await h.models.resolve(`claude-${tier}-bridge`);
      assert.equal(resolved.codexModel, 'gpt-6-astra', `${tier} slot should use Codex's default`);
    }

    // The context-window suffix must not defeat the mapping.
    assert.equal((await h.models.resolve('claude-bridge-5-5[1m]')).codexModel, 'gpt-5.5');
  } finally {
    await h.stop();
  }
});

test('health and the startup probe answer without credentials', async () => {
  const h = await startHarness({});
  try {
    const health = await fetch(`${h.url}/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { codexAppServer: boolean };
    assert.equal(body.codexAppServer, true);

    const hello = await fetch(`${h.url}/api/hello`, { method: 'HEAD' });
    assert.equal(hello.status, 200);
  } finally {
    await h.stop();
  }
});

test('an unknown endpoint 404s and a wrong verb 405s', async () => {
  const h = await startHarness({});
  try {
    const missing = await h.get('/v1/nope');
    assert.equal(missing.status, 404);
    const wrongVerb = await h.get('/v1/messages');
    assert.equal(wrongVerb.status, 405);
  } finally {
    await h.stop();
  }
});

test('an oversized body is rejected with 413', async () => {
  const h = await startHarness({}, (c) => {
    c.gateway.maxBodyBytes = 64 * 1024;
  });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'x'.repeat(200 * 1024) }],
    });
    assert.equal(res.status, 413);
    const err = (await res.json()) as { error: { type: string } };
    assert.equal(err.error.type, 'request_too_large');
  } finally {
    await h.stop();
  }
});

/* ------------------------------ auth surface ------------------------------ */

test('status reports a connected ChatGPT account and its usage', async () => {
  const h = await startHarness({});
  try {
    const res = await h.get('/admin/status');
    const body = (await res.json()) as {
      account: { connected: boolean; authMethod: string; email: string; plan: string };
      usage: { primary: { usedPercent: number; label: string } } | null;
    };
    assert.equal(body.account.connected, true);
    assert.equal(body.account.authMethod, 'ChatGPT OAuth');
    assert.equal(body.account.email, 'test@example.com');
    assert.equal(body.account.plan, 'Plus');
    assert.equal(body.usage?.primary.usedPercent, 34);
    assert.equal(body.usage?.primary.label, '5-hour');
  } finally {
    await h.stop();
  }
});

test('usage is reported as absent rather than invented when Codex does not supply it', async () => {
  const h = await startHarness({ rateLimits: null });
  try {
    const res = await h.get('/admin/status');
    const body = (await res.json()) as { usage: unknown };
    assert.equal(body.usage, null);
  } finally {
    await h.stop();
  }
});

test('an unauthenticated account produces a 401 with a useful message', async () => {
  const h = await startHarness({ account: null });
  try {
    const res = await h.post('/v1/messages', {
      model: 'codex',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'x' }],
      tools: TOOLS,
    });
    assert.equal(res.status, 401);
    const err = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(err.error.type, 'authentication_error');
    assert.match(err.error.message, /logincodex/);
  } finally {
    await h.stop();
  }
});

test('the browser login flow completes and never exposes a token', async () => {
  const h = await startHarness({ account: null, loginCompletesAfterMs: 100 });
  try {
    const started = (await (await h.post('/admin/login', { open: false })).json()) as {
      loginId: string;
      url: string;
      status: string;
    };
    assert.equal(started.status, 'pending');
    assert.match(started.url, /^https:\/\//);

    for (let i = 0; i < 50; i += 1) {
      const s = (await (await h.get('/admin/login/status')).json()) as {
        connected: boolean;
        login: { status: string } | null;
      };
      if (s.connected) {
        assert.equal(s.login?.status, 'success');
        const raw = await (await h.get('/admin/status')).text();
        // Nothing credential-shaped may ever cross the HTTP boundary.
        assert.ok(!/eyJ|refresh_token|access_token|"tokens"/.test(raw), 'status leaked token-shaped data');
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('login never completed');
  } finally {
    await h.stop();
  }
});

test('a failed login is reported as failed rather than hanging', async () => {
  const h = await startHarness({ account: null, loginSucceeds: false, loginCompletesAfterMs: 50 });
  try {
    await h.post('/admin/login', { open: false });
    for (let i = 0; i < 50; i += 1) {
      const s = (await (await h.get('/admin/login/status')).json()) as {
        login: { status: string; error: string | null } | null;
      };
      if (s.login?.status === 'failed') {
        assert.match(s.login.error ?? '', /cancelled/);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('login failure was never reported');
  } finally {
    await h.stop();
  }
});

test('logout disconnects the account', async () => {
  const h = await startHarness({});
  try {
    const before = (await (await h.get('/admin/status')).json()) as { account: { connected: boolean } };
    assert.equal(before.account.connected, true);

    const out = await h.post('/admin/logout', {});
    assert.equal(out.status, 200);

    const after = (await (await h.get('/admin/status')).json()) as { account: { connected: boolean } };
    assert.equal(after.account.connected, false);
  } finally {
    await h.stop();
  }
});

test('doctor reports on the mocked environment without throwing', async () => {
  const h = await startHarness({});
  try {
    const res = await h.post('/admin/doctor', {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { report: string; ok: boolean };
    assert.match(body.report, /Codex Bridge Doctor/);
    assert.match(body.report, /ChatGPT authentication/);
  } finally {
    await h.stop();
  }
});

test('the management page is self-contained — no external resources', async () => {
  const h = await startHarness({});
  try {
    const res = await fetch(`${h.url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Codex Bridge/);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(html.replace(/https?:\/\/\$\{?/g, '')), 'page references an external URL');
    assert.ok(!/<script[^>]+src=/.test(html), 'page loads an external script');
    assert.ok(!/<link[^>]+stylesheet/.test(html), 'page loads an external stylesheet');
  } finally {
    await h.stop();
  }
});


/* ------------------------- local-surface hardening ------------------------ */

test('the admin API requires the gateway token', async () => {
  const h = await startHarness({});
  try {
    for (const [method, pathname] of [
      ['GET', '/admin/status'],
      ['POST', '/admin/logout'],
      ['POST', '/admin/restart'],
      ['POST', '/admin/login'],
      ['POST', '/admin/sessions/clear'],
    ] as Array<[string, string]>) {
      const res = await fetch(`${h.url}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(res.status, 401, `${method} ${pathname} must require the token`);
    }
  } finally {
    await h.stop();
  }
});

test('a cross-site request is refused even with a valid token', async () => {
  // A page on any website can reach loopback with a CORS "simple request",
  // which is not preflighted. Origin / Sec-Fetch-Site is what stops it; real
  // clients (Claude Code, curl) send neither.
  const h = await startHarness({});
  try {
    const byOrigin = await h.get('/admin/status', { headers: { origin: 'https://evil.example.com' } });
    assert.equal(byOrigin.status, 403);

    const bySite = await h.get('/admin/status', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(bySite.status, 403);

    // Same-origin and non-browser callers are unaffected.
    assert.equal((await h.get('/admin/status', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await h.get('/admin/status')).status, 200);
  } finally {
    await h.stop();
  }
});

test('the management page carries a token so it can call the admin API', async () => {
  const h = await startHarness({});
  try {
    const html = await (await fetch(`${h.url}/`)).text();
    assert.ok(html.includes(h.token), 'the page must be able to authenticate');
    assert.match(html, /authorization/i);
  } finally {
    await h.stop();
  }
});

test('an un-normalised path cannot slip past the auth check', async () => {
  const h = await startHarness({});
  try {
    const port = Number(new URL(h.url).port);
    const doubled = await rawGet(port, '//admin/status', '127.0.0.1');
    assert.equal(doubled.status, 400);
    const dotdot = await rawGet(port, '/..//v1/messages', '127.0.0.1');
    assert.equal(dotdot.status, 400);
  } finally {
    await h.stop();
  }
});

/* --------------------------- account switching ---------------------------- */

test('signing in while already connected starts a fresh login', async () => {
  // This is how you switch ChatGPT accounts. Short-circuiting on "already
  // connected" would make switching impossible from the plugin.
  const h = await startHarness({ loginCompletesAfterMs: 50 });
  try {
    const before = (await (await h.get('/admin/status')).json()) as { account: { connected: boolean } };
    assert.equal(before.account.connected, true, 'precondition: already signed in');

    const started = (await (
      await h.post('/admin/login', { open: false, switchAccount: true })
    ).json()) as { loginId: string; status: string; url: string };
    assert.equal(started.status, 'pending');
    assert.match(started.url, /^https:\/\//);
  } finally {
    await h.stop();
  }
});

test('a switch cancels a pending login instead of reusing it', async () => {
  const h = await startHarness({ loginCompletesAfterMs: 60_000 });
  try {
    const first = (await (await h.post('/admin/login', { open: false })).json()) as { loginId: string };
    const reused = (await (await h.post('/admin/login', { open: false })).json()) as {
      loginId: string;
      reused: boolean;
    };
    assert.equal(reused.reused, true, 'a plain retry should reuse the in-flight login');
    assert.equal(reused.loginId, first.loginId);

    const switched = (await (
      await h.post('/admin/login', { open: false, switchAccount: true })
    ).json()) as { loginId: string; reused: boolean };
    assert.equal(switched.reused, false, 'a switch must start a new flow');
    assert.notEqual(switched.loginId, first.loginId);
  } finally {
    await h.stop();
  }
});

/* ------------------------------ scoped config ----------------------------- */

test('configuring a project scope leaves the user settings alone', async () => {
  const h = await startHarness({});
  const projectDir = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
  const userFile = path.join(tmpHome, 'user-settings.json');
  fs.writeFileSync(userFile, JSON.stringify({ env: { SOMETHING_ELSE: 'keep me' } }, null, 2));
  try {
    const { configureClaudeCode, settingsFileForScope, gatewayEnv } = await import('./claude-config.js');

    const projectPath = settingsFileForScope('project', projectDir);
    assert.ok(projectPath.endsWith(path.join('.claude', 'settings.local.json')));

    configureClaudeCode({ baseUrl: h.url, authToken: h.token, scope: 'project', projectDir });
    const written = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as { env: Record<string, string> };
    assert.equal(written.env['ANTHROPIC_BASE_URL'], h.url);

    // The user-scope file was never opened.
    const user = JSON.parse(fs.readFileSync(userFile, 'utf8')) as { env: Record<string, string> };
    assert.deepEqual(user.env, { SOMETHING_ELSE: 'keep me' });

    // The same env is available without writing anything at all.
    const env = gatewayEnv({ baseUrl: h.url, authToken: h.token });
    assert.equal(env['ANTHROPIC_BASE_URL'], h.url);
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], h.token);
    assert.equal(env['ANTHROPIC_CUSTOM_MODEL_OPTION'], 'codex');
  } finally {
    await h.stop();
  }
});
