import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Cross-platform locations for the bridge's own (non-sensitive) state.
 *
 * We deliberately do NOT put anything credential-shaped here — Codex owns
 * `auth.json` and token refresh in its own CODEX_HOME.
 */

/** `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` on Linux. */
export function configRoot(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
}

/** `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, `$XDG_STATE_HOME` on Linux. */
export function stateRoot(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state');
}

export function bridgeHome(): string {
  const override = process.env['CODEX_BRIDGE_HOME'];
  if (override) return path.resolve(override);
  return path.join(configRoot(), 'codex-bridge');
}

export function bridgeStateDir(): string {
  const override = process.env['CODEX_BRIDGE_HOME'];
  if (override) return path.resolve(override);
  return path.join(stateRoot(), 'codex-bridge');
}

export const bridgeConfigFile = (): string => path.join(bridgeHome(), 'config.json');
export const bridgeLogDir = (): string => path.join(bridgeStateDir(), 'logs');
export const bridgeRunDir = (): string => path.join(bridgeStateDir(), 'run');
export const bridgePidFile = (): string => path.join(bridgeRunDir(), 'gateway.json');
export const bridgeSessionsFile = (): string => path.join(bridgeStateDir(), 'sessions.json');

/** The Codex home whose auth/config the App Server will use. Never written to by us. */
export function codexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
}

/** Create a directory with owner-only permissions where the platform supports it. */
export function ensureDirSecure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort — a pre-existing dir we do not own is not fatal */
    }
  }
}

/** Write a file with owner-only permissions, atomically. */
export function writeFileSecure(file: string, data: string): void {
  ensureDirSecure(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

/** Claude Code's user settings file. */
export function claudeSettingsFile(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) return path.join(path.resolve(configDir), 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function claudeConfigDir(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir) return path.resolve(configDir);
  return path.join(os.homedir(), '.claude');
}
