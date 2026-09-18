import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-platform helpers. Everything here avoids a shell so that no
 * user-controlled string is ever interpolated into a command line.
 */

/**
 * Open a URL in the OS default browser.
 *
 * The URL is passed as an argv element (never through a shell), and is
 * validated to be http(s) first so a hostile `authUrl` cannot become a
 * command or a `file://` read.
 */
export async function openBrowser(url: string): Promise<{ ok: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Refusing to open a non-http(s) URL (${parsed.protocol}).` };
  }

  const href = parsed.toString();
  const attempts: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'open', args: [href] }]
      : process.platform === 'win32'
        ? // `start` is a cmd builtin; the empty string is the (required) window title.
          // href goes in its own argv slot, and cmd.exe metacharacters are rejected below.
          [{ cmd: 'cmd', args: ['/c', 'start', '', href] }]
        : [
            { cmd: 'xdg-open', args: [href] },
            { cmd: 'gio', args: ['open', href] },
            { cmd: 'wslview', args: [href] },
          ];

  if (process.platform === 'win32' && /[&|<>^"%]/.test(href)) {
    return { ok: false, error: 'URL contains characters that are unsafe to pass to the Windows shell.' };
  }

  let lastError = 'no opener available';
  for (const attempt of attempts) {
    const result = await runQuiet(attempt.cmd, attempt.args);
    if (result.ok) return { ok: true };
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

function runQuiet(cmd: string, args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
}

/** Directories that commonly hold a `codex` binary, in preference order. */
export function codexSearchPaths(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  const env = process.env['CODEX_BIN'];
  if (env) out.push(env);

  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (appData) {
      dirs.push(path.join(appData, 'npm'));
      out.push(path.join(appData, 'npm', 'codex.cmd'));
    }
    if (localAppData) {
      dirs.push(path.join(localAppData, 'Programs', 'codex'));
      dirs.push(path.join(localAppData, 'codex', 'bin'));
    }
  } else {
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.volta', 'bin'),
    );
  }

  // Codex's own home may carry a bundled binary (the desktop app ships one).
  const cHome = process.env['CODEX_HOME'] ?? path.join(home, '.codex');
  dirs.push(path.join(cHome, 'bin'), path.join(cHome, 'plugins', '.plugin-appserver'));

  for (const d of dirs) out.push(path.join(d, exe));
  return out;
}

/** Resolve `codex` from PATH or a well-known location. */
export function findCodexBinary(): string | null {
  for (const candidate of codexSearchPaths()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  // Always the BARE name on Windows: PATHEXT supplies `.cmd` / `.exe`, and an
  // npm-installed Codex is a `.cmd` shim, not a `.exe`.
  return whichSync('codex');
}

export function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A dependency-free `which`, using PATH / PATHEXT.
 *
 * On Windows the bare name is tried first and extensions are compared
 * case-insensitively. `npm install -g @openai/codex` produces
 * `%APPDATA%\npm\codex.cmd`, and a PATHEXT of `.COM;.EXE;.BAT;.CMD` in any
 * casing must still find it — otherwise the tool reports "Codex not found" and
 * tells the user to run the command they already ran.
 */
export function whichSync(bin: string): string | null {
  const pathEnv = process.env['PATH'] ?? process.env['Path'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  const lower = bin.toLowerCase();
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const name = ext && lower.endsWith(ext.toLowerCase()) ? bin : bin + ext;
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The command a user should run to install Codex, tailored to the platform. */
export function codexInstallHint(): string {
  return process.platform === 'win32'
    ? 'npm install -g @openai/codex'
    : 'npm install -g @openai/codex   (or: brew install --cask codex)';
}

/** True when the current process looks like it is inside Claude Code Desktop. */
export function detectClaudeCodeEnvironment(): 'desktop' | 'cli' | 'unknown' {
  const entrypoint = process.env['CLAUDE_CODE_ENTRYPOINT'];
  if (entrypoint === 'desktop' || entrypoint === 'claude-desktop') return 'desktop';
  if (process.env['CLAUDECODE'] === '1' || entrypoint) return 'cli';
  return 'unknown';
}

/**
 * Whether the Claude Code Desktop app is installed on this machine.
 *
 * The desktop app ships its own copy of Claude Code and, unlike the CLI, does
 * not take gateway routing from `ANTHROPIC_BASE_URL` or `settings.json` — it
 * overwrites those in the child environment and reads its own third-party
 * inference configuration instead. Diagnostics need to say so rather than
 * reporting a green check that will not apply there.
 */
export function detectClaudeCodeDesktop(): { installed: boolean; path: string | null } {
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')]
      : process.platform === 'win32'
        ? [path.join(process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')]
        : [path.join(home, '.config', 'Claude', 'claude-code')];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { installed: true, path: c };
    } catch {
      /* unreadable is the same as absent for our purposes */
    }
  }
  return { installed: false, path: null };
}
