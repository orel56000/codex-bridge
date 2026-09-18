#!/usr/bin/env node
import process from 'node:process';
import {
  BridgeError,
  BRIDGE_VERSION,
  createLogger,
  detectClaudeCodeEnvironment,
  ERRORS,
  loadConfig,
  openBrowser,
  saveConfig,
  toBridgeError,
  whichSync,
} from '@codex-bridge/shared';
import {
  Gateway,
  configureClaudeCode,
  gatewayEnv,
  readClaudeCodeConfig,
  runDoctor,
  settingsFileForScope,
  unconfigureClaudeCode,
  verifyAnthropicCredential,
  type BridgeStatus,
  type ConfigScope,
} from '@codex-bridge/gateway';
import {
  callGateway,
  clearDaemonRecord,
  findRunningGateway,
  sleep,
  startDaemon,
  stopDaemon,
  writeDaemonRecord,
  type DaemonRecord,
} from './daemon.js';
import { renderStatus, renderLoginSuccess, renderUsage } from './render.js';
import { readSecretStream, type SecretStream } from './secret.js';

/**
 * `codex-bridge` — the command surface behind the Claude Code plugin.
 *
 * Plugin slash commands shell out to exactly these subcommands, so everything a
 * user can do from Claude Code is also doable from a terminal.
 */

const HELP = `codex-bridge ${BRIDGE_VERSION}

Usage: codex-bridge <command> [options]

Commands:
  login [--device]     Connect a ChatGPT account through the Codex App Server
       [--start]       Begin sign-in and return immediately
       [--wait]        Wait for an in-flight sign-in to complete
  logout               Disconnect the ChatGPT account
  anthropic [--token-stdin | --from-env | --token <t> | --api-key <k>
             | --off | --status]
                       Also serve Claude models from this gateway, so one
                       model picker offers Opus, Fable AND Codex
  run [-- <args>]      Launch Claude Code on Codex for THIS session only
  env [--json]         Print the environment a Claude Code session needs
  status [--json]      Show connection, gateway and usage status
  usage [--json]       Plan usage for Claude and Codex, side by side
  doctor [--fix]       Diagnose the installation
  start                Start the gateway (no-op when already running)
  stop                 Stop the gateway
  restart              Restart the gateway
  serve                Run the gateway in the foreground (used by 'start')
  configure [--scope user|project]    Point Claude Code at the gateway
  unconfigure [--scope user|project]  Remove the bridge's Claude Code settings
  ui                   Open the local management page
  version              Print the version

Options:
  --json               Machine-readable output where supported
  --scope user|project Which settings file to write (default: user)
  --quiet              Suppress non-essential output

Signing in does not reconfigure Claude Code. "codex-bridge run" is the least
invasive way to use Codex: it affects one session and leaves everything else
on Claude.
`;

