#!/usr/bin/env node
/**
 * One command that sets up "Claude + Codex in one window".
 *
 *   npm run claudecodex
 *
 * It builds, starts the gateway, signs you into ChatGPT and into Claude, writes
 * the second Claude Desktop profile, launches it, and offers to install a
 * one-click launcher.
 *
 * Every step is idempotent and checks before it acts, so re-running it is the
 * supported way to repair a broken setup — there is no separate "fix" mode to
 * get out of sync.
 *
 * What this does NOT do: create accounts, or handle your passwords. Both logins
 * happen in your browser, in the official flows.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const args = new Set(process.argv.slice(2));
const ASSUME_YES = args.has('--yes') || args.has('-y');

/* --------------------------------- output --------------------------------- */

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code, s) => (useColor ? `\u001B[${code}m${s}\u001B[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);

let stepNo = 0;
const step = (title) => console.log(`\n${bold(`[${++stepNo}/9] ${title}`)}`);
const ok = (msg) => console.log(`  ${green('✓')} ${msg}`);
const warn = (msg) => console.log(`  ${yellow('!')} ${msg}`);
const info = (msg) => console.log(`  ${dim(msg)}`);
const fail = (msg) => {
  console.error(`\n${red('✗')} ${msg}\n`);
  process.exit(1);
};

async function ask(question, fallback = true) {
  if (ASSUME_YES) return fallback;
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question} ${fallback ? '[Y/n]' : '[y/N]'} `);
    const v = answer.trim().toLowerCase();
    if (!v) return fallback;
    return v === 'y' || v === 'yes';
  } finally {
    rl.close();
  }
}

/* -------------------------------- platform -------------------------------- */

/**
 * Everything that differs per OS, in one place.
 *
 * Two rules come from the app itself, not from convention, and getting either
 * wrong means it silently ignores everything this script writes:
 *
 * 1. **The profile directory name must end in `-3p`.** The app derives its own
 *    path as `userData.endsWith('-3p') ? userData : userData + '-3p'`, so a
 *    directory named anything else is abandoned and a sibling `<dir>-3p` is
 *    used instead. `CLAUDE_3P_PROFILE` is corrected rather than obeyed.
 * 2. **On Windows the path is not negotiable at all.** The app returns
 *    `join(LOCALAPPDATA, 'Claude-3p')` unconditionally, so `--user-data-dir`
 *    cannot move it. `%APPDATA%\Claude-3p` is the LEGACY location the app
 *    migrates away from — writing there is writing to a directory it renames.
 *
 * `CLAUDE_USER_DATA_DIR` is NOT how the profile is selected: a packaged build
 * deletes that variable from its own environment before anything reads it,
 * unless a request carries an Anthropic-signed token. `--user-data-dir` is the
 * switch that actually works, so that is the only one passed here.
 */
function ensure3pSuffix(dir) {
  return dir.endsWith('-3p') ? dir : `${dir}-3p`;
}

