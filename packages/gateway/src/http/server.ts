import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, ERRORS, toBridgeError, redactHeaders } from '@codex-bridge/shared';
import type { Logger } from '@codex-bridge/shared';
import { sendAnthropicError, sendJson, sendText } from './respond.js';

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  logger: Logger;
}

export interface HttpServerOptions {
  host: string;
  port: number;
  logger: Logger;
  /** Shared secret Claude Code must present. `null` disables auth (not recommended). */
  authToken: string | null;
  /** Paths served without auth (health, the local UI, its admin API). */
  publicPaths?: string[];
}

/**
 * A dependency-free HTTP server for the gateway.
 *
 * Security posture:
 *  - binds a loopback address by default and refuses to bind a public one
 *    unless the operator explicitly asked for it;
 *  - rejects requests whose `Host` is not a loopback name, which is what stops
 *    a web page from reaching the gateway via DNS rebinding;
 *  - requires a bearer token on the API surface.
 */
export class GatewayHttpServer {
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];
  private server: Server | null = null;
  private readonly logger: Logger;
  private readonly opts: HttpServerOptions;
  private boundPort: number | null = null;

  constructor(opts: HttpServerOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('http');
  }

  get port(): number | null {
    return this.boundPort;
  }

  get address(): string | null {
    return this.boundPort === null ? null : `http://${formatHost(this.opts.host)}:${this.boundPort}`;
  }

  route(method: string, pattern: RegExp | string, handler: RouteHandler): this {
    const re = typeof pattern === 'string' ? new RegExp(`^${escapeRegExp(pattern)}$`) : pattern;
    this.routes.push({ method: method.toUpperCase(), pattern: re, handler });
    return this;
  }

  /**
   * Bind, walking forward from the configured port when it is taken.
   *
   * Returns the port actually used so the caller can tell the user about the
   * change instead of failing.
   */
  async listen(maxAttempts = 10): Promise<{ port: number; movedFrom: number | null }> {
    const start = this.opts.port;
    let lastError: unknown = null;

    for (let i = 0; i < maxAttempts; i += 1) {
      const port = start === 0 ? 0 : start + i;
      try {
        const bound = await this.tryListen(port);
        this.boundPort = bound;
        return { port: bound, movedFrom: i === 0 ? null : start };
      } catch (err) {
        lastError = err;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
      }
    }

    const code = (lastError as NodeJS.ErrnoException | null)?.code;
    if (code === 'EADDRINUSE') {
      throw new BridgeError('port_in_use', `Ports ${start}–${start + maxAttempts - 1} are all in use.`, {
        hint: 'Set "gateway.port" in the Codex Bridge config, or CODEX_BRIDGE_PORT.',
      });
    }
    throw new BridgeError('internal', `Could not bind ${this.opts.host}:${start}: ${String(code ?? lastError)}`, {
      cause: lastError,
    });
  }

  private tryListen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      // `requestTimeout` bounds how long we will spend RECEIVING a request; it
      // does not truncate a long streaming response, so a generous value is
      // safe and stops a half-written body from pinning a socket forever.
      server.requestTimeout = 120_000;
      server.headersTimeout = 60_000;
      server.keepAliveTimeout = 120_000;
      server.maxConnections = 256;
      server.on('error', (err) => {
        server.close();
        reject(err);
      });
      server.listen(port, this.opts.host, () => {
        const addr = server.address();
        this.server = server;
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const target = req.url ?? '/';

    // `//evil/path` is a protocol-relative URL: `new URL()` would resolve it
    // against a DIFFERENT host and hand us a pathname that has nothing to do
    // with what was requested. Reject anything that is not a plain,
    // already-normalised absolute path before it is parsed.
    if (!target.startsWith('/') || target.startsWith('//')) {
      sendText(res, 400, 'Bad request');
      return;
    }

    let url: URL;
    try {
      url = new URL(target, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    try {
      this.assertSafeHost(req);
      this.assertSanePath(url);
      this.assertSameOrigin(req, url);

      // Exact match only. A prefix match would silently make every future
      // sibling route public, which is how an admin API ends up unauthenticated.
      const isPublic = (this.opts.publicPaths ?? []).includes(url.pathname);
      if (!isPublic) this.assertAuthorized(req);

      const match = this.routes.find((r) => r.method === (req.method ?? 'GET').toUpperCase() && r.pattern.test(url.pathname));
      if (!match) {
        // Distinguish "no such route" from "wrong verb" — it makes a
        // misconfigured client much easier to diagnose.
        const pathExists = this.routes.some((r) => r.pattern.test(url.pathname));
        throw new BridgeError(
          pathExists ? 'invalid_request' : 'unsupported',
          pathExists ? `${req.method} is not supported for ${url.pathname}.` : `Unknown endpoint ${url.pathname}.`,
          { status: pathExists ? 405 : 404, anthropicType: pathExists ? 'invalid_request_error' : 'not_found_error' },
        );
      }

      await match.handler({ req, res, url, logger: this.logger });
    } catch (err) {
      const bridgeErr = toBridgeError(err);
      const level = bridgeErr.status >= 500 ? 'warn' : 'debug';
      this.logger[level]('request failed', {
        method: req.method,
        path: url.pathname,
        code: bridgeErr.code,
        status: bridgeErr.status,
        headers: redactHeaders(req.headers as Record<string, unknown>),
      });
      if (!res.headersSent) {
        sendAnthropicError(res, bridgeErr);
        // The client may still be uploading (an oversized body, or a request we
        // rejected early). Drain or drop it once the response is flushed so the
        // connection closes cleanly rather than resetting mid-upload.
        if (!req.readableEnded) {
          res.once('finish', () => req.destroy());
          req.resume();
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      this.logger.debug('request', {
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  }

  /**
   * Reject a path that has not been normalised.
   *
   * `//v1/messages` and `/..//v1/messages` reach the router as a different
   * string than the route it resembles, which is exactly the shape that turns
   * an authorisation check into a bypass.
   */
  private assertSanePath(url: URL): void {
    if (url.pathname.includes('//') || url.pathname.includes('/../') || url.pathname.includes('/./')) {
      throw new BridgeError('invalid_request', 'Malformed request path.', {
        status: 400,
        anthropicType: 'invalid_request_error',
      });
    }
  }

  /**
   * Reject cross-site requests.
   *
   * The loopback Host check is not enough on its own: a page on any website can
   * `fetch('http://localhost:4141/...', {mode:'no-cors'})`, which sends
   * `Host: localhost` and, being a CORS "simple request", is not preflighted —
   * so it reaches the handler and performs whatever it asks for. Browsers do
   * attach `Origin` and `Sec-Fetch-Site` to those requests, and a non-browser
   * client (Claude Code, curl) sends neither, so this costs legitimate callers
   * nothing.
   */
  private assertSameOrigin(req: IncomingMessage, url: URL): void {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      throw new BridgeError('unsupported', 'Cross-site requests are not allowed.', {
        status: 403,
        anthropicType: 'permission_error',
      });
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let ok = false;
      try {
        const parsed = new URL(origin);
        ok = parsed.host === url.host || isLoopbackHost(parsed.hostname);
      } catch {
        ok = false;
      }
      if (!ok) {
        throw new BridgeError('unsupported', 'Cross-origin requests are not allowed.', {
          status: 403,
          anthropicType: 'permission_error',
        });
      }
    }
  }

  /** Reject non-loopback Host headers so a browser page cannot reach us. */
  private assertSafeHost(req: IncomingMessage): void {
    if (!isLoopbackHost(this.opts.host)) return; // operator opted out of loopback-only
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '' || bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost')) {
      return;
    }
    throw new BridgeError('invalid_request', 'Request rejected: unexpected Host header.', {
      status: 403,
      anthropicType: 'permission_error',
    });
  }

  private assertAuthorized(req: IncomingMessage): void {
    const expected = this.opts.authToken;
    if (!expected) return;

    const header = req.headers.authorization;
    const bearer = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : null;
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : null;
    const presented = bearer ?? apiKey;

    if (!presented || !safeEqual(presented, expected)) {
      throw new BridgeError('not_authenticated', 'Missing or invalid gateway credentials.', {
        status: 401,
        anthropicType: 'authentication_error',
        hint: 'Claude Code must send the bridge token. Run /codex-doctor to repair the configuration.',
      });
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still compare something of equal length so the timing does not leak the
    // length of the expected token.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1';
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { sendJson, sendText, ERRORS };