async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${BRIDGE_VERSION}\n`);
      return 0;

    case 'serve':
      return serve();

    case 'start':
      return start(json);

    case 'stop':
      return stop(json);

    case 'restart':
      await stopDaemon();
      return start(json);

    case 'status':
      return status(json);

    case 'doctor':
      return doctor(json, flags.has('--fix'));

    case 'login':
      if (flags.has('--start')) return loginStart(flags.has('--device'), json, flags.has('--if-needed'));
      if (flags.has('--wait')) return loginWait(json, timeoutArg(rest) ?? 600);
      return login(flags.has('--device'), json);

    case 'logout':
      return logout(json);

    case 'usage':
      return usage(json);
    case 'anthropic':
      return anthropic(rest, json);

    case 'run':
      return run(rest);

    case 'env':
      return printEnv(json);

    case 'configure':
      return configure(json, scopeArg(rest));

    case 'unconfigure':
      return unconfigure(json, scopeArg(rest));

    case 'ui':
      return openUi();

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

/* --------------------------------- serve --------------------------------- */

async function serve(): Promise<number> {
  // Refuse to become a second gateway. Without this, a race between two
  // `start` calls leaves one instance on 4141 and another on 4142, and half the
  // Claude Code sessions on the machine talk to the wrong one.
  const existing = await findRunningGateway();
  if (existing?.healthy) {
    process.stdout.write(`A Codex Bridge gateway is already running on ${existing.record.url}\n`);
    return 0;
  }

  const { config, warnings } = loadConfig();
  const logger = createLogger({ level: config.logging.level, file: config.logging.file, name: 'gateway' });
  for (const w of warnings) logger.warn(w);

  const gateway = new Gateway({ config, logger });
  const started = await gateway.start();

  const record: DaemonRecord = {
    pid: process.pid,
    port: started.port,
    host: config.gateway.host,
    url: started.url,
    token: started.authToken,
    startedAt: Date.now(),
    version: BRIDGE_VERSION,
  };
  writeDaemonRecord(record);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    clearDaemonRecord();
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // A crash must not leave a stale PID file claiming the gateway is up.
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', { err });
  });

  process.stdout.write(`Codex Bridge listening on ${started.url}\n`);
  // Keep the event loop alive for the lifetime of the server.
  await new Promise<void>(() => undefined);
  return 0;
}

/* ------------------------------ start / stop ------------------------------ */

async function start(json: boolean): Promise<number> {
  const existing = await findRunningGateway();
  if (existing?.healthy) {
    emit(json, { running: true, ...existing.record, alreadyRunning: true }, `Gateway already running on ${existing.record.url}`);
    return 0;
  }
  const rec = await startDaemon();
  emit(json, { running: true, ...rec, alreadyRunning: false }, `Gateway started on ${rec.url}`);
  return 0;
}

async function stop(json: boolean): Promise<number> {
  const stopped = await stopDaemon();
  emit(json, { stopped }, stopped ? 'Gateway stopped.' : 'Gateway was not running.');
  return 0;
}

/* --------------------------------- status -------------------------------- */

async function ensureRunning(): Promise<DaemonRecord> {
  const existing = await findRunningGateway();
  if (existing?.healthy) return existing.record;
  return startDaemon();
}

async function status(json: boolean): Promise<number> {
  const rec = await ensureRunning();
  const s = await callGateway<BridgeStatus>(rec, '/admin/status');
  if (json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(s)}\n`);
  }
  return s.account.connected ? 0 : 1;
}

/**
 * `codex-bridge usage`
 *
 * Exits 0 whenever it could report something, including "nothing observed
 * yet" — a usage check is not a health check, and failing it would make it
 * useless in a shell prompt or a watch loop.
 */
async function usage(json: boolean): Promise<number> {
  const rec = await ensureRunning();
  const s = await callGateway<BridgeStatus>(rec, '/admin/status');
  if (json) {
    process.stdout.write(`${JSON.stringify({ claude: s.claudeUsage, codex: s.usage }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderUsage(s)}\n`);
  }
  return 0;
}

/* --------------------------------- doctor -------------------------------- */