function platform() {
  const home = os.homedir();
  const env = (name) => process.env[name];

  if (process.platform === 'darwin') {
    return {
      name: 'macOS',
      profile: ensure3pSuffix(
        env('CLAUDE_3P_PROFILE') || path.join(home, 'Library', 'Application Support', 'Claude-3p'),
      ),
      appCandidates: [
        env('CLAUDE_APP'),
        '/Applications/Claude.app',
        path.join(home, 'Applications', 'Claude.app'),
      ].filter(Boolean),
      appLabel: 'Claude.app',
      launch(app, profile) {
        spawnSync('open', ['-na', app, '--args', `--user-data-dir=${profile}`], { stdio: 'ignore' });
      },
    };
  }

  if (process.platform === 'win32') {
    const local = env('LOCALAPPDATA') || path.join(home, 'AppData', 'Local');
    return {
      name: 'Windows',
      // Not configurable: the app hardcodes LOCALAPPDATA\Claude-3p on Windows,
      // so honouring CLAUDE_3P_PROFILE here would write somewhere it never reads.
      profile: path.join(local, 'Claude-3p'),
      appCandidates: [
        env('CLAUDE_APP'),
        path.join(local, 'AnthropicClaude', 'claude.exe'),
        path.join(local, 'Programs', 'Claude', 'Claude.exe'),
        path.join(env('PROGRAMFILES') || 'C:\\Program Files', 'Claude', 'Claude.exe'),
      ].filter(Boolean),
      appLabel: 'Claude.exe',
      launch(app, profile) {
        const child = spawn(app, [`--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' });
        child.unref();
      },
    };
  }

  return {
    name: 'Linux',
    profile: ensure3pSuffix(
      env('CLAUDE_3P_PROFILE') || path.join(env('XDG_CONFIG_HOME') || path.join(home, '.config'), 'Claude-3p'),
    ),
    appCandidates: [env('CLAUDE_APP'), '/usr/bin/claude-desktop', '/opt/Claude/claude', '/usr/local/bin/claude-desktop'].filter(
      Boolean,
    ),
    appLabel: 'the Claude desktop binary',
    launch(app, profile) {
      const child = spawn(app, [`--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' });
      child.unref();
    },
  };
}

const PLAT = platform();

function findApp() {
  for (const candidate of PLAT.appCandidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/* ---------------------------------- cli ----------------------------------- */

function bridge(argv, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    env: { ...process.env },
  });
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function bridgeJson(argv) {
  const { code, out } = bridge([...argv, '--json']);
  if (code !== 0) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/* --------------------------------- steps ---------------------------------- */

function stepBuild() {
  step('Build');
  if (fs.existsSync(CLI) && !args.has('--rebuild')) {
    ok('already built');
    info('pass --rebuild to force');
    return;
  }
  process.stdout.write('  compiling… ');
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    console.log(green('done'));
  } catch (err) {
    console.log(red('failed'));
    fail(`${err.stdout ?? ''}${err.stderr ?? ''}` || String(err));
  }
}

function stepGateway() {
  step('Gateway');
  const { code, out } = bridge(['start']);
  if (code !== 0) fail(`The gateway did not start.\n${out}`);
  const status = bridgeJson(['status']);
  const url = status?.gateway?.url ?? 'http://127.0.0.1:4141';
  ok(`listening on ${url}`);
  return url;
}

async function stepCodexLogin() {
  step('Sign in to ChatGPT (for Codex)');
  const status = bridgeJson(['status']);
  const account = status?.account;
  if (account?.connected) {
    ok(`already connected${account.email ? ` as ${account.email}` : ''}${account.plan ? ` (${account.plan})` : ''}`);
    return;
  }

  info('A browser window will open for the official ChatGPT sign-in.');
  info('Codex keeps the credentials; this bridge never sees your token.');
  if (!(await ask('Sign in now?', true))) {
    warn('skipped — Codex models will not work until you run: codex-bridge login');
    return;
  }

  const { code, out } = bridge(['login'], { inherit: true });
  if (code !== 0) fail(`ChatGPT sign-in failed.\n${out}`);
  const after = bridgeJson(['status']);
  if (!after?.account?.connected) fail('ChatGPT sign-in did not complete.');
  ok(`connected${after.account.email ? ` as ${after.account.email}` : ''}`);
}

async function stepAnthropicLogin() {
  step('Sign in to Claude (for Claude models)');
  const status = bridgeJson(['anthropic', '--status']);
  if (status?.credential === 'ok') {
    ok('credential valid');
    return true;
  }
  if (status?.credential === 'unreachable') {
    warn(`could not verify: ${status.credentialDetail}`);
    return true;
  }

  if (status?.credential === 'rejected') warn(`the stored credential is rejected: ${status.credentialDetail}`);
  else info('No Claude credential yet.');
  info('Without one the picker still works, but it will offer Codex models only.');

  if (!(await ask('Set one up now?', true))) {
    warn('skipped — add one later with: claude setup-token, then codex-bridge anthropic --token-stdin');
    return false;
  }

  // `claude setup-token` is an interactive TUI that opens a browser and waits
  // for a pasted code, so it is run inherited rather than captured. Piping its
  // stdout would take the UI away from the person who has to use it.
  console.log();
  info('Running `claude setup-token` — authorise in the browser, then copy the token it prints.');
  const claudeBin = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const minted = spawnSync(claudeBin, ['setup-token'], { stdio: 'inherit', shell: false });
  if (minted.error) {
    warn('Could not run `claude setup-token` — is Claude Code installed?');
    info('Install it, then run: claude setup-token && codex-bridge anthropic --token-stdin');
    return false;
  }

  console.log();
  info('Now paste that token. It is read from stdin, never from your shell history,');
  info('and a token your terminal wrapped over several lines is fine.');
  const stored = bridge(['anthropic', '--token-stdin'], { inherit: true });
  if (stored.code !== 0) {
    warn('The token was not stored. Re-run this script, or: codex-bridge anthropic --token-stdin');
    return false;
  }
  ok('Claude models enabled');
  return true;
}

function stepProfile(gatewayUrl) {
  step('Claude Desktop profile');

  const app = findApp();
  if (!app) {
    fail(
      [
        `Could not find ${PLAT.appLabel}. Looked in:`,
        ...PLAT.appCandidates.map((p) => `    ${p}`),
        '',
        '  Install Claude Desktop, or point at it:',
        `    CLAUDE_APP=/path/to/app npm run claudecodex`,
      ].join('\n'),
    );
  }
  ok(`found ${app}`);

  const token = bridgeJson(['status'])?.gateway?.token ?? readGatewayToken();
  if (!token) fail('Could not read the gateway token. Is the gateway running?');

  const dir = path.join(PLAT.profile, 'configLibrary');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const metaPath = path.join(dir, '_meta.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    /* first run, or a file we are about to replace anyway */
  }

  // Reuse the existing entry so the app keeps whatever else it has stored
  // against that id; only mint a new one on a genuinely fresh profile.
  const id = meta?.appliedId && typeof meta.appliedId === 'string' ? meta.appliedId : randomUUID();
  const configPath = path.join(dir, `${id}.json`);

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    /* fresh */
  }

  const updated = {
    ...config,
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: gatewayUrl,
    inferenceGatewayApiKey: token,
    inferenceCredentialKind: 'static',
    // The catalog rewrites every row's description and adds "1M" duplicates.
    modelCatalogEnabled: false,
    // Turns on Settings → Import, which can pull the sessions already on this
    // computer — including the ones from the normal Claude profile — into this
    // one. It copies; the originals are left where they are.
    claudeAiImport: {
      enabled: true,
      // Lets this profile produce a zip another install can import.
      exportEnabled: true,
      // Offer the import at the top of a new chat, but only when there really
      // are earlier sessions to import.
      bannerBehavior: 'detect',
    },
  };
  // Discovery reads the model list from the gateway, so a pinned list here would
  // only go stale — and a pinned entry carries no description, which puts the
  // app's canned tier blurbs back.
  delete updated.inferenceModels;

  fs.writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify({ appliedId: id, entries: [{ id, name: 'Default' }] }, null, 2)}\n`,
    { mode: 0o600 },
  );

  ok(`profile written to ${PLAT.profile}`);
  info('Separate from your normal Claude — same app, different settings and sessions.');
  return app;
}

function readGatewayToken() {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
        : process.env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state');
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'codex-bridge', 'run', 'gateway.json'), 'utf8')).token;
  } catch {
    return null;
  }
}

function stepLaunch(app) {
  step('Open it');
  PLAT.launch(app, PLAT.profile);
  ok('launching…');
  // A gateway profile boots straight in: the account is synthesised locally, so
  // there is no third sign-in beyond the two this script already did.
  info('Pick a model: Codex ones use your ChatGPT plan, Claude ones use your Claude plan.');
}

/**
 * Copy existing Claude Code sessions into the Codex profile.
 *
 * Runs BEFORE the app is launched, and that ordering is load-bearing: an open
 * instance holds every session in memory and rewrites the files from that copy
 * on the next change, which would silently undo the import.
 *
 * Never fatal. A failure here costs you a populated sidebar, not a working
 * setup, and the whole point of this script is that re-running it repairs
 * whatever did not take.
 */
async function stepImportSessions() {
  step('Bring your existing sessions across');

  const src = sessionNamespace(path.join(supportRoot(), 'Claude'));
  if (!src) {
    info('No existing Claude Code sessions found — nothing to import.');
    return;
  }
  const count = fs.readdirSync(src).filter((f) => f.startsWith('local_') && f.endsWith('.json')).length;
  if (!count) {
    info('No existing Claude Code sessions found — nothing to import.');
    return;
  }

  const dst = sessionNamespace(PLAT.profile);
  if (!dst) {
    // A profile that has never been opened has no account/org directory yet,
    // and that is where the records have to land.
    warn(`${count} sessions are ready to import, but this profile has not been opened yet.`);
    info('Re-run `npm run claudecodex` once it has started, and they will be copied over.');
    return;
  }

  const already = fs.readdirSync(dst).filter((f) => f.startsWith('local_')).length;
  if (already >= count) {
    ok(`${already} sessions already here`);
    return;
  }

  info(`${count} sessions in your normal Claude profile. This copies the records;`);
  info('the transcripts themselves are already shared by both, and are not touched.');
  if (!(await ask('Copy them across?', true))) {
    warn('skipped — run `node scripts/import-sessions.mjs` any time');
    return;
  }

  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'import-sessions.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    warn('Could not import the sessions.');
    info(`${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-3).join('\n  '));
    return;
  }
  const copied = /copied (\d+) session/.exec(res.stdout ?? '')?.[1] ?? '0';
  ok(`copied ${copied} sessions`);
}

function supportRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  return process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
}

/** `<profile>/claude-code-sessions/<account>/<org>/`, or null if not made yet. */
function sessionNamespace(profile) {
  const root = path.join(profile, 'claude-code-sessions');
  if (!fs.existsSync(root)) return null;
  const pick = (dir) => {
    const entries = fs
      .readdirSync(dir)
      .filter((e) => {
        try {
          return fs.statSync(path.join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    return entries[0] ? path.join(dir, entries[0]) : null;
  };
  const account = pick(root);
  return account ? pick(account) : null;
}

/* -------------------------------- launcher -------------------------------- */

async function stepLauncher(app) {
  step('One-click launcher');
  const made = { darwin: macLauncher, win32: winLauncher, linux: linuxLauncher }[process.platform];
  if (!made) {
    warn(`No launcher recipe for ${process.platform}.`);
    return;
  }
  if (!(await ask(`Install a one-click launcher for ${PLAT.name}?`, true))) {
    info(`Skipped. Re-open any time with: npm run claudecodex`);
    return;
  }
  try {
    made(app);
  } catch (err) {
    warn(`Could not install the launcher: ${err.message}`);
  }
}

/** The shared shell script both the CLI name and the .app/.desktop entry run. */
function writeUnixLauncherScript(app) {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, 'claudecodex');
  const script = `#!/bin/sh
# Open Claude with Codex Bridge. Generated by \`npm run claudecodex\`.
#
# Launched from a desktop icon this gets almost no environment — PATH is
# /usr/bin:/bin:/usr/sbin:/sbin, with neither node nor the bridge CLI on it — so
# nothing here may rely on PATH or on a shell profile being sourced.
set -eu
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

PROFILE="\${CLAUDE_3P_PROFILE:-${PLAT.profile}}"
APP="\${CLAUDE_APP:-${app}}"
CLI="${CLI}"

die() {
  echo "claudecodex: $1" >&2
  [ -n "\${CLAUDECODEX_QUIET:-}" ] && exit 1
  # There is no terminal when this runs from a desktop icon, so say it where it
  # shows — and each desktop has its own way of showing it.
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display alert \\"Claude + Codex\\" message \\"$1\\"" >/dev/null 2>&1 || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Claude + Codex" --text="$1" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Claude + Codex" "$1" >/dev/null 2>&1 || true
  fi
  exit 1
}

# Resolve node at RUN time, never at install time: baking in process.execPath
# pins a versioned path like /opt/homebrew/Cellar/node/26.4.0/bin/node, and the
# next \`brew upgrade node\` deletes it and breaks every desktop launch. The
# stable symlinks come first; the interpreter that ran the installer is only a
# last resort.
NODE=""
for candidate in \\
  "$(command -v node 2>/dev/null || true)" \\
  /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \\
  ${JSON.stringify(process.execPath)}
do
  [ -n "$candidate" ] && [ -x "$candidate" ] && NODE="$candidate" && break
done
[ -n "$NODE" ] || die "Node.js was not found. Codex Bridge needs Node 20 or newer."

[ -e "$APP" ] || die "Claude is not at $APP."
[ -f "$CLI" ] || die "Codex Bridge is not built. Re-run: npm run claudecodex"

# The gateway has to answer before the app probes it, or the picker comes up
# empty. \`start\` is a no-op when it is already up and waits until it responds.
"$NODE" "$CLI" start >/dev/null 2>&1 || die "The gateway did not start. Run: $NODE $CLI doctor"

${
  process.platform === 'darwin'
    ? `# \`open -n\` forces a NEW instance every time, and it is required here
# because a plain \`open -a\` would focus the DEFAULT-profile Claude and drop
# our --args entirely. So check for an existing instance first and just bring
# it forward, or clicking the icon twice leaves two windows on the same profile.
# grep -F: the profile path is a literal, and an unescaped one would be a regex.
RUNNING=$(ps -A -o pid=,ppid=,command= \\
  | grep -F -- "--user-data-dir=$PROFILE" \\
  | awk '$2 == 1 { print $1; exit }')
if [ -n "$RUNNING" ]; then
  osascript -e "tell application \\"System Events\\" to set frontmost of (first process whose unix id is $RUNNING) to true" >/dev/null 2>&1
  exit 0
fi

exec open -na "$APP" --args --user-data-dir="$PROFILE"`
    : `# Electron's single-instance lock lives in the profile directory, so a
# second launch with the same --user-data-dir focuses the first window.
exec "$APP" --user-data-dir="$PROFILE"`
}
`;
  fs.writeFileSync(target, script, { mode: 0o755 });
  return target;
}

function macLauncher(app) {
  const script = writeUnixLauncherScript(app);
  const appDir = path.join(os.homedir(), 'Applications', 'Claude + Codex.app');
  fs.mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'Contents', 'Resources'), { recursive: true });

  fs.writeFileSync(
    path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude + Codex</string>
  <key>CFBundleDisplayName</key><string>Claude + Codex</string>
  <key>CFBundleIdentifier</key><string>local.codex-bridge.claudecodex</string>
  <key>CFBundleExecutable</key><string>claudecodex</string>
  <key>CFBundleIconFile</key><string>appIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`,
  );
  // Old-style type/creator codes. Not strictly required any more, but
  // LaunchServices indexes a bundle more reliably with them present.
  fs.writeFileSync(path.join(appDir, 'Contents', 'PkgInfo'), 'APPL????');

  fs.writeFileSync(
    path.join(appDir, 'Contents', 'MacOS', 'claudecodex'),
    `#!/bin/sh\nexec ${JSON.stringify(script)}\n`,
    { mode: 0o755 },
  );

  // Borrow Claude's own icon so it is recognisable in the Dock and Spotlight.
  for (const icon of ['electron.icns', 'appIcon.icns']) {
    const src = path.join(app, 'Contents', 'Resources', icon);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(appDir, 'Contents', 'Resources', 'appIcon.icns'));
      break;
    }
  }

  // Touch + re-register so Spotlight sees it without a logout.
  fs.utimesSync(appDir, new Date(), new Date());
  spawnSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appDir],
    { stdio: 'ignore' },
  );

  ok(`installed ${appDir}`);
  info('Spotlight "Claude + Codex", or drag it to your Dock.');
  info(`Also on your PATH as: claudecodex`);
}

