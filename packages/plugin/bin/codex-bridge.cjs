#!/usr/bin/env node
/**
 * Launcher for the Codex Bridge CLI.
 *
 * Deliberately CommonJS. A plugin is copied into Claude Code's plugin cache,
 * which carries no package.json, so an extensionless file there is parsed as
 * CommonJS on every supported Node version. Writing this as ESM makes the
 * SessionStart hook and every slash command fail with "Cannot use import
 * statement outside a module".
 *
 * The same copying is why the CLI cannot be found by a path relative to this
 * file; it is resolved in order of decreasing explicitness instead.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configRoot() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function bridgeHome() {
  return process.env.CODEX_BRIDGE_HOME || path.join(configRoot(), 'codex-bridge');
}

/** Written by scripts/install.mjs; the authoritative answer. */
function fromInstallRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(bridgeHome(), 'install.json'), 'utf8'));
    if (typeof rec.cli === 'string' && fs.existsSync(rec.cli)) return rec.cli;
  } catch (err) {
    void err;
  }
  return null;
}

/** Works when the plugin is run in place from a checkout. */
function fromCheckout() {
  const candidate = path.resolve(__dirname, '..', '..', 'cli', 'dist', 'bin.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function fromPath() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    // Skip this plugin's own bin dir, which Claude Code prepends to PATH.
    if (path.resolve(dir) === path.resolve(__dirname)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, 'codex-bridge' + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (err) {
        void err;
      }
    }
  }
  return null;
}

const explicit = process.env.CODEX_BRIDGE_CLI;
const target =
  (explicit && fs.existsSync(explicit) ? explicit : null) || fromInstallRecord() || fromCheckout() || fromPath();

if (!target) {
  process.stderr.write(
    [
      'Codex Bridge is installed as a Claude Code plugin, but its CLI could not be found.',
      '',
      'Fix it by running the installer from the codex-bridge checkout:',
      '  npm install && npm run build && node scripts/install.mjs',
      '',
      'Or set CODEX_BRIDGE_CLI to the absolute path of packages/cli/dist/bin.js.',
      '',
    ].join('\n'),
  );
  process.exit(127);
}

const isJs = /\.(js|mjs|cjs)$/.test(target);
const child = spawn(
  isJs ? process.execPath : target,
  isJs ? [target].concat(process.argv.slice(2)) : process.argv.slice(2),
  { stdio: 'inherit', windowsHide: true },
);
child.on('exit', (code, signal) => process.exit(signal ? 1 : code === null ? 0 : code));
child.on('error', (err) => {
  process.stderr.write('Could not start the Codex Bridge CLI: ' + err.message + '\n');
  process.exit(127);
});