async function doctor(json: boolean, fix: boolean): Promise<number> {
  const { config } = loadConfig();
  let rec: DaemonRecord | null = null;
  try {
    rec = await ensureRunning();
  } catch (err) {
    // The gateway itself failing to start is exactly what doctor should report,
    // so fall back to the offline checks rather than propagating.
    const offline = await runDoctor({ config, client: null, models: null, status: null });
    process.stdout.write(`${offline.text}\n\nGateway: ${toBridgeError(err).userMessage}\n`);
    return 1;
  }

  const result = await callGateway<{ report: string; ok: boolean }>(rec, '/admin/doctor', { method: 'POST' });
  if (fix) {
    const applied = configureClaudeCode({ baseUrl: rec.url, authToken: rec.token });
    if (applied.changed) {
      process.stdout.write(`Updated ${applied.settingsPath}. Start a new Claude Code session to pick it up.\n\n`);
    }
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.report}\n`);
  return result.ok ? 0 : 1;
}

/* ---------------------------------- auth --------------------------------- */

interface LoginStatusResponse {
  login: {
    loginId: string;
    kind: 'browser' | 'deviceCode';
    url: string;
    userCode?: string;
    status: 'pending' | 'success' | 'failed';
    error: string | null;
  } | null;
  connected: boolean;
  account: BridgeStatus['account'];
}

/**
 * Begin a login and return immediately.
 *
 * The plugin's `/logincodex` command runs this inline (where a long-running
 * command would be killed by the prompt-build timeout) and then waits in a
 * separate step.
 */
async function loginStart(device: boolean, json: boolean, ifNeeded: boolean): Promise<number> {
  const rec = await ensureRunning();
  const before = await callGateway<BridgeStatus>(rec, '/admin/status');

  // `--if-needed` is for scripts and the SessionStart hook: don't disturb a
  // working session. A person running /logincodex is asking to sign in, and may
  // well be doing it to switch to a different ChatGPT account, so being told
  // "already connected" and nothing else is unhelpful.
  if (before.account.connected && ifNeeded) {
    emit(
      json,
      { alreadyConnected: true, startedLogin: false, account: before.account },
      [
        '✓ Already connected to OpenAI',
        `Account: ${before.account.email ?? 'signed in'}`,
        `Plan: ChatGPT ${before.account.plan ?? 'unknown'}`,
      ].join('\n'),
    );
    return 0;
  }

  const started = await callGateway<{
    kind: 'browser' | 'deviceCode';
    url: string;
    userCode?: string;
    browserOpened: boolean;
  }>(rec, '/admin/login', {
    method: 'POST',
    body: { mode: device ? 'deviceCode' : 'browser', switchAccount: before.account.connected },
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { alreadyConnected: before.account.connected, startedLogin: true, previous: before.account, ...started },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (before.account.connected) {
    process.stdout.write(
      [
        '',
        `Currently signed in as ${before.account.email ?? 'a ChatGPT account'} (${before.account.plan ?? 'unknown plan'}).`,
        'Starting a fresh sign-in so you can choose a different account.',
        'Signing in with the same account again is fine, and cancelling leaves the current one in place.',
        '',
      ].join('\n'),
    );
  }

  if (started.kind === 'deviceCode') {
    process.stdout.write(
      ['', 'Open this URL:', '', `  ${started.url}`, '', 'Code:', '', `  ${started.userCode ?? ''}`, ''].join('\n'),
    );
  } else if (started.browserOpened) {
    process.stdout.write(`\nOpening your browser to sign in with ChatGPT…\nIf it did not open: ${started.url}\n`);
  } else {
    process.stdout.write(`\nOpen this URL to sign in with ChatGPT:\n\n  ${started.url}\n`);
  }
  return 0;
}

/** Wait for an in-flight login to finish. */
async function loginWait(json: boolean, timeoutSeconds: number): Promise<number> {
  const rec = await ensureRunning();
  const deadline = Date.now() + timeoutSeconds * 1000;

  // When switching accounts the gateway is ALREADY connected, so `connected`
  // alone would return immediately with the old account. Wait for the pending
  // login itself to resolve whenever there is one.
  const initial = await callGateway<LoginStatusResponse>(rec, '/admin/login/status');
  const pending = initial.login?.status === 'pending';

  for (;;) {
    const s = await callGateway<LoginStatusResponse>(rec, '/admin/login/status');
    const done = pending ? s.login?.status === 'success' : s.connected;

    if (done) {
      const full = await callGateway<BridgeStatus>(rec, '/admin/status');
      if (json) {
        process.stdout.write(`${JSON.stringify({ connected: true, account: full.account }, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderLoginSuccess(full, false)}\n`);
        process.stdout.write(`\n${routingAdvice(rec, full)}\n`);
      }
      return 0;
    }

    if (s.login?.status === 'failed') {
      throw new BridgeError('login_failed', s.login.error ?? 'Sign-in did not complete.', {
        hint: 'Run /logincodex again, or /logincodex --device for the device-code flow.',
      });
    }
    if (Date.now() > deadline) {
      throw new BridgeError('timeout', 'Timed out waiting for the ChatGPT sign-in to finish.', {
        hint: 'Run /logincodex again when you are ready to complete it in the browser.',
      });
    }
    await sleep(2000);
  }
}

function scopeArg(args: string[]): ConfigScope {
  const i = args.indexOf('--scope');
  const value = i >= 0 ? args[i + 1] : undefined;
  if (value === 'project') return 'project';
  if (value === 'user') return 'user';
  if (args.includes('--project')) return 'project';
  return 'user';
}

function timeoutArg(args: string[]): number | null {
  const i = args.indexOf('--timeout');
  if (i < 0) return null;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function login(device: boolean, json: boolean): Promise<number> {
  const rec = await ensureRunning();

  const before = await callGateway<BridgeStatus>(rec, '/admin/status');
  if (before.account.connected && !json) {
    // Signing in while already signed in is how you switch ChatGPT accounts,
    // so say who you are and carry on rather than stopping here.
    process.stdout.write(
      [
        '',
        `Currently signed in as ${before.account.email ?? 'a ChatGPT account'} (${before.account.plan ?? 'unknown plan'}).`,
        'Starting a fresh sign-in so you can choose a different account.',
        'Cancel with Ctrl-C to keep the current one.',
        '',
      ].join('\n'),
    );
  }

  const { config } = loadConfig();
  const logger = createLogger({ level: config.logging.level, file: config.logging.file, name: 'login', stderr: false });

  // The login flow needs the App Server directly so it can await the
  // `account/login/completed` notification, which the HTTP surface cannot carry.
  const { CodexAppServerClient } = await import('@codex-bridge/codex-client');
  const client = new CodexAppServerClient({
    logger,
    binPath: config.codex.binPath,
    configOverrides: config.codex.configOverrides,
    login: {
      appBrand: config.codex.login.appBrand,
      useHostedSuccessPage: config.codex.login.useHostedSuccessPage,
    },
  });

  try {
    await client.initialize();
    const session = await client.startLogin(device ? 'deviceCode' : 'browser');

    if (session.kind === 'deviceCode') {
      process.stdout.write(
        [
          '',
          'Open this URL:',
          '',
          `  ${session.url}`,
          '',
          'Code:',
          '',
          `  ${session.userCode ?? ''}`,
          '',
          'Waiting for you to finish signing in…',
          '',
        ].join('\n'),
      );
    } else {
      const opened = await openBrowser(session.url);
      process.stdout.write(
        opened.ok
          ? '\nOpening your browser to sign in with ChatGPT…\n\nWaiting for you to finish signing in…\n'
          : `\nOpen this URL to sign in with ChatGPT:\n\n  ${session.url}\n\nWaiting for you to finish signing in…\n`,
      );
    }

    const outcome = await session.completed;
    if (!outcome.success) {
      throw new BridgeError('login_failed', outcome.error ?? 'Sign-in did not complete.', {
        hint: device ? 'Run /logincodex again to retry.' : 'Run /logincodex --device for the device-code flow.',
      });
    }

    const account = await client.getAccount(true);
    if (!account) throw new BridgeError('login_failed', 'Codex reported no account after sign-in.');

    await client.shutdown();

    // The gateway re-reads `account/read` on every request, so no restart is
    // needed for it to notice the new session.
    const after = await callGateway<BridgeStatus>(rec, '/admin/status');

    if (json) {
      process.stdout.write(`${JSON.stringify({ connected: true, account: after.account }, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${renderLoginSuccess(after, false)}\n`);
      process.stdout.write(`\n${routingAdvice(rec, after)}\n`);
    }
    return 0;
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

async function logout(json: boolean): Promise<number> {
  const existing = await findRunningGateway();
  if (existing?.healthy) {
    await callGateway(existing.record, '/admin/logout', { method: 'POST' });
  } else {
    const { config } = loadConfig();
    const logger = createLogger({ level: config.logging.level, file: config.logging.file, name: 'logout', stderr: false });
    const { CodexAppServerClient } = await import('@codex-bridge/codex-client');
    const client = new CodexAppServerClient({ logger, binPath: config.codex.binPath, autoRestart: false });
    try {
      await client.initialize();
      await client.logout();
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }
  emit(json, { disconnected: true }, '✓ Disconnected from OpenAI');
  return 0;
}

/* ------------------------------- passthrough ------------------------------ */

/**
 * Turn on (or off) serving Claude models alongside Codex from one gateway.
 *
 * Claude Code Desktop in third-party mode can only be pointed at a single
 * endpoint, so this is what lets one model picker offer Opus, Fable AND Codex.
 */
async function anthropic(args: string[], json: boolean): Promise<number> {
  const tokenIdx = args.indexOf('--token');
  const keyIdx = args.indexOf('--api-key');
  let token = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined;
  let apiKey = keyIdx >= 0 ? args[keyIdx + 1] : undefined;

  // Preferred paths: neither puts a long-lived credential into shell history.
  if (args.includes('--token-stdin')) {
    token = await readSecretFromStdin('Paste the token from `claude setup-token`, then press Enter:');
  }
  if (args.includes('--api-key-stdin')) {
    apiKey = await readSecretFromStdin('Paste your Anthropic API key, then press Enter:');
  }
  if (args.includes('--from-env')) {
    token = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? token;
    apiKey = process.env['ANTHROPIC_API_KEY'] ?? apiKey;
    if (!token && !apiKey) {
      throw ERRORS.invalid('Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set in this shell.');
    }
  }

  if (args.includes('--off')) {
    saveConfig({ anthropic: { enabled: false } });
    emit(json, { enabled: false }, '✓ Claude models will no longer be served by the gateway.');
    return 0;
  }

  if (args.includes('--status') || (!token && !apiKey)) {
    const { config } = loadConfig();
    const has = Boolean(config.anthropic.authToken || config.anthropic.apiKey);
    // Ask Anthropic, do not just look in the file: a stored-but-rejected
    // credential reads as "on" while serving no Claude models at all.
    const check = await verifyAnthropicCredential({
      authToken: config.anthropic.authToken,
      apiKey: config.anthropic.apiKey,
      baseUrl: config.anthropic.baseUrl,
    });
    const working = config.anthropic.enabled && check.state === 'ok';
    emit(
      json,
      {
        enabled: config.anthropic.enabled,
        hasCredential: has,
        credential: check.state,
        credentialDetail: check.detail,
        servingClaudeModels: working,
        baseUrl: config.anthropic.baseUrl,
      },
      [
        `Claude passthrough: ${working ? 'on' : config.anthropic.enabled ? 'enabled, but NOT working' : 'off'}`,
        `Credential:         ${check.state === 'ok' ? 'valid' : check.state} — ${check.detail}`,
        `Upstream:           ${config.anthropic.baseUrl}`,
        ...(check.fix ? ['', check.fix] : []),
        '',
        'To serve Claude models and Codex from one gateway:',
        '  claude setup-token                       # mints a 1-year token',
        '  codex-bridge anthropic --token-stdin     # paste it at the prompt',
        '',
        'Or use a console API key (billed separately):',
        '  codex-bridge anthropic --api-key-stdin',
        '',
        'Turn it off again with: codex-bridge anthropic --off',
      ].join('\n'),
    );
    return 0;
  }

  if (token !== undefined && (!token || token.startsWith('--'))) {
    throw ERRORS.invalid('--token needs a value. Run `claude setup-token` to mint one.');
  }
  if (apiKey !== undefined && (!apiKey || apiKey.startsWith('--'))) {
    throw ERRORS.invalid('--api-key needs a value.');
  }

  // Try it before trusting it. Storing a credential that does not work is
  // worse than storing none: the gateway reports Claude passthrough as on and
  // the model picker silently offers Codex only.
  const { config: current } = loadConfig();
  const check = await verifyAnthropicCredential({
    authToken: token ?? null,
    apiKey: apiKey ?? null,
    baseUrl: current.anthropic.baseUrl,
  });
  if (check.state === 'rejected') {
    const detail = check.detail.replace(/\.$/, '');
    throw ERRORS.invalid(`Anthropic ${detail}. Nothing was saved.${check.fix ? `\n\n${check.fix}` : ''}`);
  }
  if (check.state === 'unreachable') {
    process.stderr.write(`! Could not verify the credential: ${check.detail}\n  Saving it anyway; run \`codex-bridge anthropic --status\` once you are online.\n`);
  }

  // Written 0600 by saveConfig, and redacted from every log line.
  saveConfig({
    anthropic: {
      enabled: true,
      ...(token ? { authToken: token } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
  });

  const existing = await findRunningGateway();
  if (existing?.healthy) await stopDaemon();
  const rec = await startDaemon();

  emit(
    json,
    { enabled: true, credential: token ? 'subscription-token' : 'api-key', url: rec.url },
    [
      `✓ Claude models are now served alongside Codex from ${rec.url}`,
      `  Credential: ${token ? 'subscription token (your Claude plan)' : 'API key (billed separately)'}`,
      '',
      'Point Claude Code Desktop at this gateway and its picker will offer both.',
      'Codex no longer claims the opus/sonnet/haiku slots, so those stay Claude.',
    ].join('\n'),
  );
  return 0;
}

/**
 * Read a secret from stdin without echoing it.
 *
 * Passing a credential as an argv element leaks it into shell history and into
 * the process list; reading it here keeps it in memory until it is written to
 * the 0600 config.
 */
async function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const isTty = stdin.isTTY === true;
  if (isTty) {
    process.stderr.write(`${prompt}\n`);
    // Say so explicitly: a wrapped paste is the normal case, not a mistake.
    process.stderr.write('(a token your terminal wrapped over several lines is fine)\n');
  }
  if (isTty && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);

  const value = await readSecretStream(stdin as unknown as SecretStream, { isTty });
  if (!value) throw ERRORS.invalid('No token was provided on stdin.');
  return value;
}


/* -------------------------------- routing --------------------------------- */

/**
 * What to tell someone who has just signed in.
 *
 * Signing in deliberately does NOT reconfigure Claude Code: pointing
 * `~/.claude/settings.json` at the gateway takes over every session on the
 * machine, and there is no reliable way to un-take-it-over without a restart.
 * The per-session launcher has none of that, so it is what we recommend.
 */
function routingAdvice(rec: DaemonRecord, status: BridgeStatus): string {
  const lines = ['To use Codex in Claude Code, pick one:', ''];
  lines.push('  One session at a time (recommended — nothing else changes):');
  lines.push('    codex-bridge run                # opens Claude Code on Codex');
  lines.push('    codex-bridge run -- --continue  # extra args go to claude');
  lines.push('');
  lines.push('  This project only:');
  lines.push('    codex-bridge configure --scope project');
  lines.push('');
  lines.push('  Every Claude Code session on this machine:');
  lines.push('    codex-bridge configure --scope user');
  lines.push('');
  lines.push('Your Claude models keep working everywhere you have not opted in.');
  if (status.claudeCode.pointsElsewhere && status.claudeCode.baseUrl !== rec.url) {
    lines.push('');
    lines.push(`(Right now Claude Code points at ${status.claudeCode.baseUrl}.)`);
  }
  return lines.join('\n');
}

/**
 * Launch Claude Code against the gateway for ONE process.
 *
 * No settings file is touched, so a Codex window and a normal Claude window can
 * be open at the same time and neither can strand the other in a state that
 * needs a restart to undo.
 */
async function run(args: string[]): Promise<number> {
  const rec = await ensureRunning();
  const status = await callGateway<BridgeStatus>(rec, '/admin/status');
  if (!status.account.connected) throw ERRORS_NOT_CONNECTED();

  const claude = whichSync(process.platform === 'win32' ? 'claude' : 'claude');
  if (!claude) {
    throw new BridgeError('codex_not_installed', 'Could not find the `claude` executable on PATH.', {
      hint: 'Install Claude Code, or run it yourself with the environment printed by `codex-bridge env`.',
    });
  }

  const passthrough = args.filter((a) => a !== '--');
  const { spawn } = await import('node:child_process');
  const child = spawn(claude, passthrough, {
    stdio: 'inherit',
    env: { ...process.env, ...gatewayEnv({ baseUrl: rec.url, authToken: rec.token }) },
  });
  return new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
    child.on('error', () => resolve(127));
  });
}