function linuxLauncher(app) {
  const script = writeUnixLauncherScript(app);
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'claudecodex.desktop');

  // Exec is quoted: a home directory with a space in it otherwise splits into
  // two arguments. `%` is doubled because the spec reserves it for field codes.
  const exec = `"${script.replace(/%/g, '%%')}"`;

  // Reuse Claude's own icon when one ships with the install, so the launcher is
  // recognisable rather than generic.
  let icon = '';
  for (const candidate of [
    path.join(path.dirname(app), 'resources', 'app.asar.unpacked', 'build', 'icon.png'),
    '/usr/share/icons/hicolor/256x256/apps/claude-desktop.png',
    '/usr/share/pixmaps/claude-desktop.png',
  ]) {
    if (fs.existsSync(candidate)) {
      icon = `Icon=${candidate}\n`;
      break;
    }
  }

  fs.writeFileSync(
    target,
    `[Desktop Entry]
Type=Application
Name=Claude + Codex
Comment=Claude Desktop routed through Codex Bridge
Exec=${exec}
${icon}Terminal=false
Categories=Development;Utility;
StartupWMClass=Claude
`,
    { mode: 0o644 },
  );
  spawnSync('update-desktop-database', [dir], { stdio: 'ignore' });
  ok(`installed ${target}`);
  info('Also on your PATH as: claudecodex');
}

