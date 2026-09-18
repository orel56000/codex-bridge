import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, claudeSettingsFile, ensureDirSecure, writeFileSecure } from '@codex-bridge/shared';

/**
 * Claude Code configuration.
 *
 * The supported way to point Claude Code at a gateway is the `env` block of its
 * settings file, which is applied at startup. We touch only the keys we own and
 * leave the rest of the user's settings byte-for-byte alone.
 *
 * Honest limitation: Claude Code reads these at startup, so a running session
 * cannot be switched over. `/logincodex` therefore tells the user to start a
 * new session rather than pretending the switch was live.
 */

/** The env keys the bridge manages. Anything else in `env` is left untouched. */
export const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
] as const;

export interface ClaudeCodeConfigView {
  configured: boolean;
  baseUrl: string | null;
  settingsPath: string;
}

interface SettingsShape {
  env?: Record<string, string>;
  [k: string]: unknown;
}

function readSettings(file: string): SettingsShape {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SettingsShape;
  } catch {
    /* fall through: an unreadable settings file is reported, never overwritten */
  }
  return {};
}

export function readClaudeCodeConfig(file = claudeSettingsFile()): ClaudeCodeConfigView {
  // A shell-level env var beats the settings file, so report that first.
  const envBaseUrl = process.env['ANTHROPIC_BASE_URL'] ?? null;
  const settings = readSettings(file);
  const baseUrl = envBaseUrl ?? settings.env?.['ANTHROPIC_BASE_URL'] ?? null;
  return {
    configured: Boolean(baseUrl),
    baseUrl,
    settingsPath: file,
  };
}

export interface ConfigureResult {
  settingsPath: string;
  changed: boolean;
  previous: Record<string, string | undefined>;
  backupPath: string | null;
}

/**
 * Point Claude Code at the gateway.
 *
 * Every Anthropic model name is aliased to `codex` so that whichever entry the
 * user picks in `/model`, the request is served by Codex. Claude Code does not
 * support registering an arbitrary custom model in its picker — see
 * docs/troubleshooting.md — so this is the closest supported behaviour.
 */
export function configureClaudeCode(opts: {
  baseUrl: string;
  authToken: string;
  modelAlias?: string;
  maxOutputTokens?: number;
  /** `user` is machine-wide; `project` affects one repo only. */
  scope?: ConfigScope;
  projectDir?: string;
  file?: string;
  /** Write a `.bak` copy before the first modification. */
  backup?: boolean;
}): ConfigureResult {
  const file = opts.file ?? settingsFileForScope(opts.scope ?? 'user', opts.projectDir);
  const modelAlias = opts.modelAlias ?? 'codex';
  const settings = readSettings(file);
  const env = { ...(settings.env ?? {}) };

  const previous: Record<string, string | undefined> = {};
  for (const key of MANAGED_ENV_KEYS) previous[key] = env[key];

  // Every built-in model name maps to Codex, so whichever row is picked in
  // /model the request is served by Codex; `ANTHROPIC_CUSTOM_MODEL_OPTION` adds
  // a real, honestly-labelled "Codex" row, which is the only supported way to
  // extend a picker whose alias list is otherwise a frozen constant.
  const desired: Record<string, string> = gatewayEnv({
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
    modelAlias,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });

  let changed = false;
  for (const [k, v] of Object.entries(desired)) {
    if (env[k] !== v) changed = true;
    env[k] = v;
  }
  if (!changed) return { settingsPath: file, changed: false, previous, backupPath: null };

  let backupPath: string | null = null;
  if (opts.backup !== false && fs.existsSync(file)) {
    backupPath = `${file}.codex-bridge.bak`;
    try {
      fs.copyFileSync(file, backupPath);
    } catch {
      backupPath = null;
    }
  }

  ensureDirSecure(path.dirname(file));
  const next: SettingsShape = { ...settings, env };
  // The file holds a gateway token, so it must not be world-readable.
  writeFileSecure(file, `${JSON.stringify(next, null, 2)}\n`);
  return { settingsPath: file, changed: true, previous, backupPath };
}

/** Remove only the keys we added, leaving the rest of `env` intact. */
export function unconfigureClaudeCode(file = claudeSettingsFile()): { settingsPath: string; changed: boolean } {
  const settings = readSettings(file);
  if (!settings.env) return { settingsPath: file, changed: false };
  const env = { ...settings.env };
  let changed = false;
  for (const key of MANAGED_ENV_KEYS) {
    if (key in env) {
      delete env[key];
      changed = true;
    }
  }
  if (!changed) return { settingsPath: file, changed: false };

  const next: SettingsShape = { ...settings };
  if (Object.keys(env).length) next.env = env;
  else delete next.env;
  writeFileSecure(file, `${JSON.stringify(next, null, 2)}\n`);
  return { settingsPath: file, changed: true };
}

/* ------------------------------ scoping ---------------------------------- */

export type ConfigScope = 'user' | 'project';

/**
 * Which settings file a scope writes to.
 *
 * `user` takes over every Claude Code session on the machine. `project` writes
 * `.claude/settings.local.json` in one repo, which Claude Code does not commit,
 * so the rest of your sessions keep using Claude.
 */
export function settingsFileForScope(scope: ConfigScope, projectDir = process.cwd()): string {
  return scope === 'user'
    ? claudeSettingsFile()
    : path.join(path.resolve(projectDir), '.claude', 'settings.local.json');
}

/**
 * The environment a Claude Code process needs to talk to the gateway.
 *
 * Exposed on its own so a session can be launched with it directly, without
 * writing to any settings file at all — the only way to run a Codex session and
 * a Claude session side by side.
 */
export function gatewayEnv(opts: {
  baseUrl: string;
  authToken: string;
  modelAlias?: string;
  maxOutputTokens?: number;
}): Record<string, string> {
  const modelAlias = opts.modelAlias ?? 'codex';
  return {
    ANTHROPIC_BASE_URL: opts.baseUrl,
    ANTHROPIC_AUTH_TOKEN: opts.authToken,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelAlias,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelAlias,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelAlias,
    ANTHROPIC_SMALL_FAST_MODEL: modelAlias,
    ANTHROPIC_CUSTOM_MODEL_OPTION: modelAlias,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Codex',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'OpenAI Codex via your ChatGPT subscription',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(opts.maxOutputTokens ?? 64000),
  };
}

/** Where a locally-installed plugin lives, for install instructions. */
export function localPluginDir(): string {
  return path.join(claudeConfigDir(), 'plugins', 'codex-bridge');
}
