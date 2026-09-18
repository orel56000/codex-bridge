import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { verifyAnthropicCredential } from './passthrough.js';

/** A stand-in for api.anthropic.com that records what it was sent. */
async function fakeAnthropic(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a missing credential is reported as absent, not as broken', async () => {
  const check = await verifyAnthropicCredential({});
  assert.equal(check.state, 'absent');
  assert.match(check.fix ?? '', /setup-token/);
});

test('a working credential is verified by using it, and sent the right way', async () => {
  let seen: http.IncomingHttpHeaders = {};
  let seenUrl = '';
  const srv = await fakeAnthropic((req, res) => {
    seen = req.headers;
    seenUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  try {
    const check = await verifyAnthropicCredential({ authToken: 'sk-ant-oat01-test', baseUrl: srv.url });
    assert.equal(check.state, 'ok');
    // A subscription token is a bearer with the oauth beta; without that header
    // Anthropic rejects it, so getting this wrong would look like a bad token.
    assert.equal(seen['authorization'], 'Bearer sk-ant-oat01-test');
    assert.equal(seen['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(seen['anthropic-version'], '2023-06-01');
    assert.match(seenUrl, /^\/v1\/models/);
  } finally {
    await srv.close();
  }
});

test('an API key is sent as x-api-key rather than as a bearer', async () => {
  let seen: http.IncomingHttpHeaders = {};
  const srv = await fakeAnthropic((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  try {
    const check = await verifyAnthropicCredential({ apiKey: 'sk-ant-api03-test', baseUrl: srv.url });
    assert.equal(check.state, 'ok');
    assert.equal(seen['x-api-key'], 'sk-ant-api03-test');
    assert.equal(seen['authorization'], undefined);
  } finally {
    await srv.close();
  }
});

test('a rejected credential says so, quoting Anthropic and never the secret', async () => {
  const srv = await fakeAnthropic((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'OAuth access token is invalid.' } }));
  });
  try {
    // This is the real failure this check exists for: a well-formed token that
    // the API does not accept. "Stored" must never be reported as "working".
    const secret = 'sk-ant-oat01-totally-invalid-but-well-formed';
    const check = await verifyAnthropicCredential({ authToken: secret, baseUrl: srv.url });
    assert.equal(check.state, 'rejected');
    assert.match(check.detail, /401/);
    assert.match(check.detail, /OAuth access token is invalid/);
    const printed = `${check.detail} ${check.fix ?? ''}`;
    assert.ok(!printed.includes(secret), 'the credential must never appear in output');
    assert.ok(!printed.includes('totally-invalid'), 'not even part of it');
  } finally {
    await srv.close();
  }
});

test('an unreachable upstream is unknown, not a verdict on the credential', async () => {
  // Port 1 on loopback refuses instantly; nothing was learned about the token.
  const check = await verifyAnthropicCredential({ authToken: 'sk-ant-oat01-test', baseUrl: 'http://127.0.0.1:1' }, 2_000);
  assert.equal(check.state, 'unreachable');
  assert.match(check.fix ?? '', /never tested/);
});

test('a non-JSON error body still produces a usable verdict', async () => {
  const srv = await fakeAnthropic((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  try {
    const check = await verifyAnthropicCredential({ apiKey: 'k', baseUrl: srv.url });
    assert.equal(check.state, 'rejected');
    assert.match(check.detail, /502/);
  } finally {
    await srv.close();
  }
});
