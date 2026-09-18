import type { ServerResponse } from 'node:http';
import type { BridgeError } from '@codex-bridge/shared';
import type { AnthropicErrorBody } from '@codex-bridge/shared';

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body).toString(),
    ...headers,
  });
  res.end(body);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

/** Render a BridgeError as an Anthropic API error, never leaking internals. */
export function sendAnthropicError(res: ServerResponse, err: BridgeError, requestId?: string): void {
  const payload: AnthropicErrorBody = {
    type: 'error',
    error: { type: err.anthropicType, message: err.userMessage },
    ...(requestId ? { request_id: requestId } : {}),
  };
  const headers: Record<string, string> = {};
  if (requestId) headers['request-id'] = requestId;
  if (err.retryAfterSeconds !== undefined) headers['retry-after'] = String(Math.ceil(err.retryAfterSeconds));
  sendJson(res, err.status === 499 ? 400 : err.status, payload, headers);
}