/** Print the environment, for people who want to wire it up themselves. */
async function printEnv(json: boolean): Promise<number> {
  const rec = await ensureRunning();
  const env = gatewayEnv({ baseUrl: rec.url, authToken: rec.token });
  if (json) {
    process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
    return 0;
  }
  for (const [k, v] of Object.entries(env)) {
    process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`);
  }
  return 0;
}

function ERRORS_NOT_CONNECTED(): BridgeError {
  return new BridgeError('not_authenticated', 'Not connected to OpenAI.', {
    hint: 'Run /logincodex (or `codex-bridge login`) first.',
  });
}

/* ------------------------------- configure -------------------------------- */

async function configure(json: boolean, scope: ConfigScope): Promise<number> {
  const rec = await ensureRunning();
  const result = configureClaudeCode({ baseUrl: rec.url, authToken: rec.token, scope });
  const env = detectClaudeCodeEnvironment();
  emit(
    json,
    { ...result, scope, url: rec.url, environment: env },
    [
      result.changed
        ? `✓ Claude Code configured, ${scope} scope (${result.settingsPath})`
        : `✓ Already configured for ${scope} scope`,
      `  ANTHROPIC_BASE_URL=${rec.url}`,
      '',
      scope === 'user'
        ? 'This applies to EVERY Claude Code session on this machine. To undo:\n  codex-bridge unconfigure --scope user   (then restart Claude Code)'
        : 'This applies to this project only; other projects keep using Claude. To undo:\n  codex-bridge unconfigure --scope project',
      '',
      'Start a new Claude Code session for it to take effect.',
    ].join('\n'),
  );
  return 0;
}

async function unconfigure(json: boolean, scope: ConfigScope): Promise<number> {
  const result = unconfigureClaudeCode(settingsFileForScope(scope));
  emit(
    json,
    result,
    [
      result.changed
        ? `✓ Removed the bridge's settings from ${result.settingsPath}`
        : 'Nothing to remove.',
      ...(result.changed && scope === 'user'
        ? [
            '',
            'Restart Claude Code. Removing a key from settings.json does not unset it',
            'in an already-running process, so a live session keeps the old value.',
          ]
        : []),
    ].join('\n'),
  );
  return 0;
}

