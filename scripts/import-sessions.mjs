#!/usr/bin/env node
/**
 * One-time copy of Claude Code sessions from the normal Claude profile into the
 * Codex Bridge one.
 *
 *   node scripts/import-sessions.mjs [--dry-run] [--force]
 *
 * This is a COPY, not a sync. Sessions you create afterwards in either profile
 * stay where they were made. Re-running it picks up anything new and, by
 * default, leaves records that already exist in the target alone — so a session
 * you renamed on the Codex side is not reverted by a later run (`--force`
 * overwrites instead).
 *
 * Why this is safe, and why it is so small:
 *
 * A session file holds only METADATA — title, cwd, model, timestamps, and a
 * `cliSessionId`. The conversation itself lives in
 * `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`, which sits outside both
 * profiles and is therefore ALREADY visible to both. So nothing here moves or
 * duplicates a transcript; it writes the small records that make sessions
 * appear in the sidebar and point at transcripts that were always shared.
 *
 * The source profile is opened read-only. Nothing in it is written, moved or
 * deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const FORCE = args.has('--force');

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const die = (msg) => {
  console.error(`\n${c('31', '✗')} ${msg}\n`);
  process.exit(1);
};

const SUPPORT =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local')
      : process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');

const SRC_PROFILE = path.join(SUPPORT, 'Claude');
// Not `Claude-3p`: a bridge profile there is where the NORMAL instance looks,
// so it would adopt the gateway config and stop being a separate instance.
const DST_PROFILE = path.join(SUPPORT, process.platform === 'win32' ? 'Claude-3p' : 'ClaudeCodex-3p');
const SESSIONS = 'claude-code-sessions';

/**
 * Find the one account/org namespace inside a profile's session store.
 *
 * The path is `<profile>/claude-code-sessions/<accountUuid>/<orgUuid>/`, and
 * both uuids differ between the two profiles — the Codex side runs under a
 * synthetic local org. They are discovered rather than hardcoded, because a
 * wrong guess would silently write into a directory the app never reads.
 */
function findNamespace(profile, { create = false } = {}) {
  const root = path.join(profile, SESSIONS);
  if (!fs.existsSync(root)) return null;
  const accounts = fs.readdirSync(root).filter((e) => fs.statSync(path.join(root, e)).isDirectory());
  if (accounts.length !== 1) {
    if (!accounts.length) return null;
    console.log(yellow(`  ! ${profile} has ${accounts.length} accounts; using the most recently used.`));
  }
  const account = accounts
    .map((a) => ({ a, t: fs.statSync(path.join(root, a)).mtimeMs }))
    .sort((x, y) => y.t - x.t)[0].a;

  const accountDir = path.join(root, account);
  const orgs = fs.readdirSync(accountDir).filter((e) => fs.statSync(path.join(accountDir, e)).isDirectory());
  if (!orgs.length) {
    if (!create) return null;
    return { account, org: null, dir: accountDir };
  }
  const org = orgs.sort(
    (x, y) => fs.statSync(path.join(accountDir, y)).mtimeMs - fs.statSync(path.join(accountDir, x)).mtimeMs,
  )[0];
  return { account, org, dir: path.join(accountDir, org) };
}

/** Is a Claude Desktop instance currently using this profile? */
function isRunning(profile) {
  if (process.platform === 'win32') return false; // no reliable argv read without extra tooling
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return (ps.stdout ?? '')
    .split('\n')
    .some((l) => l.includes(`--user-data-dir=${profile}`) && /^\s*\d+\s+1\s/.test(l));
}

/**
 * Rewrite a model id to the one this gateway advertises.
 *
 * The Codex-side picker lists `claude-cbxo-5` rather than `claude-opus-5` —
 * the family word is removed so the app cannot derive a description from it.
 * A record naming a model the picker does not list would fall back to the
 * default, quietly changing which model a session resumes on.
 */
