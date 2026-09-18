#!/usr/bin/env node
/**
 * Install Codex Bridge for the current user.
 *
 *   node scripts/install.mjs            # build, record the CLI path, register the plugin
 *   node scripts/install.mjs --no-build
 *   node scripts/install.mjs --uninstall
 *
 * What it does, and nothing more:
 *  - builds the workspace (unless --no-build)
 *  - records the absolute CLI path so the plugin launcher can find it
 *  - registers this checkout as a local Claude Code plugin marketplace and installs
 *    the plugin from it
 *
 * It deliberately does NOT touch your Claude Code model/gateway settings — run
 * `/logincodex` (or `codex-bridge configure`) for that, so the change is something
 * you asked for rather than something an installer did behind your back.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const UNINSTALL = args.has('--uninstall');

function configRoot() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const BRIDGE_HOME = process.env.CODEX_BRIDGE_HOME || path.join(configRoot(), 'codex-bridge');
const INSTALL_RECORD = path.join(BRIDGE_HOME, 'install.json');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'bin.js');

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}

function tryRun(cmd, cmdArgs) {
  try {
    return { ok: true, out: run(cmd, cmdArgs) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
}

function clearPluginCache() {
  const dir = path.join(claudeConfigDir(), 'plugins', 'cache', 'codex-bridge', 'codex-bridge');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a stale cache entry is not worth failing the install over */
  }
}

function claudeBin() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

/**
 * Put `codex-bridge` on PATH.
 *
 * Every doc, every slash command and every error message this project prints
 * tells the user to run `codex-bridge …`. Recording the path to `bin.js` and
 * leaving it at that produces `zsh: command not found: codex-bridge`, which
 * makes all of that advice wrong.
 *
 * Returns the link path, or null with the reason printed by the caller.
 */
function linkCli() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const onPath = (process.env.PATH || '').split(sep).filter(Boolean).map((d) => path.resolve(d));

  // Prefer a per-user directory: no sudo, and nothing system-wide to clean up.
  const preferred = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin'),
    '/usr/local/bin',
  ].map((d) => path.resolve(d));

  const candidates = [
    ...preferred.filter((d) => onPath.includes(d)),
    ...onPath.filter((d) => d.startsWith(os.homedir())),
  ];

  for (const dir of [...new Set(candidates)]) {
    const link = path.join(dir, process.platform === 'win32' ? 'codex-bridge.cmd' : 'codex-bridge');
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Replace only our own link, never somebody else's binary.
      if (fs.existsSync(link)) {
        const owned =
          process.platform === 'win32'
            ? fs.readFileSync(link, 'utf8').includes(CLI)
            : fs.lstatSync(link).isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === CLI;
        if (!owned) continue;
        fs.rmSync(link, { force: true });
      }
      if (process.platform === 'win32') {
        // Symlinks need elevation on Windows; a shim does not.
        fs.writeFileSync(link, `@echo off\r\n"${process.execPath}" "${CLI}" %*\r\n`);
      } else {
        fs.chmodSync(CLI, 0o755);
        fs.symlinkSync(CLI, link);
      }
      return link;
    } catch {
      /* not writable, or a race — try the next candidate */
    }
  }
  return null;
}

