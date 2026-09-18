import type { AnthropicErrorType } from './anthropic.js';

/**
 * A bridge error that knows how to present itself two ways:
 *  - `userMessage`: short, actionable, safe to show a normal user.
 *  - as an Anthropic API error, so Claude Code can render it in-session.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status: number;
  readonly anthropicType: AnthropicErrorType;
  readonly hint?: string;
  readonly retryAfterSeconds?: number;
  override readonly cause?: unknown;

  constructor(
    code: BridgeErrorCode,
    message: string,
    opts: {
      status?: number;
      anthropicType?: AnthropicErrorType;
      hint?: string;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = opts.status ?? DEFAULTS[code].status;
    this.anthropicType = opts.anthropicType ?? DEFAULTS[code].anthropicType;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Short, user-facing text — never contains a stack trace or a token. */
  get userMessage(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message;
  }
}

export type BridgeErrorCode =
  | 'codex_not_installed'
  | 'codex_start_failed'
  | 'codex_crashed'
  | 'codex_protocol_error'
  | 'not_authenticated'
  | 'auth_expired'
  | 'login_failed'
  | 'login_cancelled'
  | 'rate_limited'
  | 'usage_limit_reached'
  | 'invalid_request'
  | 'request_too_large'
  | 'unsupported'
  | 'port_in_use'
  | 'gateway_not_running'
  | 'cancelled'
  | 'timeout'
  | 'internal';

const DEFAULTS: Record<BridgeErrorCode, { status: number; anthropicType: AnthropicErrorType }> = {
  codex_not_installed: { status: 503, anthropicType: 'api_error' },
  codex_start_failed: { status: 503, anthropicType: 'api_error' },
  codex_crashed: { status: 503, anthropicType: 'api_error' },
  codex_protocol_error: { status: 502, anthropicType: 'api_error' },
  not_authenticated: { status: 401, anthropicType: 'authentication_error' },
  auth_expired: { status: 401, anthropicType: 'authentication_error' },
  login_failed: { status: 401, anthropicType: 'authentication_error' },
  login_cancelled: { status: 400, anthropicType: 'invalid_request_error' },
  rate_limited: { status: 429, anthropicType: 'rate_limit_error' },
  usage_limit_reached: { status: 429, anthropicType: 'rate_limit_error' },
  invalid_request: { status: 400, anthropicType: 'invalid_request_error' },
  request_too_large: { status: 413, anthropicType: 'request_too_large' },
  unsupported: { status: 400, anthropicType: 'invalid_request_error' },
  port_in_use: { status: 503, anthropicType: 'api_error' },
  gateway_not_running: { status: 503, anthropicType: 'api_error' },
  cancelled: { status: 499, anthropicType: 'invalid_request_error' },
  timeout: { status: 504, anthropicType: 'api_error' },
  internal: { status: 500, anthropicType: 'api_error' },
};

export const ERRORS = {
  codexNotInstalled: (installHint: string) =>
    new BridgeError('codex_not_installed', 'Codex is not installed.', { hint: `Run: ${installHint}` }),

  notAuthenticated: () =>
    new BridgeError('not_authenticated', 'Not connected to OpenAI.', { hint: 'Run /logincodex to connect your ChatGPT account.' }),

  authExpired: () =>
    new BridgeError('auth_expired', 'Your ChatGPT authentication expired.', { hint: 'Run /logincodex to reconnect.' }),

  usageLimit: (retryAfterSeconds?: number, detail?: string) =>
    new BridgeError('usage_limit_reached', detail ?? 'Codex usage limit reached.', {
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(retryAfterSeconds !== undefined
        ? { hint: `Retry after: ${formatRetryAfter(retryAfterSeconds)}` }
        : {}),
    }),

  invalid: (message: string) => new BridgeError('invalid_request', message),

  tooLarge: (limitBytes: number) =>
    new BridgeError('request_too_large', `Request body exceeds the ${formatBytes(limitBytes)} limit.`),

  internal: (message: string, cause?: unknown) =>
    new BridgeError('internal', message, cause !== undefined ? { cause } : {}),
} as const;

export function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/** Coerce anything thrown into a BridgeError without leaking internals. */
export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  if (err instanceof Error) return new BridgeError('internal', err.message, { cause: err });
  return new BridgeError('internal', String(err), { cause: err });
}