const TIER_CODES = { opus: 'cbxo', sonnet: 'cbxs', haiku: 'cbxh', fable: 'cbxf', mythos: 'cbxm' };
function rewriteModel(model) {
  if (typeof model !== 'string') return model;
  return model.replace(/(opus|sonnet|haiku|fable|mythos)/, (w) => TIER_CODES[w] ?? w);
}

/* ---------------------------------- run ----------------------------------- */

console.log(`\n${c('1', 'Import Claude Code sessions')}\n`);

const src = findNamespace(SRC_PROFILE);
if (!src) die(`No sessions found in ${SRC_PROFILE}`);
const dst = findNamespace(DST_PROFILE, { create: true });
if (!dst) die(`No Codex Bridge profile at ${DST_PROFILE}. Run: npm run claudecodex`);
if (!dst.org) die(`The Codex profile has no org directory yet. Open it once, then re-run this.`);

console.log(`  from  ${dim(src.dir.replace(os.homedir(), '~'))}`);
console.log(`  to    ${dim(dst.dir.replace(os.homedir(), '~'))}`);

// Only the DESTINATION has to be closed. An instance reads its store once at
// startup and rewrites it from memory, with no lock and no re-read — so writing
// under a running app means it overwrites these files from its stale in-memory
// copy the next time anything changes, undoing the import.
//
// The SOURCE may stay open: it is only read, and the app writes session files
// by atomic rename, so a read never sees a half-written record. The worst case
// is importing a title that changes a second later.
if (isRunning(DST_PROFILE)) {
  die(
    `The Codex Bridge window is open.\n` +
      `  Quit it first: it holds every session in memory and would write its own\n` +
      `  copy back over these files, undoing the import.\n` +
      `  Your normal Claude window can stay open — this only reads from it.`,
  );
}

const entries = fs.readdirSync(src.dir).filter((f) => f.startsWith('local_') && f.endsWith('.json'));
if (!entries.length) die('No session records to import.');

// Deliberately NOT copied:
//   deleted_*                tombstones — importing them re-deletes sessions
//   archived-sessions.idx    a regenerable hint the app rebuilds itself
//   scheduled-tasks.json     each instance runs its own cron dispatcher with no
//   backlog/tasks.json       cross-process claim, so a copied routine would fire
//                            TWICE, once per window
const skipped = fs
  .readdirSync(src.dir)
  .filter((f) => !f.startsWith('local_') && !f.startsWith('.'));

let copied = 0;
let kept = 0;
let failed = 0;

if (!DRY) fs.mkdirSync(dst.dir, { recursive: true, mode: 0o700 });

for (const name of entries) {
  const target = path.join(dst.dir, name);
  if (fs.existsSync(target) && !FORCE) {
    kept += 1;
    continue;
  }
  try {
    const record = JSON.parse(fs.readFileSync(path.join(src.dir, name), 'utf8'));
    record.model = rewriteModel(record.model);
    // Mark where it came from, so a later look at this directory can tell
    // imported records from ones made here.
    record.importedFrom = 'local1P';
    if (!DRY) fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    copied += 1;
  } catch (err) {
    console.log(yellow(`  ! ${name}: ${err.message}`));
    failed += 1;
  }
}

console.log();
console.log(`  ${green('✓')} ${DRY ? 'would copy' : 'copied'} ${copied} session${copied === 1 ? '' : 's'}`);
if (kept) console.log(`  ${dim(`· ${kept} already present, left alone (--force to overwrite)`)}`);
if (failed) console.log(`  ${yellow(`! ${failed} could not be read`)}`);
if (skipped.length) {
  console.log(`  ${dim(`· skipped on purpose: ${skipped.join(', ')}`)}`);
  console.log(`  ${dim('  (tombstones, a regenerable index, and scheduled tasks that would fire twice)')}`);
}

console.log(`\n${dim('  Transcripts were not touched: they live in ~/.claude/projects and were')}`);
console.log(`${dim('  already shared by both profiles. This copied the records that list them.')}\n`);
