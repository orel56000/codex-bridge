import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from './config.js';
import { bridgeConfigFile } from './paths.js';

const ENV_KEYS = [
  'CODEX_BRIDGE_HOME',
  'CODEX_BRIDGE_PORT',
  'CODEX_BRIDGE_HOST',
  'CODEX_BRIDGE_MODEL',
  'CODEX_BRIDGE_LOG_LEVEL',
  'CODEX_BRIDGE_DEBUG',
  'CODEX_BRIDGE_REASONING_EFFORT',
  'CODEX_BRIDGE_ALLOW_NATIVE_TOOLS',
];
const saved = new Map<string, string | undefined>();

function isolate(): string {
  for (const k of ENV_KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-config-'));
  process.env['CODEX_BRIDGE_HOME'] = dir;
  return dir;
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

test('no configuration is required for normal usage', () => {
  isolate();
  const { config, source } = loadConfig();
  assert.equal(source, 'defaults');
  assert.equal(config.gateway.host, '127.0.0.1');
  assert.equal(config.gateway.port, 4141);
  assert.equal(config.codex.model, 'auto');
  // Codex must never be able to touch the machine unless asked.
  assert.equal(config.codex.allowNativeTools, false);
});

test('the gateway binds loopback by default', () => {
  isolate();
  assert.equal(DEFAULT_CONFIG.gateway.host, '127.0.0.1');
});

test('a config file overrides defaults and merges deeply', () => {
  const dir = isolate();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ gateway: { port: 5151 }, logging: { level: 'debug' } }),
  );
  const { config, source } = loadConfig();
  assert.equal(source, 'file');
  assert.equal(config.gateway.port, 5151);
  assert.equal(config.gateway.host, '127.0.0.1', 'untouched keys keep their defaults');
  assert.equal(config.logging.level, 'debug');
});

test('environment variables override the file', () => {
  const dir = isolate();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gateway: { port: 5151 } }));
  process.env['CODEX_BRIDGE_PORT'] = '6161';
  const { config, source } = loadConfig();
  assert.equal(source, 'file+env');
  assert.equal(config.gateway.port, 6161);
});

test('CODEX_BRIDGE_DEBUG forces debug logging', () => {
  isolate();
  process.env['CODEX_BRIDGE_DEBUG'] = '1';
  assert.equal(loadConfig().config.logging.level, 'debug');
});

test('invalid values are reported and replaced, never silently applied', () => {
  const dir = isolate();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gateway: { port: 99999 } }));
  const { config, warnings } = loadConfig();
  assert.equal(config.gateway.port, 4141);
  assert.ok(warnings.some((w) => /port/i.test(w)));

  process.env['CODEX_BRIDGE_PORT'] = 'not-a-port';
  const second = loadConfig();
  assert.ok(second.warnings.some((w) => /CODEX_BRIDGE_PORT/.test(w)));
});

test('a corrupt config file falls back to defaults with a warning', () => {
  const dir = isolate();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const { config, warnings } = loadConfig();
  assert.equal(config.gateway.port, 4141);
  assert.equal(warnings.length >= 1, true);
});

test('limits are clamped to a sane range', () => {
  const dir = isolate();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ gateway: { maxBodyBytes: 1, requestTimeoutMs: 1 }, session: { maxThreads: 0 } }),
  );
  const { config } = loadConfig();
  assert.ok(config.gateway.maxBodyBytes >= 64 * 1024);
  assert.ok(config.gateway.requestTimeoutMs >= 5_000);
  assert.ok(config.session.maxThreads >= 1);
});

test('saveConfig merges rather than replacing, and is owner-only', () => {
  isolate();
  saveConfig({ gateway: { port: 4242 } });
  saveConfig({ logging: { level: 'warn' } });
  const { config } = loadConfig();
  assert.equal(config.gateway.port, 4242);
  assert.equal(config.logging.level, 'warn');

  if (process.platform !== 'win32') {
    const mode = fs.statSync(bridgeConfigFile()).mode & 0o777;
    assert.equal(mode, 0o600, 'config may hold the gateway token');
  }
});

test('a non-loopback host is refused unless explicitly allowed', () => {
  const dir = isolate();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gateway: { host: '0.0.0.0' } }));
  const refused = loadConfig();
  assert.equal(refused.config.gateway.host, '127.0.0.1', 'must not silently expose the gateway');
  assert.ok(refused.warnings.some((w) => /loopback/i.test(w)));

  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ gateway: { host: '0.0.0.0', allowNonLoopback: true } }),
  );
  const allowed = loadConfig();
  assert.equal(allowed.config.gateway.host, '0.0.0.0');
  assert.ok(allowed.warnings.some((w) => /reachable from the network/i.test(w)));
});

test('the loopback aliases are all accepted', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const dir = isolate();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ gateway: { host } }));
    const { config, warnings } = loadConfig();
    assert.equal(config.gateway.host, host);
    assert.equal(warnings.length, 0, `${host} should not warn`);
  }
});

test('sign-in defaults keep the flow in the browser', () => {
  isolate();
  const { config } = loadConfig();
  // OpenAI's hosted success page, branded as ChatGPT, offers to open the
  // ChatGPT desktop app — a confusing detour from a CLI sign-in.
  assert.equal(config.codex.login.useHostedSuccessPage, false);
  assert.equal(config.codex.login.appBrand, 'codex');
});

test('the sign-in presentation can be put back to the ChatGPT branding', () => {
  const dir = isolate();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ codex: { login: { appBrand: 'chatgpt', useHostedSuccessPage: true } } }),
  );
  const { config } = loadConfig();
  assert.equal(config.codex.login.appBrand, 'chatgpt');
  assert.equal(config.codex.login.useHostedSuccessPage, true);
});
