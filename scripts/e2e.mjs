#!/usr/bin/env node
/**
 * End-to-end acceptance test.
 *
 * Drives the gateway exactly the way Claude Code does: an Anthropic Messages
 * request with a system prompt, a tool set and `stream: true`; then the full
 * tool loop — read the SSE stream, execute each `tool_use` locally, post the
 * `tool_result` back, and repeat until `stop_reason: "end_turn"`.
 *
 * It asserts the things that actually matter:
 *   - streaming produces a well-formed Anthropic SSE sequence
 *   - tools are called with structured arguments
 *   - tool results flow back and the SAME Codex turn continues
 *   - conversation continuity survives across separate HTTP requests
 *   - a follow-up user message reuses the same Codex thread
 *
 * Usage: node scripts/e2e.mjs [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEEP = process.argv.includes('--keep');

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const ok = (msg) => log(`  ✓ ${msg}`);

/* ------------------------------- gateway --------------------------------- */

function cli(args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/dist/bin.js'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });
}

function gatewayRecord() {
  const out = cli(['start', '--json']);
  return JSON.parse(out);
}

/* ------------------------------- workspace ------------------------------- */

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-e2e-'));
  fs.writeFileSync(
    path.join(dir, 'math_util.py'),
    ['def add(a, b):', '    # BUG: this subtracts instead of adding', '    return a - b', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# demo\n\nA tiny package with one arithmetic helper.\n',
  );
  return dir;
}

/* --------------------------- Claude Code's tools -------------------------- */

function toolset() {
  return [
    {
      name: 'Read',
      description: 'Read a file from the local filesystem. Returns the full contents.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute path to the file.' } },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
    {
      name: 'Edit',
      description: 'Replace an exact string in a file. old_string must appear exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
    {
      name: 'Bash',
      description: 'Run a shell command and return its combined output.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ];
}

function executeTool(name, input, workspace) {
  try {
    if (name === 'Read') {
      const p = path.resolve(workspace, input.file_path);
      if (!p.startsWith(workspace)) return { content: 'Error: path outside the workspace', is_error: true };
      return { content: fs.readFileSync(p, 'utf8') };
    }
    if (name === 'Edit') {
      const p = path.resolve(workspace, input.file_path);
      if (!p.startsWith(workspace)) return { content: 'Error: path outside the workspace', is_error: true };
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes(input.old_string)) return { content: 'Error: old_string not found', is_error: true };
      fs.writeFileSync(p, src.replace(input.old_string, input.new_string));
      return { content: 'Edit applied.' };
    }
    if (name === 'Bash') {
      const out = execFileSync('/bin/sh', ['-c', input.command], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 30_000,
      });
      return { content: out || '(no output)' };
    }
    return { content: `Unknown tool ${name}`, is_error: true };
  } catch (err) {
    return { content: `Error: ${err.message}`, is_error: true };
  }
}

/* ---------------------------- SSE stream reader --------------------------- */

