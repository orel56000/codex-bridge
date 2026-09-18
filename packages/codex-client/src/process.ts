import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BridgeError, ERRORS, codexInstallHint, findCodexBinary, redactString } from '@codex-bridge/shared';
import type { Logger } from '@codex-bridge/shared';

export interface CodexProcessOptions {
  logger: Logger;
  /** Absolute path to `codex`. When omitted, resolved from PATH / known locations. */
  binPath?: string | null;
  /** Extra `-c key=value` overrides passed to the App Server. */
  configOverrides?: string[];
  /** Override CODEX_HOME for the child (defaults to inheriting ours). */
  codexHome?: string | null;
  /**
   * Deprecated and ignored.
   *
   * `CodexProcess` used to respawn the child on its own, but the JSON-RPC
   * connection is owned by the client, so the replacement had no peer: the
   * next request built ANOTHER process and the respawned one was orphaned.
   * Recovery now belongs to the client, which rebuilds process and connection
   * together on the next use.
   */
  autoRestart?: boolean;
  maxRestarts?: number;
}

/**
 * Safe `-c key=value` overrides applied to every App Server we start.
 *
 * The bridge is not a Codex session: the user's MCP servers, plugins and
 * web-search tool would show up as extra tools inside a Claude Code turn, where
 * Claude Code neither renders them nor gates them behind permissions. We turn
 * them off at the process level so a thread can never inherit them.
 */
export const ISOLATION_OVERRIDES: readonly string[] = [
  'mcp_servers={}',
  'plugins={}',
  'tools.web_search=false',
];

/** `-c` values must be `key=value` with a dotted-path key — never free-form shell. */
const CONFIG_OVERRIDE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_-]*)*=.*$/s;

export function validateConfigOverride(override: string): void {
  if (!CONFIG_OVERRIDE_RE.test(override)) {
    throw ERRORS.invalid(
      `Invalid Codex config override ${JSON.stringify(override)}. Expected dotted.key=value.`,
    );
  }
}

export interface CodexProcessEvents {
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }];
  restarted: [];
  stderr: [string];
}

/**
 * Owns the lifetime of one `codex app-server` child process.
 *
 * Never uses a shell, so no user-controlled string can become a command.
 */
export class CodexProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private restarts = 0;
  private readonly logger: Logger;
  readonly binPath: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly autoRestart: boolean;
  private readonly maxRestarts: number;
  /** Last few stderr lines, kept for crash diagnostics. Redacted on write. */
  private readonly stderrRing: string[] = [];

  constructor(opts: CodexProcessOptions) {
    super();
    this.logger = opts.logger.child('codex-process');
    const bin = opts.binPath ?? findCodexBinary();
    if (!bin) throw ERRORS.codexNotInstalled(codexInstallHint());
    this.binPath = bin;

    const overrides = [...ISOLATION_OVERRIDES, ...(opts.configOverrides ?? [])];
    for (const o of overrides) validateConfigOverride(o);
    this.args = ['app-server', ...overrides.flatMap((o) => ['-c', o])];

    this.env = { ...process.env };
    if (opts.codexHome) this.env['CODEX_HOME'] = opts.codexHome;
    // Never let the child think it is attached to an interactive terminal.
    this.env['NO_COLOR'] = '1';
    this.env['CI'] = this.env['CI'] ?? '';

    this.autoRestart = false;
    this.maxRestarts = opts.maxRestarts ?? 5;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get recentStderr(): string {
    return this.stderrRing.join('\n');
  }

  start(): ChildProcessWithoutNullStreams {
    if (this.child && this.running) return this.child;
    this.stopping = false;

    this.logger.debug('spawning Codex App Server', { bin: this.binPath, args: this.args });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.binPath, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
        windowsHide: true,
        // Explicitly never a shell.
        shell: false,
      });
    } catch (err) {
      throw new BridgeError('codex_start_failed', 'Could not start the Codex App Server.', {
        hint: `Tried: ${this.binPath}`,
        cause: err,
      });
    }

    child.on('error', (err) => {
      this.logger.error('Codex App Server process error', { err });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const safe = redactString(chunk);
      for (const line of safe.split('\n')) {
        if (!line.trim()) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
        this.logger.debug('codex stderr', { line });
        this.emit('stderr', line);
      }
    });

    child.on('exit', (code, signal) => {
      const expected = this.stopping;
      this.logger.info('Codex App Server exited', { code, signal, expected });
      this.child = null;
      this.emit('exit', { code, signal, expected });
      if (!expected && this.autoRestart && this.restarts < this.maxRestarts) {
        this.restarts += 1;
        const delay = Math.min(500 * 2 ** (this.restarts - 1), 10_000);
        this.logger.warn('Codex App Server exited unexpectedly; attempting restart', {
          attempt: this.restarts,
          delayMs: delay,
        });
        setTimeout(() => {
          if (this.stopping) return;
          try {
            this.start();
            this.emit('restarted');
          } catch (err) {
            this.logger.error('restart failed', { err });
          }
        }, delay).unref?.();
      }
    });

    this.child = child;
    return child;
  }

  /** Reset the restart budget after a healthy period. */
  markHealthy(): void {
    this.restarts = 0;
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.child = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        done();
        return;
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        done();
      }, timeoutMs);
      t.unref?.();
    });
  }
}
