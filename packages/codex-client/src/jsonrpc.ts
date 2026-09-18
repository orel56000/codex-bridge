import type { Readable, Writable } from 'node:stream';
import { BridgeError } from '@codex-bridge/shared';
import type { Logger } from '@codex-bridge/shared';
import type {
  JsonRpcErrorBody,
  JsonRpcMessage,
  JsonRpcRequest,
  RequestId,
} from './protocol.js';

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface JsonRpcConnectionOptions {
  input: Readable;
  output: Writable;
  logger: Logger;
  onNotification: NotificationHandler;
  onServerRequest: ServerRequestHandler;
  /** Guard against a runaway peer: refuse a single line above this size. */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Newline-delimited JSON-RPC over a duplex byte stream, as spoken by
 * `codex app-server` on stdio.
 *
 * Responsibilities kept deliberately narrow: framing, id correlation, and
 * dispatch. No knowledge of any Codex method lives here.
 */
export class JsonRpcConnection {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<RequestId, { resolve(v: unknown): void; reject(e: unknown): void; method: string }>();
  private closed = false;
  private closeReason: Error | null = null;
  private readonly maxLineBytes: number;

  constructor(private readonly opts: JsonRpcConnectionOptions) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    opts.input.setEncoding('utf8');
    opts.input.on('data', (chunk: string) => this.onData(chunk));
    opts.input.on('error', (err: Error) => this.close(err));
    opts.input.on('end', () => this.close(new BridgeError('codex_crashed', 'Codex App Server closed its output stream.')));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request and await its response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        this.closeReason ?? new BridgeError('codex_crashed', 'Codex App Server connection is closed.'),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      try {
        this.write({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ method, params });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason ?? new BridgeError('codex_crashed', 'Codex App Server connection closed.');
    for (const [, waiter] of this.pending) waiter.reject(this.closeReason);
    this.pending.clear();
  }

  private write(msg: JsonRpcRequest | { method: string; params?: unknown } | { id: RequestId; result: unknown } | { id: RequestId; error: JsonRpcErrorBody }): void {
    const line = `${JSON.stringify(msg)}\n`;
    this.opts.output.write(line);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxLineBytes) {
      const err = new BridgeError('codex_protocol_error', 'Codex App Server sent an oversized message.');
      this.close(err);
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // The App Server writes diagnostics to stderr, but be tolerant: a
      // non-JSON stdout line is logged and skipped rather than fatal.
      this.opts.logger.debug('non-JSON line on App Server stdout', { preview: line.slice(0, 200) });
      return;
    }

    const anyMsg = msg as unknown as Record<string, unknown>;
    const hasId = anyMsg['id'] !== undefined && anyMsg['id'] !== null;

    if (hasId && ('result' in anyMsg || 'error' in anyMsg)) {
      this.settle(anyMsg['id'] as RequestId, anyMsg);
      return;
    }
    if (hasId && typeof anyMsg['method'] === 'string') {
      void this.dispatchServerRequest(anyMsg['id'] as RequestId, anyMsg['method'], anyMsg['params']);
      return;
    }
    if (typeof anyMsg['method'] === 'string') {
      try {
        this.opts.onNotification(anyMsg['method'], anyMsg['params']);
      } catch (err) {
        this.opts.logger.warn('notification handler threw', { method: anyMsg['method'], err });
      }
      return;
    }
    this.opts.logger.debug('unrecognised App Server message', { preview: line.slice(0, 200) });
  }

  private settle(id: RequestId, msg: Record<string, unknown>): void {
    const waiter = this.pending.get(id);
    if (!waiter) {
      this.opts.logger.debug('response for unknown request id', { id });
      return;
    }
    this.pending.delete(id);
    if ('error' in msg && msg['error']) {
      const body = msg['error'] as JsonRpcErrorBody;
      waiter.reject(
        new BridgeError('codex_protocol_error', body.message || `Codex rejected ${waiter.method}.`, {
          cause: body,
        }),
      );
    } else {
      waiter.resolve(msg['result']);
    }
  }

  private async dispatchServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.opts.onServerRequest(method, params);
      this.write({ id, result: result ?? {} });
    } catch (err) {
      this.opts.logger.warn('server request handler failed', { method, err });
      this.write({
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : 'handler failed' },
      });
    }
  }
}
