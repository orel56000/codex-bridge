#!/usr/bin/env node
/**
 * Verify our hand-maintained Codex protocol types against the bindings the
 * installed Codex CLI generates for itself.
 *
 * A Codex upgrade that renames or removes a method should fail here, loudly, at
 * build time — not at runtime in front of a user.
 *
 *   node scripts/check-protocol.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROTOCOL_TS = path.join(ROOT, 'packages', 'codex-client', 'src', 'protocol.ts');

function findCodex() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  dirs.push(
    path.join(os.homedir(), '.codex', 'bin'),
    path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver'),
  );
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

const codex = findCodex();
if (!codex) {
  console.log('Codex is not installed; skipping the protocol check.');
  process.exit(0);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proto-'));
try {
  execFileSync(codex, ['app-server', 'generate-json-schema', '--experimental', '--out', out], {
    stdio: 'pipe',
  });
} catch (err) {
  console.error(`Could not generate Codex protocol bindings: ${err.message}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(path.join(out, 'ClientRequest.json'), 'utf8'));
const upstream = new Set();
for (const variant of schema.oneOf ?? schema.anyOf ?? []) {
  const method = variant?.properties?.method;
  const value = method?.const ?? (Array.isArray(method?.enum) ? method.enum[0] : null);
  if (value) upstream.add(value);
}

const source = fs.readFileSync(PROTOCOL_TS, 'utf8');
function listConst(name) {
  const block = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (!block) throw new Error(`${name} not found in protocol.ts`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const ours = listConst('CLIENT_REQUEST_METHODS');
const missing = ours.filter((m) => !upstream.has(m));

const notifSchema = JSON.parse(fs.readFileSync(path.join(out, 'ServerNotification.json'), 'utf8'));
const upstreamNotifs = new Set();
for (const variant of notifSchema.oneOf ?? notifSchema.anyOf ?? []) {
  const method = variant?.properties?.method;
  const value = method?.const ?? (Array.isArray(method?.enum) ? method.enum[0] : null);
  if (value) upstreamNotifs.add(value);
}
const missingNotifs = listConst('SERVER_NOTIFICATION_METHODS').filter((m) => !upstreamNotifs.has(m));

const reqSchema = JSON.parse(fs.readFileSync(path.join(out, 'ServerRequest.json'), 'utf8'));
const upstreamReqs = new Set();
for (const variant of reqSchema.oneOf ?? reqSchema.anyOf ?? []) {
  const method = variant?.properties?.method;
  const value = method?.const ?? (Array.isArray(method?.enum) ? method.enum[0] : null);
  if (value) upstreamReqs.add(value);
}
const missingReqs = listConst('SERVER_REQUEST_METHODS').filter((m) => !upstreamReqs.has(m));

fs.rmSync(out, { recursive: true, force: true });

const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
console.log(`Checked against ${version} (${codex})`);
console.log(`  client requests:      ${ours.length} used, ${upstream.size} available`);
console.log(`  server notifications: ${upstreamNotifs.size} available`);
console.log(`  server requests:      ${upstreamReqs.size} available`);

const problems = [
  ...missing.map((m) => `client request "${m}" no longer exists upstream`),
  ...missingNotifs.map((m) => `server notification "${m}" no longer exists upstream`),
  ...missingReqs.map((m) => `server request "${m}" no longer exists upstream`),
];

if (problems.length) {
  console.error('\nProtocol drift detected:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\nUpdate packages/codex-client/src/protocol.ts.');
  process.exit(1);
}

console.log('\n✓ Every method the bridge uses still exists in the installed Codex.');
