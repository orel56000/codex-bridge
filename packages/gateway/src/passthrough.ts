import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError } from '@codex-bridge/shared';
import type { BridgeConfig, Logger } from '@codex-bridge/shared';

/**
 * Anthropic passthrough.
 *
 * The bridge normally *translates* — Anthropic in, Codex out. This module does
 * the opposite of that: it forwards a request to Anthropic untouched and streams
 * the response back byte for byte.
 *
 * Why it exists: Claude Code Desktop in third-party inference mode can only be
 * pointed at ONE endpoint. Without this, choosing the gateway means giving up
 * Claude models entirely. With it, one gateway serves both and the model picker
 * can offer Opus, Fable and Codex side by side.
 *
 * The forwarded bytes are never inspected or rewritten. Anything this module
 * changed would be a translation bug waiting to happen, and there is nothing to
 * translate: both sides already speak the Anthropic API.
 */

export interface PassthroughCredential {
  /** `Authorization: Bearer` — a `claude setup-token` subscription token. */
  authToken: string | null;
  /** `x-api-key` — a console API key, billed separately. */
  apiKey: string | null;
}

/** Headers we refuse to forward: hop-by-hop, or ones we must set ourselves. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  // The gateway's own credential must never reach Anthropic.
  'authorization',
  'x-api-key',
]);

/** Response headers that describe OUR connection, not the upstream body. */
const STRIP_FROM_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

/**
 * Claude plan usage, as Anthropic reports it on every answered request.
 *
 * Worth knowing where this does NOT come from. The desktop's own meters read
 * `GET /api/organizations/<org>/usage` with a claude.ai session cookie, and the
 * agent-facing one reads `/api/oauth/usage` — but a `claude setup-token`
 * credential is scoped `user:inference` and gets
 * `403 oauth_scope_insufficient (requires user:profile)` from that endpoint.
 *
 * The `anthropic-ratelimit-unified-*` response headers carry the same windows
 * and need no extra scope, so they are read off responses we are already
 * forwarding. The cost is that it is only known once a Claude model has been
 * used at least once since the gateway started.
 */
export interface ClaudeUsageWindow {
  /** Anthropic's own number, passed through unchanged rather than rescaled. */
  utilization: number | null;
  /** Unix seconds when the window resets. */
  resetsAt: number | null;
  /** `allowed`, `rejected`, … — Anthropic's own word. */
  status: string | null;
}

export interface ClaudeUsage {
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  /** Which window Anthropic considers the binding one right now. */
  representativeClaim: string | null;
  /** Whether paid overage can absorb an exhausted window, and why not. */
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /** When these headers were seen. */
  observedAt: string;
}

export class AnthropicPassthrough {
  private readonly logger: Logger;
  private lastUsage: ClaudeUsage | null = null;

  constructor(
    private readonly config: BridgeConfig['anthropic'],
    logger: Logger,
  ) {
    this.logger = logger.child('passthrough');
  }

  get enabled(): boolean {
    return this.config.enabled && this.hasCredential;
  }

  /** The most recent plan usage Anthropic reported, or null if none yet. */
  get usage(): ClaudeUsage | null {
    return this.lastUsage;
  }

