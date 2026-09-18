import { execFile } from 'node:child_process';
import type { BridgeConfig } from '@codex-bridge/shared';
import { codexInstallHint, detectClaudeCodeDesktop, findCodexBinary } from '@codex-bridge/shared';
import type { CodexAppServerClient } from '@codex-bridge/codex-client';
import type { ModelMapper } from './models.js';
import { verifyAnthropicCredential } from './passthrough.js';
import type { BridgeStatus } from './status.js';

/**
 * `/codex-doctor`
 *
 * Every check reports what it actually observed. A check that cannot determine
 * an answer says "unknown" rather than guessing, so a green report means the
 * setup really was verified.
 */

export type CheckState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it. Only set when the check is not `ok`. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  text: string;
}

const MIN_NODE_MAJOR = 20;

export async function runDoctor(opts: {
  config: BridgeConfig;
  client: CodexAppServerClient | null;
  models: ModelMapper | null;
  status: BridgeStatus | null;
}): Promise<DoctorReport> {
  const checks: Check[] = [];

  /* 1. Node */
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? 0);
  checks.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? { name: 'Node.js', state: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'Node.js',
          state: 'fail',
          detail: `v${process.versions.node}`,
          fix: `Codex Bridge needs Node ${MIN_NODE_MAJOR} or newer.`,
        },
  );

  /* 2. Codex installation */
  const bin = opts.config.codex.binPath ?? findCodexBinary();
  if (!bin) {
    checks.push({
      name: 'Codex installed',
      state: 'fail',
      detail: 'not found on PATH',
      fix: `Install Codex: ${codexInstallHint()}`,
    });
  } else {
    const version = await codexVersion(bin);
    checks.push({
      name: 'Codex installed',
      state: 'ok',
      detail: version ? `${version} (${bin})` : bin,
    });
  }

  /* 3. App Server */
  const appServerRunning = opts.client?.isRunning === true;
  checks.push(
    appServerRunning
      ? { name: 'Codex App Server', state: 'ok', detail: 'responding' }
      : {
          name: 'Codex App Server',
          state: bin ? 'fail' : 'unknown',
          detail: bin ? 'not running' : 'cannot check without Codex',
          fix: bin ? 'Run /codex-restart.' : undefined,
        },
  );

  /* 4. Authentication */
  const account = opts.status?.account;
  if (!appServerRunning) {
    checks.push({ name: 'ChatGPT authentication', state: 'unknown', detail: 'App Server not running' });
  } else if (account?.connected) {
    checks.push({
      name: 'ChatGPT authentication',
      state: 'ok',
      detail: `${account.authMethod}${account.email ? ` (${account.email})` : ''}`,
    });
    checks.push({
      name: 'Plan',
      state: account.plan ? 'ok' : 'unknown',
      detail: account.plan ?? 'not reported by Codex',
    });
  } else {
    checks.push({
      name: 'ChatGPT authentication',
      state: 'fail',
      detail: 'not connected',
      fix: 'Run /logincodex to sign in with ChatGPT.',
    });
  }

  /* 5. Gateway */
  const gw = opts.status?.gateway;
  checks.push(
    gw?.running
      ? { name: 'Gateway', state: 'ok', detail: `listening on ${gw.host}:${gw.port}` }
      : {
          name: 'Gateway',
          state: 'fail',
          detail: 'not listening',
          fix: 'Run /codex-start.',
        },
  );

  /* 6. Claude Code configuration */
  const cc = opts.status?.claudeCode;
  if (!cc) {
    checks.push({ name: 'Claude Code configuration', state: 'unknown', detail: 'not inspected' });
  } else if (!cc.baseUrl) {
    checks.push({
      name: 'Claude Code configuration',
      state: 'fail',
      detail: 'ANTHROPIC_BASE_URL is not set',
      fix: 'Run /logincodex, which writes it to your Claude Code settings.',
    });
  } else if (cc.pointsElsewhere) {
    checks.push({
      name: 'Claude Code configuration',
      state: 'warn',
      detail: `points at ${cc.baseUrl}${gw?.url ? `, this gateway is on ${gw.url}` : ''}`,
      fix: 'Run /codex-doctor --fix, or re-run /logincodex, then start a new Claude Code session.',
    });
  } else {
    checks.push({ name: 'Claude Code configuration', state: 'ok', detail: cc.baseUrl ?? '' });
  }

  /* 6b. Claude Code Desktop */
  const desktop = detectClaudeCodeDesktop();
  if (desktop.installed) {
    checks.push({
      name: 'Claude Code Desktop',
      state: 'warn',
      detail: 'installed — the Code tab does not read ANTHROPIC_BASE_URL',
      fix: 'In the desktop app: Help → Troubleshooting → Enable Developer Mode, then Developer → Configure Third-Party Inference, and point it at the gateway URL above. See docs/troubleshooting.md.',
    });
  }

  /* 7. Model availability */
  const models = opts.status?.model;
  if (!models || !models.available.length) {
    checks.push({
      name: 'Codex model',
      state: appServerRunning ? 'warn' : 'unknown',
      detail: 'no models reported',
      fix: appServerRunning ? 'Codex returned an empty model list; check your ChatGPT plan.' : undefined,
    });
  } else {
    checks.push({
      name: 'Codex model',
      state: 'ok',
      detail: `${models.resolved ?? models.available[0]?.id} (${models.available.length} available)`,
    });
  }

  /* 7b. Claude models alongside Codex */
  if (opts.config.anthropic.enabled) {
    const cred = await verifyAnthropicCredential({
      authToken: opts.config.anthropic.authToken,
      apiKey: opts.config.anthropic.apiKey,
      baseUrl: opts.config.anthropic.baseUrl,
    });
    // A stored credential is not a working one. Checking only that the file has
    // a value reports this green while the picker offers no Claude models.
    const state: CheckState =
      cred.state === 'ok' ? 'ok' : cred.state === 'unreachable' ? 'unknown' : cred.state === 'absent' ? 'warn' : 'fail';
    checks.push({
      name: 'Claude models (passthrough)',
      state,
      detail: cred.detail,
      ...(cred.fix && state !== 'ok' ? { fix: cred.fix } : {}),
    });
  }

  /* 8. End-to-end connectivity */
  if (appServerRunning && account?.connected && opts.client) {
    const probe = await probeCodex(opts.client);
    checks.push(probe);
  } else {
    checks.push({ name: 'Connectivity', state: 'unknown', detail: 'skipped (not connected)' });
  }

  const ok = checks.every((c) => c.state === 'ok' || c.state === 'unknown');
  return { ok, checks, text: renderReport(checks, ok) };
}

