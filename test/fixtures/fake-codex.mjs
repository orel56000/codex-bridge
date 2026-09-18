#!/usr/bin/env node
/**
 * A mock `codex app-server`.
 *
 * Speaks the same newline-delimited JSON-RPC the real App Server speaks, so the
 * gateway can be tested end to end — process spawn, handshake, threads, turns,
 * streaming and the dynamic-tool callback — with no Codex install and no
 * OpenAI credentials.
 *
 * Behaviour is driven by CODEX_FAKE_SCENARIO (JSON):
 *   {
 *     "account":  null | {"type":"chatgpt","email":"...","planType":"plus"},
 *     "turns":    [ [ step, ... ], ... ]   // one script per turn, in order
 *     "failInitialize": bool,
 *     "rateLimits": {...} | null
 *   }
 *
 * Steps:
 *   {"text": "..."}                                  stream an assistant delta
 *   {"reasoning": "..."}                             stream a reasoning delta
 *   {"tool": "Read", "input": {...}}                 call a dynamic tool and wait
 *   {"error": "...", "willRetry": false}             emit a turn error
 *   {"usage": {...}}                                 emit token usage
 *   {"sleepMs": 50}                                  delay
 *   {"hang": true}                                   stop emitting (never completes)
 */
import process from 'node:process';
import { randomUUID } from 'node:crypto';

// The real binary answers `--version` synchronously; the gateway asks for it.
if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}

const scenario = JSON.parse(process.env['CODEX_FAKE_SCENARIO'] ?? '{}');
const state = {
  turnIndex: 0,
  threads: new Map(),
  pending: new Map(),
  loginId: null,
  account: scenario.account === undefined ? { type: 'chatgpt', email: 'test@example.com', planType: 'plus' } : scenario.account,
};

let buf = '';
let nextServerId = 1;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function reply(id, result) {
  send({ id, result });
}
function replyError(id, message, code = -32000) {
  send({ id, error: { code, message } });
}
function notify(method, params) {
  send({ method, params });
}
function serverRequest(method, params) {
  const id = `srv-${nextServerId++}`;
  return new Promise((resolve) => {
    state.pending.set(id, resolve);
    send({ id, method, params });
  });
}

