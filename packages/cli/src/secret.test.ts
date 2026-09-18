import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSecret, readSecretStream } from './secret.js';

const ESC = String.fromCharCode(27);
const TOKEN = `sk-ant-oat01-${'A9_z-'.repeat(18)}AA`;

test('a plain one-line token is taken as-is', () => {
  assert.equal(extractSecret(`${TOKEN}\n`), TOKEN);
  assert.equal(extractSecret(`  ${TOKEN}  \n`), TOKEN);
});

test('a token copied from a wrapped terminal is rejoined, not truncated', () => {
  // This is the actual failure that cost hours: a ~100-character token shown in
  // a narrow pane is displayed wrapped, a selection of wrapped text carries the
  // line breaks with it, and reading only the first line stores a
  // well-formed-looking prefix that Anthropic rejects with
  // "OAuth access token is invalid" — with nothing anywhere saying it was cut.
  const wrapped = `${TOKEN.slice(0, 38)}\n${TOKEN.slice(38, 76)}\n${TOKEN.slice(76)}\n`;
  assert.notEqual(wrapped.split('\n')[0], TOKEN, 'the fixture must actually be wrapped');
  assert.equal(extractSecret(wrapped), TOKEN);
});

test('a token wrapped with indentation and CRLF still rejoins exactly', () => {
  const wrapped = `${TOKEN.slice(0, 40)}\r\n   ${TOKEN.slice(40)}\r\n`;
  assert.equal(extractSecret(wrapped), TOKEN);
});

test('a token piped in with the whole TUI around it is found', () => {
  const tui = [
    'Welcome to Claude Code v2.1.276',
    ' This will guide you through',
    ' long-lived (1-year) auth token setup',
    '',
    ' Your token:',
    `   ${TOKEN}`,
    '',
    ' Keep it secret.',
  ].join('\n');
  assert.equal(extractSecret(tui), TOKEN);
});

test('ANSI escapes from a piped TUI are stripped before matching', () => {
  const painted = `${ESC}[1m${ESC}[38;5;208m Token: ${ESC}[0m${TOKEN}${ESC}[0m\n`;
  assert.equal(extractSecret(painted), TOKEN);
});

test('when several token-shaped strings appear, the longest wins', () => {
  // A wrapped token sitting inside other output yields fragments; the whole
  // token is longer than any fragment, so length is the right tie-break.
  const noisy = `example: sk-ant-oat01-SHORTEXAMPLEVALUE00\nreal:\n${TOKEN}\n`;
  assert.equal(extractSecret(noisy), TOKEN);
});

test('an API key is handled the same way', () => {
  const key = `sk-ant-api03-${'Bq7-x'.repeat(16)}ZZ`;
  assert.equal(extractSecret(`${key.slice(0, 30)}\n${key.slice(30)}\n`), key);
});

test('empty input yields nothing, so the caller can complain', () => {
  assert.equal(extractSecret(''), '');
  assert.equal(extractSecret('   \n\n  \n'), '');
});

test('an unrecognised credential shape is passed through rather than refused', () => {
  // Anthropic is free to change its prefixes; the live check that runs next is
  // the real gate, and it reports a far better error than a guess here would.
  assert.equal(extractSecret('some-future-credential-format-9999\n'), 'some-future-credential-format-9999');
});

test('a prose line is not silently glued into one word', () => {
  assert.equal(extractSecret('No token was minted\n'), 'No token was minted');
});

/* ----------------------- reading it off the stream ------------------------ */

/** A stand-in for stdin that lets a test control how the paste is delivered. */
function fakeStream(): {
  stream: import('./secret.js').SecretStream;
  emit: (chunk: string) => void;
  end: () => void;
} {
  const listeners: Record<string, Array<(c?: string) => void>> = {};
  const stream = {
    setEncoding() {},
    on(event: string, fn: (c?: string) => void) {
      (listeners[event] ??= []).push(fn);
      return stream;
    },
    off(event: string, fn: (c?: string) => void) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      return stream;
    },
  };
  return {
    stream: stream as unknown as import('./secret.js').SecretStream,
    emit: (chunk: string) => listeners['data']?.forEach((f) => f(chunk)),
    end: () => listeners['end']?.forEach((f) => f()),
  };
}

test('a piped secret is read to EOF, never cut at a newline', async () => {
  const { stream, emit, end } = fakeStream();
  const p = readSecretStream(stream, { isTty: false });
  emit(`${TOKEN.slice(0, 30)}\n`);
  emit(`${TOKEN.slice(30)}\n`);
  end();
  assert.equal(await p, TOKEN);
});

test('a terminal paste arriving line by line is NOT truncated at the first line', async () => {
  // The regression that started all this. Some terminals deliver a multi-line
  // paste as several chunks; stopping at the first newline stores a prefix
  // that looks well-formed and is rejected by Anthropic with no explanation.
  const { stream, emit } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 40 });
  emit(`${TOKEN.slice(0, 38)}\n`);
  emit(`${TOKEN.slice(38, 76)}\n`);
  emit(`${TOKEN.slice(76)}\n`);
  assert.equal(await p, TOKEN);
});

test('a terminal paste arriving as one chunk is read whole', async () => {
  const { stream, emit } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 40 });
  emit(`${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}\n`);
  assert.equal(await p, TOKEN);
});

test('a single-line token plus Enter is read whole', async () => {
  const { stream, emit } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 40 });
  emit(`${TOKEN}\n`);
  assert.equal(await p, TOKEN);
});

test('the shape of the input so far is never used to decide it is complete', async () => {
  // The first line of a wrapped token matches "looks like a whole token", so
  // any completeness check on partial input recreates the truncation bug. Only
  // the quiet period is allowed to end a terminal read.
  const { stream, emit } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 40 });
  const firstLine = TOKEN.slice(0, 38);
  assert.match(firstLine, /^sk-ant-[A-Za-z0-9_-]{20,}$/, 'the fixture must look complete on its own');
  emit(`${firstLine}\n`);
  emit(`${TOKEN.slice(38)}\n`);
  assert.equal(await p, TOKEN);
});

test('an unrecognised credential is ended by a blank line, so it cannot hang', async () => {
  const { stream, emit } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 60_000 });
  emit('some-future-credential-format-9999\n');
  emit('\n');
  assert.equal(await p, 'some-future-credential-format-9999');
});

test('the stream is only ever resolved once', async () => {
  const { stream, emit, end } = fakeStream();
  const p = readSecretStream(stream, { isTty: true, idleMs: 20 });
  emit(`${TOKEN}\n`);
  end();
  end();
  assert.equal(await p, TOKEN);
});
