/**
 * Secret redaction for logs and error surfaces.
 *
 * The bridge never owns OAuth tokens — Codex does — but tokens can still pass
 * through our process in App Server payloads (e.g. `account/chatgptAuthTokens/refresh`).
 * Everything that is logged goes through here first.
 */

const SENSITIVE_KEY_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|id_token|accesstoken|refreshtoken|idtoken|client[-_]?secret|secret|password|passwd|session[-_]?token|bearer|openai[-_]?api[-_]?key|anthropic[-_]?api[-_]?key|auth[-_]?token|token|credentials|private[-_]?key)$/i;

/** Keys whose *values* are opaque secrets even if the key name looks benign. */
const SENSITIVE_PATH_HINT = /(^|\.)tokens(\.|$)|(^|\.)auth(\.|$)/i;

export const REDACTED = '[REDACTED]';

/** Patterns for secrets that appear inline in free text. */
const INLINE_PATTERNS: Array<[RegExp, string]> = [
  // JWTs (id_token / access_token)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // OpenAI-style refresh tokens
  [/\brt\.[A-Za-z0-9_.-]{16,}\b/g, REDACTED],
  // OpenAI API keys (sk-, sk-proj-, sk-svcacct-)
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // Anthropic API keys
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // GitHub tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  // Authorization header values embedded in text
  [/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, `$1${REDACTED}`],
];

/** Redact secrets that appear inline in a string. */
export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of INLINE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Deep-redact an arbitrary value for logging.
 *
 * - Keys matching {@link SENSITIVE_KEY_RE} are replaced wholesale.
 * - Every string is additionally scrubbed for inline secrets.
 * - Cycles are broken, and output is depth/size bounded so a log line can never
 *   blow up from a huge payload.
 */
export function redact(value: unknown, opts: { maxDepth?: number; maxStringLength?: number } = {}): unknown {
  const maxDepth = opts.maxDepth ?? 8;
  const maxStringLength = opts.maxStringLength ?? 2000;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number, path: string): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const s = redactString(v);
      return s.length > maxStringLength ? `${s.slice(0, maxStringLength)}…[+${s.length - maxStringLength} chars]` : s;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return '[Function]';
    if (typeof v !== 'object') return String(v);
    if (depth >= maxDepth) return '[Truncated]';
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);

    if (Array.isArray(v)) {
      const cap = 100;
      const arr = v.slice(0, cap).map((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      if (v.length > cap) arr.push(`[+${v.length - cap} more]`);
      return arr;
    }
    if (v instanceof Error) {
      return { name: v.name, message: redactString(v.message), stack: v.stack ? redactString(v.stack) : undefined };
    }

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (SENSITIVE_KEY_RE.test(k) || SENSITIVE_PATH_HINT.test(childPath)) {
        out[k] = typeof val === 'object' && val !== null ? redactSensitiveContainer(val) : REDACTED;
      } else {
        out[k] = walk(val, depth + 1, childPath);
      }
    }
    return out;
  };

  return walk(value, 0, '');
}

/** A sensitive *container* keeps its key names (useful for debugging) but loses every value. */
function redactSensitiveContainer(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(() => REDACTED);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = REDACTED;
    return out;
  }
  return REDACTED;
}

/** Redact HTTP headers, preserving the shape for debugging. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : typeof v === 'string' ? redactString(v) : v;
  }
  return out;
}