  /**
   * Read the unified rate-limit headers off an upstream response.
   *
   * Every field is optional: these headers are not part of the documented API
   * and Anthropic may stop sending them, in which case usage goes back to
   * "unknown" rather than to a stale or invented number.
   */
  private recordUsage(headers: Headers): void {
    const num = (name: string): number | null => {
      const raw = headers.get(name);
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const win = (prefix: string): ClaudeUsageWindow => ({
      utilization: num(`${prefix}-utilization`),
      resetsAt: num(`${prefix}-reset`),
      status: headers.get(`${prefix}-status`),
    });

    const fiveHour = win('anthropic-ratelimit-unified-5h');
    const sevenDay = win('anthropic-ratelimit-unified-7d');
    // Nothing usable in this response: keep whatever we knew before.
    if (fiveHour.utilization === null && sevenDay.utilization === null) return;

    this.lastUsage = {
      fiveHour,
      sevenDay,
      representativeClaim: headers.get('anthropic-ratelimit-unified-representative-claim'),
      overageStatus: headers.get('anthropic-ratelimit-unified-overage-status'),
      overageDisabledReason: headers.get('anthropic-ratelimit-unified-overage-disabled-reason'),
      observedAt: new Date().toISOString(),
    };
  }

  get hasCredential(): boolean {
    return Boolean(this.config.authToken || this.config.apiKey);
  }

  /** Why passthrough is unavailable, phrased for a user. */
  get unavailableReason(): string | null {
    if (!this.config.enabled) return 'Anthropic passthrough is turned off.';
    if (!this.hasCredential) {
      return 'No Anthropic credential. Run `claude setup-token` and give it to `codex-bridge anthropic --token`.';
    }
    return null;
  }

  private credentialHeaders(): Record<string, string> {
    // A subscription token is preferred: it uses the plan the user already
    // pays for, where an API key bills separately.
    if (this.config.authToken) {
      return {
        authorization: `Bearer ${this.config.authToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      };
    }
    return { 'x-api-key': this.config.apiKey as string };
  }

  /**
   * Forward a request to Anthropic and stream the response back.
   *
   * `body` is the already-read request body; the caller has to read it to route
   * on the model, so it is passed in rather than re-read from the socket.
   */
  async forward(req: IncomingMessage, res: ServerResponse, pathname: string, body: Buffer): Promise<void> {
    if (!this.enabled) {
      throw new BridgeError('unsupported', this.unavailableReason ?? 'Anthropic passthrough is unavailable.', {
        status: 503,
        anthropicType: 'api_error',
      });
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${pathname}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }
    Object.assign(headers, this.credentialHeaders());
    // The upstream beta header may already list oauth; avoid duplicating it.
    const beta = headers['anthropic-beta'];
    if (beta) headers['anthropic-beta'] = dedupeBetas(beta);

    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    req.on('aborted', onClose);
    req.on('close', onClose);

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: req.method ?? 'POST',
        headers,
        body: body.length ? body : undefined,
        signal: controller.signal,
        // A redirect would silently move the credential to another host.
        redirect: 'error',
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      throw new BridgeError('internal', `Could not reach Anthropic: ${(err as Error).message}`, {
        status: 502,
        anthropicType: 'api_error',
        cause: err,
      });
    } finally {
      req.off('aborted', onClose);
      req.off('close', onClose);
    }

    // Observed on the way past; the response itself is still forwarded whole.
    this.recordUsage(upstream.headers);

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) outHeaders[key] = value;
    });

    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } catch (err) {
      // A client that hangs up mid-stream is normal, not an error worth raising.
      this.logger.debug('passthrough stream ended early', { err });
      if (!res.writableEnded) res.end();
    }
  }

  /** Ask Anthropic for its model list, so the picker can show real Claude models. */
  async listModels(timeoutMs = 5_000): Promise<Array<Record<string, unknown>>> {
    if (!this.enabled) return [];
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`, {
        headers: {
          ...this.credentialHeaders(),
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        this.logger.debug('anthropic /v1/models failed', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
      return Array.isArray(body.data) ? body.data : [];
    } catch (err) {
      this.logger.debug('anthropic /v1/models unreachable', { err });
      return [];
    } finally {
      clearTimeout(t);
    }
  }
}

/** The outcome of actually asking Anthropic whether a credential works. */
export interface CredentialCheck {
  state: 'ok' | 'rejected' | 'unreachable' | 'absent';
  /** One line, safe to print: never contains any part of the credential. */
  detail: string;
  /** What the user should do about it, when there is something to do. */
  fix?: string;
}

/**
 * Verify an Anthropic credential by using it.
 *
 * "A credential is stored" and "a credential works" are different facts, and
 * only the second one matters. Reporting the first as if it were the second is
 * how this ends up green in `--status` and `doctor` while every Claude model is
 * quietly missing from the picker — which is exactly what happened here with a
 * well-formed `sk-ant-oat01…` token the API answered with
 * `401 OAuth access token is invalid`.
 *
 * So this sends a real request. It is the cheapest one available, and it is the
 * same call model discovery makes, so a pass here means discovery passes too.
 */
export async function verifyAnthropicCredential(
  cred: { authToken?: string | null; apiKey?: string | null; baseUrl?: string },
  timeoutMs = 8_000,
): Promise<CredentialCheck> {
  const authToken = cred.authToken || null;
  const apiKey = cred.apiKey || null;
  if (!authToken && !apiKey) {
    return {
      state: 'absent',
      detail: 'none stored',
      fix: 'Run `claude setup-token`, then `codex-bridge anthropic --token-stdin`.',
    };
  }

  const kind = authToken ? 'subscription token' : 'API key';
  const base = (cred.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const headers: Record<string, string> = authToken
    ? { authorization: `Bearer ${authToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
    : { 'x-api-key': apiKey as string };
  headers['anthropic-version'] = '2023-06-01';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/models?limit=1`, {
      headers,
      signal: controller.signal,
      redirect: 'error',
    });
    if (res.ok) return { state: 'ok', detail: `${kind} accepted by ${base}` };

    // Anthropic states the reason in the body; it is about the credential, not
    // about its value, so it is safe and much more useful than a bare code.
    let why = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      why = body?.error?.message ? ` — ${body.error.message}` : '';
    } catch {
      /* a non-JSON error body tells us nothing extra */
    }
    return {
      state: 'rejected',
      detail: `${kind} rejected with HTTP ${res.status}${why}`,
      fix:
        res.status === 401 || res.status === 403
          ? authToken
            ? 'The token is not valid. Mint a fresh one with `claude setup-token`, then store it with `codex-bridge anthropic --token-stdin` and paste it at the prompt — that path rejoins a token your terminal wrapped, which a plain copy-paste silently truncates.'
            : 'The API key is not valid. Check it in the Anthropic Console, or switch to a subscription token with `claude setup-token`.'
          : 'Anthropic refused the request; see the message above.',
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      state: 'unreachable',
      detail: aborted ? `no answer from ${base} within ${timeoutMs}ms` : `could not reach ${base}: ${(err as Error).message}`,
      fix: 'Check network access to api.anthropic.com; the credential itself was never tested.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function dedupeBetas(value: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',').map((p) => p.trim())) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(',');
}

/**
 * Does this model name belong to Anthropic rather than Codex?
 *
 * Deliberately conservative: only a name that is clearly NOT one of ours is
 * sent upstream, so a misclassification cannot silently bill an API key for
 * something the user expected Codex to serve.
 */
export function isAnthropicModel(model: string | undefined, isBridgeModel: (id: string) => boolean): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  // Our own ids are shaped like Claude ids on purpose — ask, don't pattern-match.
  if (isBridgeModel(name)) return false;
  if (name === 'codex' || name.startsWith('codex-')) return false;
  return /^claude[-.]/.test(name) || /^(opus|sonnet|haiku|fable|mythos)\b/.test(name);
}
