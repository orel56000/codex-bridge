/**
 * Getting a credential off stdin in one piece.
 *
 * Its own module rather than part of `bin.ts` so it can be tested: importing
 * `bin.ts` runs the CLI.
 */

/** CSI sequences, then OSC sequences — a piped TUI is full of both. */
const ESC = String.fromCharCode(27);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, 'g');

const ANTHROPIC_SECRET = /sk-ant-[A-Za-z0-9_-]{20,}/g;
const WHOLE_SECRET = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * Pull a credential out of whatever arrived on stdin.
 *
 * Deliberately forgiving, because the two natural ways to supply a token both
 * produce something that is not a bare one-line string:
 *
 * 1. **A token copied from a terminal.** `claude setup-token` prints a ~100
 *    character token into a narrow pane, so it is *displayed* wrapped — and a
 *    selection of wrapped text carries the line breaks with it. Reading only
 *    the first line then stores a truncated token that still looks well-formed,
 *    and Anthropic answers every request with
 *    `401 OAuth access token is invalid`, with nothing anywhere saying it was
 *    cut short. That is the failure this function exists to prevent.
 * 2. **`claude setup-token | codex-bridge anthropic --token-stdin`.** The pipe
 *    carries the whole TUI: banner, URL, prompts, ANSI escapes, and the token
 *    somewhere inside.
 *
 * So: strip ANSI, try the input as one wrapped secret, and failing that go
 * looking for a secret inside surrounding noise. Nothing here is logged or
 * echoed; the value goes straight to the 0600 config.
 */
export function extractSecret(raw: string): string {
  const clean = raw.replace(CSI, '').replace(OSC, '');

  // Case 1: the whole input is one secret, possibly wrapped across lines.
  const joined = clean.replace(/\s+/g, '');
  if (WHOLE_SECRET.test(joined)) return joined;

  // Case 2: a secret sits inside other output. Prefer the longest match — a
  // wrapped token yields several short fragments, and the real one is longer.
  const matches = clean.match(ANTHROPIC_SECRET);
  if (matches?.length) {
    return matches.reduce((longest, m) => (m.length > longest.length ? m : longest));
  }

  // Case 3: a credential in a shape we do not recognise. Anthropic is free to
  // change its prefixes, so do not refuse it here — the live check that runs
  // next is the real gate, and it gives a far better error than a guess would.
  const firstLine = clean.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return joined.length && !firstLine.includes(' ') ? joined : firstLine;
}

export interface SecretStream {
  setEncoding(enc: string): unknown;
  on(event: 'data', fn: (chunk: string) => void): unknown;
  on(event: 'end' | 'close', fn: () => void): unknown;
  off?(event: string, fn: (...a: never[]) => void): unknown;
  removeListener?(event: string, fn: (...a: never[]) => void): unknown;
}

/**
 * Read a credential from a stream, tolerating a paste that arrives in pieces.
 *
 * The subtle part is knowing when the input has ended.
 *
 * A pipe is easy: read to EOF. A terminal has no EOF, so the obvious rule is
 * "stop at the first newline" — and that is wrong precisely when it matters. A
 * token long enough to wrap is pasted as wrapped text, and depending on the
 * terminal that arrives either as one chunk full of newlines or as several
 * chunks arriving line by line. Stopping at the first newline turns the second
 * case into a silently truncated token, which is the exact failure this whole
 * path exists to prevent.
 *
 * There is no sound "have I got it all yet?" test to lean on, either: the first
 * line of a wrapped token is itself a well-formed-looking token, so checking
 * the shape of the input so far just recreates the bug. What is reliable is
 * timing — a paste arrives as a burst, and a short quiet period means it is
 * over. So on a terminal we wait out that gap before deciding the input ended.
 * An empty line ends it immediately for anyone who does not want to wait.
 */
export function readSecretStream(
  stream: SecretStream,
  opts: { isTty: boolean; idleMs?: number } = { isTty: false },
): Promise<string> {
  const idleMs = opts.idleMs ?? 250;
  return new Promise<string>((resolve) => {
    const chunks: string[] = [];
    let idle: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      const off = (stream.off ?? stream.removeListener)?.bind(stream);
      off?.('data', onData as never);
      off?.('end', finish as never);
      off?.('close', finish as never);
      resolve(extractSecret(chunks.join('')));
    };

    const onData = (chunk: string): void => {
      chunks.push(String(chunk));
      if (!opts.isTty) return; // a pipe ends at EOF; nothing to guess
      if (!String(chunk).includes('\n')) return;

      // An empty line means "that was all of it", whatever shape it is.
      if (/\n[ \t]*\n[ \t]*$/.test(chunks.join(''))) {
        finish();
        return;
      }
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, idleMs);
    };

    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('close', finish);
  });
}