function winLauncher(app) {
  // A .cmd rather than a .lnk: Node cannot write a shortcut without a
  // dependency, and driving PowerShell's WScript.Shell is one more thing to
  // fail on a locked-down machine. The tradeoff is real and worth stating — a
  // .cmd gets a generic icon and pins less predictably than a shortcut. It is
  // directly clickable, which is the part that matters.
  //
  // This one is UNTESTED: it was written from the app's own path-resolution
  // code, not from a Windows machine.
  const dir = path.join(
    process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'Claude + Codex.cmd');
  const bat = (p) => p.replace(/%/g, '%%');
  fs.writeFileSync(
    target,
    `@echo off
rem Open Claude with Codex Bridge. Generated by "npm run claudecodex".
rem The gateway must answer before the app probes it, or the picker is empty.
"${bat(process.execPath)}" "${bat(CLI)}" start >nul 2>&1
if errorlevel 1 (
  echo The Codex Bridge gateway did not start.
  echo Run: "${bat(process.execPath)}" "${bat(CLI)}" doctor
  pause
  exit /b 1
)
rem The app hardcodes LOCALAPPDATA\\Claude-3p on Windows, so --user-data-dir
rem only confirms what it would pick anyway.
start "" "${bat(app)}" --user-data-dir="${bat(PLAT.profile)}"
`,
  );
  ok(`installed ${target}`);
  info('It is in your Start Menu as "Claude + Codex" — right-click to pin it.');
}

