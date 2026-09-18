import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';
import { bridgeLogDir, ensureDirSecure } from './paths.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Write JSON lines to `<state>/logs/codex-bridge.log`. */
  file?: boolean;
  /** Mirror to stderr (never stdout — stdout may be a protocol channel). */
  stderr?: boolean;
  name?: string;
}

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  child(name: string): Logger;
  readonly level: LogLevel;
  readonly logFile: string | null;
}

/** `CODEX_BRIDGE_DEBUG=1` forces debug level regardless of config. */
export function resolveLevel(configured?: LogLevel): LogLevel {
  const dbg = process.env['CODEX_BRIDGE_DEBUG'];
  if (dbg && dbg !== '0' && dbg.toLowerCase() !== 'false') return 'debug';
  const env = process.env['CODEX_BRIDGE_LOG_LEVEL']?.toLowerCase();
  if (env && env in LEVELS) return env as LogLevel;
  return configured ?? 'info';
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

class FileSink {
  private stream: fs.WriteStream | null = null;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  write(line: string): void {
    try {
      if (!this.stream) {
        ensureDirSecure(path.dirname(this.file));
        this.rotateIfNeeded();
        this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
        this.stream.on('error', () => {
          this.stream = null;
        });
      }
      this.stream.write(line);
    } catch {
      /* logging must never take the process down */
    }
  }

  private rotateIfNeeded(): void {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* file does not exist yet */
    }
  }
}

let sharedSink: FileSink | null = null;

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = resolveLevel(opts.level);
  const useFile = opts.file ?? true;
  const useStderr = opts.stderr ?? true;
  const name = opts.name ?? 'bridge';

  if (useFile && !sharedSink) sharedSink = new FileSink(path.join(bridgeLogDir(), 'codex-bridge.log'));
  const sink = useFile ? sharedSink : null;

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] > LEVELS[level]) return;
    const safeFields = fields ? (redact(fields) as Record<string, unknown>) : undefined;
    const entry = {
      ts: new Date().toISOString(),
      level: lvl,
      name,
      msg: typeof msg === 'string' ? msg : String(msg),
      ...(safeFields ?? {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    sink?.write(line);
    if (useStderr) {
      const prefix = `[${lvl}] ${name}:`;
      const extra = safeFields && Object.keys(safeFields).length ? ` ${JSON.stringify(safeFields)}` : '';
      process.stderr.write(`${prefix} ${entry.msg}${extra}\n`);
    }
  };

  const logger: Logger = {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (childName) => createLogger({ ...opts, name: `${name}.${childName}` }),
    level,
    logFile: sink?.file ?? null,
  };
  return logger;
}

/** A logger that discards everything — for tests. */
export function nullLogger(): Logger {
  const noop = (): void => undefined;
  const l: Logger = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => l,
    level: 'error',
    logFile: null,
  };
  return l;
}