function unlinkCli() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const removed = [];
  for (const dir of (process.env.PATH || '').split(sep).filter(Boolean)) {
    const link = path.join(dir, process.platform === 'win32' ? 'codex-bridge.cmd' : 'codex-bridge');
    try {
      if (!fs.existsSync(link)) continue;
      // Only ever remove a link we created, pointing at this checkout's CLI.
      const owned =
        process.platform === 'win32'
          ? fs.readFileSync(link, 'utf8').includes(CLI)
          : fs.lstatSync(link).isSymbolicLink() && path.resolve(dir, fs.readlinkSync(link)) === CLI;
      if (!owned) continue;
      fs.rmSync(link, { force: true });
      removed.push(link);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

if (UNINSTALL) {
  const claude = claudeBin();
  if (claude) {
    console.log(tryRun(claude, ['plugin', 'uninstall', 'codex-bridge@codex-bridge', '-y']).out.trim());
    console.log(tryRun(claude, ['plugin', 'marketplace', 'remove', 'codex-bridge']).out.trim());
  }
  try {
    fs.rmSync(INSTALL_RECORD, { force: true });
  } catch {}
  for (const link of unlinkCli()) console.log(`  removed ${link}`);
  console.log('\nRemoved the plugin, the command and the install record.');
  console.log('Your Claude Code settings were left alone; run "codex-bridge unconfigure" to undo those too.');
  process.exit(0);
}

console.log('Codex Bridge installer\n');

if (!args.has('--no-build')) {
  process.stdout.write('  building…  ');
  try {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'build']);
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    console.error(`${err.stdout ?? ''}${err.stderr ?? ''}`);
    process.exit(1);
  }
}

if (!fs.existsSync(CLI)) {
  console.error(`\nExpected the built CLI at ${CLI} but it is missing. Run: npm run build`);
  process.exit(1);
}

fs.mkdirSync(BRIDGE_HOME, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  INSTALL_RECORD,
  `${JSON.stringify({ cli: CLI, root: ROOT, installedAt: new Date().toISOString() }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`  cli path recorded in ${INSTALL_RECORD}`);

const link = linkCli();
if (link) {
  console.log(`  command installed at ${link}`);
} else {
  console.log('  could not put "codex-bridge" on PATH — no writable directory on it.');
  console.log(`  Add one yourself with:  ln -s ${CLI} ~/.local/bin/codex-bridge`);
}

const claude = claudeBin();
if (!claude) {
  console.log('\n  claude CLI not found on PATH — skipping plugin registration.');
  console.log('  Register it later with:');
  console.log(`    claude plugin marketplace add ${ROOT}`);
  console.log('    claude plugin install codex-bridge@codex-bridge --scope user -y');
} else {
  const validated = tryRun(claude, ['plugin', 'validate', path.join(ROOT, 'packages', 'plugin')]);
  console.log(`  validate: ${validated.out.trim().split('\n').pop()}`);

  if (!validated.ok) {
    console.error(`\nThe plugin manifest did not validate:\n${validated.out}`);
    process.exit(1);
  }

  // Force a clean refresh every time. Installing from a local directory COPIES
  // the plugin into a VERSION-KEYED cache, so re-installing the same version is
  // otherwise a no-op and the user keeps running the previous copy.
  const added = tryRun(claude, ['plugin', 'marketplace', 'add', ROOT]);
  if (!added.ok && !/already/i.test(added.out)) {
    console.error(`\nCould not register the marketplace:\n${added.out}`);
    process.exit(1);
  }
  tryRun(claude, ['plugin', 'marketplace', 'update', 'codex-bridge']);
  tryRun(claude, ['plugin', 'uninstall', 'codex-bridge@codex-bridge', '-y']);
  clearPluginCache();

  const installed = tryRun(claude, ['plugin', 'install', 'codex-bridge@codex-bridge', '--scope', 'user', '-y']);
  if (!installed.ok) {
    console.error(`\nPlugin installation failed:\n${installed.out}`);
    console.error('The CLI is still usable directly; see the path printed above.');
    process.exit(1);
  }
  console.log(`  plugin: ${installed.out.trim().split('\n').filter(Boolean).pop() ?? 'installed'}`);
}

console.log(
  [
    '',
    'Done. Next:',
    '',
    '  1. Start a new Claude Code session (plugins load at startup).',
    '  2. Run /logincodex and sign in with ChatGPT.',
    '  3. Start another session so Claude Code routes through the gateway.',
    '',
    'Everything is also available from a terminal:',
    link ? '  codex-bridge --help' : `  node ${CLI} --help`,
    '',
  ].join('\n'),
);