/**
 * Last step: ask the bridge whether it still works.
 *
 * This exists for the long run rather than for today. Credentials expire, Codex
 * ships models a limit then hides, and Claude Desktop updates can change the
 * undocumented rules this whole integration is built on. Every one of those
 * fails silently — an empty picker, a stale banner, a model quietly missing.
 *
 * The doctor re-derives those rules from the app that is actually installed,
 * so re-running this script is a real check and not a reassuring no-op.
 */
function stepHealth() {
  step('Check it still works');
  const { code, out } = bridge(['doctor']);
  const lines = out.trimEnd().split('\n');

  const problems = lines.filter((l) => /^[✗!]/.test(l.trim()));
  if (!problems.length) {
    ok('everything checks out');
  } else {
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      if (/^\s*[✗!]/.test(line)) console.log(`  ${line.trim()}`);
      else if (/^\s+→/.test(line)) console.log(`    ${dim(line.trim())}`);
    }
  }
  if (code !== 0 && !problems.length) info(out.trimEnd().split('\n').slice(-1)[0]);
}

/* ---------------------------------- main ---------------------------------- */

console.log(bold('\nClaude + Codex\n'));
console.log(dim('  One Claude Desktop window offering both your Claude plan and Codex.'));
console.log(dim(`  Platform: ${PLAT.name}`));

stepBuild();
const gatewayUrl = stepGateway();
await stepCodexLogin();
await stepAnthropicLogin();
const app = stepProfile(gatewayUrl);
await stepImportSessions();
stepLaunch(app);
await stepLauncher(app);
stepHealth();

console.log(`\n${green(bold('Done.'))}\n`);
console.log('  Re-run this any time — it checks everything and repairs what is missing.');
console.log('  Worth re-running after a Claude Desktop update, or if models go missing:');
console.log(dim('    npm run claudecodex\n'));
