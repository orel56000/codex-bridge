import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeError,
  bridgePidFile,
  bridgeLogDir,
  ensureDirSecure,
  writeFileSecure,
} from '@codex-bridge/shared';

/**
 * Gateway process management.
 *
 * Requirements this satisfies: start on demand, detect an existing process,
 * never start a duplicate, clean up stale PID files, and never leave an orphan
 * behind.
 */

export interface DaemonRecord {
  pid: number;
  port: number;
  host: string;
  url: string;
  token: string;
  startedAt: number;
  version: string;
}

export function readDaemonRecord(): DaemonRecord | null {
  const file = bridgePidFile();
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as DaemonRecord;
    if (typeof rec.pid !== 'number' || typeof rec.port !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

export function writeDaemonRecord(rec: DaemonRecord): void {
  // The record carries the gateway token, so it is owner-readable only.
  writeFileSecure(bridgePidFile(), `${JSON.stringify(rec, null, 2)}\n`);
}

export function clearDaemonRecord(): void {
  try {
    fs.rmSync(bridgePidFile(), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Prove the recorded PID is still *our* gateway before signalling it.
 *
 * PIDs are recycled. After a hard kill or a reboot the record can name a PID
 * that now belongs to the user's editor or database, and SIGTERM-then-SIGKILL
 * on that is an unacceptable way to fail. A healthy /health answer is proof; so
 * is a command line that names our entrypoint.
 */
export function isOurGateway(rec: DaemonRecord): boolean {
  if (!isProcessAlive(rec.pid)) return false;
  if (process.platform === 'win32') {
    // No cheap, dependency-free command-line read here, so require the
    // stronger evidence: only signal a PID that answered /health.
    return false;
  }
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(rec.pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return out.includes('bin.js') && out.includes('serve');
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ask the running gateway whether it is healthy. Proves it is *our* process. */
export async function probeGateway(rec: DaemonRecord, timeoutMs = 3_000): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${rec.host}:${rec.port}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok' || body.status === 'degraded';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface RunningGateway {
  record: DaemonRecord;
  healthy: boolean;
}

/** Find a live gateway, cleaning up a stale PID file if there is not one. */
export async function findRunningGateway(): Promise<RunningGateway | null> {
  const rec = readDaemonRecord();
  if (!rec) return null;
  if (!isProcessAlive(rec.pid)) {
    clearDaemonRecord();
    return null;
  }
  const healthy = await probeGateway(rec);
  if (!healthy) {
    // The PID exists but is not answering: it may be starting, or the PID may
    // have been recycled by an unrelated process. Only reap it if the port is
    // definitely not ours.
    return { record: rec, healthy: false };
  }
  return { record: rec, healthy: true };
}

function selfEntrypoint(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url));
}

/** Start the gateway detached, and wait until it reports healthy. */
export async function startDaemon(opts: { timeoutMs?: number; cwd?: string } = {}): Promise<DaemonRecord> {
  const existing = await findRunningGateway();
  if (existing?.healthy) return existing.record;
  if (existing && !existing.healthy) await stopDaemon();

  ensureDirSecure(bridgeLogDir());
  const logPath = path.join(bridgeLogDir(), 'gateway.out.log');
  const out = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [selfEntrypoint(), 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, CODEX_BRIDGE_DAEMON: '1' },
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  let lastRecord: DaemonRecord | null = null;
  while (Date.now() < deadline) {
    await sleep(300);
    const rec = readDaemonRecord();
    if (rec && rec.pid !== lastRecord?.pid) lastRecord = rec;
    if (rec && (await probeGateway(rec, 1_500))) return rec;
    if (child.exitCode !== null && child.exitCode !== 0) break;
  }

  const tail = tailFile(logPath, 20);
  throw new BridgeError('codex_start_failed', 'The Codex Bridge gateway did not start.', {
    hint: tail ? `Last log lines:\n${tail}` : `See ${logPath}`,
  });
}

export async function stopDaemon(timeoutMs = 10_000): Promise<boolean> {
  const rec = readDaemonRecord();
  if (!rec) return false;
  if (!isProcessAlive(rec.pid)) {
    clearDaemonRecord();
    return false;
  }

  // Only signal a process we can prove is ours. If we cannot, drop the record
  // rather than risk killing whatever inherited the PID.
  const healthy = await probeGateway(rec, 1_500);
  if (!healthy && !isOurGateway(rec)) {
    clearDaemonRecord();
    return false;
  }

  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {
    clearDaemonRecord();
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isProcessAlive(rec.pid)) {
      clearDaemonRecord();
      return true;
    }
  }
  try {
    process.kill(rec.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  clearDaemonRecord();
  return true;
}

/**
 * Sleep that keeps the process alive.
 *
 * Deliberately NOT unref'd: every caller is awaiting a real outcome (the
 * gateway coming up, a sign-in finishing). An unref'd timer lets Node decide
 * the event loop is empty and exit silently with status 0 in the middle of the
 * wait, which surfaces as a command that prints nothing and "succeeds".
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tailFile(file: string, lines: number): string | null {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return null;
  }
}

/** Call a gateway admin endpoint with the daemon's own token. */
export async function callGateway<T>(
  rec: DaemonRecord,
  pathname: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`http://${rec.host}:${rec.port}${pathname}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${rec.token}`,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const message =
        (parsed as { error?: { message?: string } })?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new BridgeError('internal', message);
    }
    return parsed as T;
  } finally {
    clearTimeout(t);
  }
}