async function streamMessages(rec, body) {
  const res = await fetch(`${rec.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rec.token}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    fail(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream')) fail(`expected SSE, got ${ctype}`);

  const events = [];
  const blocks = new Map();
  let messageMeta = null;
  let stopReason = null;
  let usage = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!frame.trim()) continue;

      let eventName = null;
      let dataLine = null;
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine = line.slice(6);
      }
      if (!dataLine) fail(`SSE frame without a data line: ${frame}`);
      const payload = JSON.parse(dataLine);
      if (eventName && payload.type !== eventName) {
        fail(`SSE event name "${eventName}" does not match payload type "${payload.type}"`);
      }
      events.push(payload);

      switch (payload.type) {
        case 'message_start':
          messageMeta = payload.message;
          break;
        case 'content_block_start':
          blocks.set(payload.index, { ...payload.content_block, _json: '' });
          break;
        case 'content_block_delta': {
          const b = blocks.get(payload.index);
          if (!b) fail(`delta for unopened block index ${payload.index}`);
          if (payload.delta.type === 'text_delta') b.text = (b.text ?? '') + payload.delta.text;
          else if (payload.delta.type === 'input_json_delta') b._json += payload.delta.partial_json;
          else if (payload.delta.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + payload.delta.thinking;
          else if (payload.delta.type === 'signature_delta') b.signature = payload.delta.signature;
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(payload.index);
          if (b && b.type === 'tool_use') b.input = b._json ? JSON.parse(b._json) : {};
          break;
        }
        case 'message_delta':
          stopReason = payload.delta.stop_reason;
          usage = payload.usage;
          break;
        case 'error':
          fail(`stream error: ${JSON.stringify(payload.error)}`);
          break;
        default:
          break;
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

  return { events, content, stopReason, usage, messageMeta };
}

/* --------------------------------- checks -------------------------------- */

function assertWellFormed(stream) {
  const types = stream.events.map((e) => e.type);
  if (types[0] !== 'message_start') fail(`stream must start with message_start, got ${types[0]}`);
  if (types[types.length - 1] !== 'message_stop') fail(`stream must end with message_stop, got ${types.at(-1)}`);
  if (!types.includes('message_delta')) fail('stream is missing message_delta');

  const depth = new Map();
  for (const e of stream.events) {
    if (e.type === 'content_block_start') {
      if (depth.get(e.index)) fail(`content block ${e.index} opened twice`);
      depth.set(e.index, true);
    }
    if (e.type === 'content_block_stop') {
      if (!depth.get(e.index)) fail(`content block ${e.index} closed without being opened`);
      depth.set(e.index, false);
    }
  }
  for (const [index, open] of depth) if (open) fail(`content block ${index} was never closed`);

  const m = stream.messageMeta;
  if (!m || m.type !== 'message' || m.role !== 'assistant') fail('message_start carried a malformed message');
  if (!m.id?.startsWith('msg_')) fail(`message id looks wrong: ${m.id}`);
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  log('Codex Bridge — end-to-end acceptance test\n');

  log('1. Gateway');
  const rec = gatewayRecord();
  ok(`running on ${rec.url}`);

  const admin = (pathname) =>
    fetch(`${rec.url}${pathname}`, { headers: { authorization: `Bearer ${rec.token}` } }).then((r) => r.json());

  const health = await fetch(`${rec.url}/health`).then((r) => r.json());
  if (health.codexAppServer !== true) fail('Codex App Server is not running');
  ok('Codex App Server responding');

  const status = await admin('/admin/status');
  if (!status.account.connected) fail('not authenticated — run: codex-bridge login');
  ok(`authenticated as ${status.account.email ?? 'ChatGPT user'} (${status.account.plan})`);
  if (!status.model.resolved) fail('no Codex model resolved');
  ok(`model ${status.model.resolved}`);

  const workspace = makeWorkspace();
  log(`\n2. Workspace: ${workspace}`);

  const sessionId = `e2e-${Date.now().toString(36)}`;
  const metadata = { user_id: JSON.stringify({ session_id: sessionId, account_uuid: '' }) };
  const system = [
    {
      type: 'text',
      text: [
        "You are Claude Code, Anthropic's official CLI for software engineering.",
        '',
        `Working directory: ${workspace}`,
        '',
        'Use the provided tools to inspect and change files. Be concise.',
      ].join('\n'),
    },
  ];

  const messages = [
    {
      role: 'user',
      content: `There is a bug in ${path.join(workspace, 'math_util.py')}: add() subtracts instead of adding. Read the file, fix it with Edit, then run a Bash command that proves add(2,3) == 5.`,
    },
  ];

  log('\n3. Tool loop');
  let round = 0;
  let sawToolUse = false;
  let finalText = '';
  const toolsUsed = [];

  for (;;) {
    round += 1;
    if (round > 12) fail('tool loop did not converge within 12 rounds');

    const stream = await streamMessages(rec, {
      model: 'codex',
      max_tokens: 8192,
      system,
      messages,
      tools: toolset(),
      metadata,
      stream: true,
    });
    assertWellFormed(stream);

    const toolUses = stream.content.filter((b) => b.type === 'tool_use');
    const text = stream.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    log(
      `  round ${round}: stop_reason=${stream.stopReason} blocks=${stream.content.length} ` +
        `tool_use=${toolUses.length}${text ? ` text=${JSON.stringify(text.slice(0, 60))}` : ''}`,
    );

    messages.push({ role: 'assistant', content: stream.content });

    if (stream.stopReason === 'tool_use') {
      if (!toolUses.length) fail('stop_reason=tool_use but no tool_use block was emitted');
      sawToolUse = true;
      const results = [];
      for (const tu of toolUses) {
        if (!tu.id?.startsWith('toolu_')) fail(`tool_use id looks wrong: ${tu.id}`);
        if (typeof tu.input !== 'object' || tu.input === null) fail(`tool_use input is not an object: ${tu.input}`);
        toolsUsed.push(tu.name);
        const r = executeTool(tu.name, tu.input, workspace);
        log(`    -> ${tu.name}(${JSON.stringify(tu.input).slice(0, 90)}) ${r.is_error ? 'ERROR' : 'ok'}`);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: r.content,
          ...(r.is_error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (stream.stopReason === 'end_turn') {
      finalText = text;
      break;
    }
    fail(`unexpected stop_reason: ${stream.stopReason}`);
  }

  log('\n4. Assertions');
  if (!sawToolUse) fail('the model never called a tool');
  ok(`tools called: ${toolsUsed.join(', ')}`);

  const fixed = fs.readFileSync(path.join(workspace, 'math_util.py'), 'utf8');
  if (!/return\s+a\s*\+\s*b/.test(fixed)) fail(`the file was not fixed:\n${fixed}`);
  ok('the bug was actually fixed on disk');

  if (!toolsUsed.includes('Read')) fail('the model never read the file');
  if (!toolsUsed.includes('Edit')) fail('the model never edited the file');
  ok('Read and Edit both round-tripped through the bridge');

  if (!finalText.trim()) fail('the final assistant message had no text');
  ok(`final message: ${JSON.stringify(finalText.slice(0, 80))}`);

  log('\n5. Conversation continuity (new user turn, same session)');
  messages.push({
    role: 'user',
    content: 'Without using any tools, what was the exact name of the file you just fixed?',
  });
  const followUp = await streamMessages(rec, {
    model: 'codex',
    max_tokens: 2048,
    system,
    messages,
    tools: toolset(),
    metadata,
    stream: true,
  });
  assertWellFormed(followUp);
  const followText = followUp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!/math_util\.py/.test(followText)) {
    fail(`the follow-up lost conversation context. Reply was: ${JSON.stringify(followText)}`);
  }
  ok('context carried across separate HTTP requests');

  log('\n6. Non-streaming request');
  const nonStream = await fetch(`${rec.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.token}` },
    body: JSON.stringify({
      model: 'codex',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      metadata: { user_id: JSON.stringify({ session_id: `${sessionId}-ns` }) },
    }),
  }).then((r) => r.json());
  if (nonStream.type !== 'message') fail(`non-streaming response malformed: ${JSON.stringify(nonStream).slice(0, 300)}`);
  const nsText = (nonStream.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!/PONG/i.test(nsText)) fail(`non-streaming reply unexpected: ${JSON.stringify(nsText)}`);
  ok(`non-streaming works (stop_reason=${nonStream.stop_reason})`);

  log('\n7. count_tokens');
  const count = await fetch(`${rec.url}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.token}` },
    body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hello world' }] }),
  }).then((r) => r.json());
  if (typeof count.input_tokens !== 'number' || count.input_tokens <= 0) {
    fail(`count_tokens returned ${JSON.stringify(count)}`);
  }
  ok(`count_tokens returned ${count.input_tokens}`);

  log('\n8. Error handling');
  const bad = await fetch(`${rec.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rec.token}` },
    body: JSON.stringify({ model: 'codex' }),
  });
  const badBody = await bad.json();
  if (bad.status !== 400 || badBody.type !== 'error' || badBody.error.type !== 'invalid_request_error') {
    fail(`malformed request handling wrong: ${bad.status} ${JSON.stringify(badBody)}`);
  }
  ok('malformed requests return an Anthropic-shaped 400');

  const unauth = await fetch(`${rec.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex', max_tokens: 1, messages: [] }),
  });
  if (unauth.status !== 401) fail(`unauthenticated request returned ${unauth.status}, expected 401`);
  ok('unauthenticated requests are rejected');

  if (!KEEP) fs.rmSync(workspace, { recursive: true, force: true });
  log('\nAll end-to-end checks passed.\n');
}

main().catch((err) => {
  console.error(`\nEnd-to-end test failed: ${err.message}`);
  process.exitCode = 1;
});