function handle(msg) {
  // A response to one of our server-initiated requests.
  if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
    const resolve = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    resolve?.(msg.result ?? { contentItems: [], success: false });
    return;
  }
  if (!msg.method) return;
  if (msg.id === undefined) return; // client notification (e.g. "initialized")

  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      if (scenario.failInitialize) return; // never answer, to exercise the timeout
      return reply(id, {
        userAgent: 'fake-codex/0.0.0',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      });

    case 'account/read':
      return reply(id, { account: state.account, requiresOpenaiAuth: true });

    case 'account/login/start': {
      state.loginId = randomUUID();
      if (params?.type === 'chatgptDeviceCode') {
        reply(id, {
          type: 'chatgptDeviceCode',
          loginId: state.loginId,
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        });
      } else {
        reply(id, { type: 'chatgpt', loginId: state.loginId, authUrl: 'https://auth.openai.com/fake' });
      }
      const delay = scenario.loginCompletesAfterMs ?? 50;
      const succeeds = scenario.loginSucceeds !== false;
      setTimeout(() => {
        if (succeeds) {
          state.account = { type: 'chatgpt', email: 'test@example.com', planType: 'plus' };
          notify('account/updated', { authMode: 'chatgpt', planType: 'plus' });
        }
        notify('account/login/completed', {
          loginId: state.loginId,
          success: succeeds,
          error: succeeds ? null : 'user cancelled',
        });
      }, delay);
      return undefined;
    }

    case 'account/login/cancel':
      return reply(id, { status: 'cancelled' });

    case 'account/logout':
      state.account = null;
      notify('account/updated', { authMode: null, planType: null });
      return reply(id, {});

    case 'account/rateLimits/read':
      if (scenario.rateLimits === null) return replyError(id, 'usage unavailable');
      return reply(
        id,
        scenario.rateLimits ?? {
          ordinaryUsageAllowed: true,
          rateLimits: {
            limitId: 'codex',
            limitName: null,
            primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
            credits: null,
            planType: 'plus',
            rateLimitReachedType: null,
            spendControlReached: false,
          },
          rateLimitsByLimitId: null,
          accountId: 'acct-1',
        },
      );

    case 'model/list':
      return reply(id, {
        data: scenario.models ?? [
          {
            id: 'fake-model-default',
            model: 'fake-model-default',
            displayName: 'Fake Default',
            description: 'test',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ effort: 'medium' }],
            inputModalities: ['text'],
          },
          {
            id: 'fake-model-fast',
            model: 'fake-model-fast',
            displayName: 'Fake Fast',
            description: 'test',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ effort: 'low' }],
            inputModalities: ['text'],
          },
        ],
        nextCursor: null,
      });

    case 'thread/start': {
      const threadId = `thread-${randomUUID()}`;
      state.threads.set(threadId, { params, injected: [] });
      notify('thread/started', { thread: { id: threadId } });
      return reply(id, {
        thread: { id: threadId },
        model: params?.model ?? 'fake-model-default',
        modelProvider: 'fake',
        cwd: params?.cwd ?? '/tmp',
        reasoningEffort: null,
      });
    }

    case 'thread/resume': {
      return reply(id, {
        thread: { id: params.threadId },
        model: 'fake-model-default',
        modelProvider: 'fake',
        cwd: '/tmp',
        reasoningEffort: null,
      });
    }

    case 'thread/inject_items': {
      const t = state.threads.get(params.threadId);
      if (t) t.injected.push(...params.items);
      return reply(id, {});
    }

    case 'turn/start': {
      const turnId = `turn-${randomUUID()}`;
      const threadId = params.threadId;
      const script = (scenario.turns ?? [])[state.turnIndex] ?? [{ text: 'ok' }];
      state.turnIndex += 1;
      reply(id, { turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null } });
      void runTurn(threadId, turnId, script);
      return undefined;
    }

    case 'turn/interrupt':
      return reply(id, {});

    default:
      return reply(id, {});
  }
}

async function runTurn(threadId, turnId, script) {
  let itemSeq = 0;
  for (const step of script) {
    if (step.sleepMs) await sleep(step.sleepMs);
    if (step.hang) return;

    if (step.text !== undefined) {
      const itemId = `msg-${++itemSeq}`;
      for (const chunk of chunkText(step.text)) {
        notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: chunk });
        await sleep(1);
      }
      notify('item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: itemId, text: step.text, phase: 'final_answer' },
        completedAtMs: Date.now(),
      });
    }

    if (step.reasoning !== undefined) {
      const itemId = `rs-${++itemSeq}`;
      notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId, delta: step.reasoning });
    }

    if (step.usage) {
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: { total: step.usage, last: step.usage },
      });
    }

    if (step.tool) {
      const callId = `exec-${randomUUID()}`;
      // This mirrors the real server: the turn blocks until the client answers.
      const result = await serverRequest('item/tool/call', {
        threadId,
        turnId,
        callId,
        namespace: null,
        tool: step.tool,
        arguments: step.input ?? {},
      });
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: callId,
          namespace: null,
          tool: step.tool,
          arguments: step.input ?? {},
          status: result?.success ? 'completed' : 'failed',
          success: result?.success ?? false,
          durationMs: 1,
        },
        completedAtMs: Date.now(),
      });
    }

    if (step.error) {
      notify('error', {
        threadId,
        turnId,
        error: { message: step.error },
        willRetry: step.willRetry === true,
      });
      if (step.willRetry !== true) return;
    }
  }

  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status: 'completed', error: null, items: [] },
  });
}

function chunkText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 8) out.push(text.slice(i, i + 8));
  return out.length ? out : [''];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
