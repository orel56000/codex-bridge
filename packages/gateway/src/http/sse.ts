import type { ServerResponse } from 'node:http';
import type { AnthropicStreamEvent } from '@codex-bridge/shared';

/**
 * Anthropic-style SSE writer.
 *
 * Wire format per event:
 *
 *   event: content_block_delta\n
 *   data: {"type":"content_block_delta",...}\n
 *   \n
 */
export class SseWriter {
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly res: ServerResponse,
    opts: { requestId: string; pingIntervalMs?: number } = { requestId: '' },
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(opts.requestId ? { 'request-id': opts.requestId } : {}),
    });
    // Flush headers immediately so the client starts reading.
    res.flushHeaders?.();

    const interval = opts.pingIntervalMs ?? 15_000;
    if (interval > 0) {
      this.pingTimer = setInterval(() => this.ping(), interval);
      this.pingTimer.unref?.();
    }
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded;
  }

  write(event: AnthropicStreamEvent): void {
    if (this.isClosed) return;
    const payload = JSON.stringify(event);
    this.res.write(`event: ${event.type}\ndata: ${payload}\n\n`);
  }

  writeAll(events: AnthropicStreamEvent[]): void {
    for (const e of events) this.write(e);
  }

  ping(): void {
    if (this.isClosed) return;
    this.res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }

  /** Emit a terminal `error` event. Valid at any point in the stream. */
  error(type: string, message: string): void {
    if (this.isClosed) return;
    this.write({ type: 'error', error: { type, message } });
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!this.res.writableEnded) this.res.end();
  }
}