async function openUi(): Promise<number> {
  const rec = await ensureRunning();
  const opened = await openBrowser(rec.url);
  process.stdout.write(opened.ok ? `Opened ${rec.url}\n` : `Open ${rec.url} in your browser.\n`);
  return 0;
}

/* -------------------------------- plumbing -------------------------------- */

function emit(json: boolean, payload: unknown, text: string): void {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

/**
 * Wait for stdout and stderr to reach the other end.
 *
 * On POSIX, writes to a *pipe* are asynchronous. Plugin slash commands and the
 * end-to-end harness both capture this CLI's output through a pipe, so exiting
 * as soon as `main` resolves can silently truncate — or entirely drop — what we
 * just printed. Writing a zero-length chunk gives us a callback that fires once
 * everything queued before it has been flushed.
 */
async function flushOutput(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.writableEnded || stream.destroyed) {
            resolve();
            return;
          }
          stream.write('', () => resolve());
        }),
    ),
  );
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    const bridgeErr = toBridgeError(err);
    process.stderr.write(`\n${bridgeErr.userMessage}\n`);
    if (process.env['CODEX_BRIDGE_DEBUG'] && bridgeErr.stack) {
      process.stderr.write(`\n${bridgeErr.stack}\n`);
    }
    return 1;
  })
  .then(async (code) => {
    await flushOutput();
    process.exitCode = code;
    // `serve` never resolves, so reaching here means a one-shot command
    // finished. Exit explicitly: a partially-initialised gateway can leave a
    // child process or socket holding the event loop open forever.
    process.exit(code);
  });