/** A single cheap round trip that proves the whole path works. */
async function probeCodex(client: CodexAppServerClient): Promise<Check> {
  try {
    const models = await client.listModels(true);
    if (!models.length) {
      return { name: 'Connectivity', state: 'warn', detail: 'Codex returned no models' };
    }
    return { name: 'Connectivity', state: 'ok', detail: 'Codex backend reachable' };
  } catch (err) {
    return {
      name: 'Connectivity',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Check your network connection, then run /codex-restart.',
    };
  }
}

function codexVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (stdout.trim().split('\n')[0] ?? null));
    });
  });
}

const GLYPH: Record<CheckState, string> = { ok: '✓', warn: '!', fail: '✗', unknown: '?' };

export function renderReport(checks: Check[], ok: boolean): string {
  const lines = ['Codex Bridge Doctor', ''];
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    lines.push(`${GLYPH[c.state]} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix) lines.push(`  ${' '.repeat(width)}  → ${c.fix}`);
  }
  lines.push('');
  const failures = checks.filter((c) => c.state === 'fail');
  const warnings = checks.filter((c) => c.state === 'warn');
  if (ok && !warnings.length) lines.push('Everything looks good.');
  else if (failures.length) lines.push(`${failures.length} problem${failures.length === 1 ? '' : 's'} to fix, listed above.`);
  else lines.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}; the bridge should still work.`);
  return lines.join('\n');
}
