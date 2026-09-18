import fs from 'node:fs';
import type { LogLevel } from './logger.js';
import { bridgeConfigFile, writeFileSecure } from './paths.js';

export interface BridgeConfig {
  gateway: {
    host: string;
    port: number;
    /** Shared secret Claude Code must present. Generated on first run. */
    authToken: string | null;
    /** Max request body size in bytes. */
    maxBodyBytes: number;
    /** Idle timeout for a single /v1/messages turn, in ms. */
    requestTimeoutMs: number;
    /** Serve the local management page at `/`. */
    managementUi: boolean;
    /**
     * Required to bind anything other than a loopback address.
     *
     * A non-loopback bind turns the `Host` guard off and exposes the gateway to
     * the network, so it has to be asked for explicitly rather than reached by
     * setting a host string.
     */
    allowNonLoopback: boolean;
  };
  codex: {
    /** `auto` resolves to the App Server's default model via `model/list`. */
    model: string;
    /** Model alias table. Keys are model names Claude Code may send. */
    modelAliases: Record<string, string>;
    /** Reasoning effort passed to Codex, or null to use the model default. */
    reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | null;
    /** Absolute path to the `codex` binary. `null` = auto-detect. */
    binPath: string | null;
    /** Extra `-c key=value` overrides for the App Server process. */
    configOverrides: string[];
    /**
     * Let Codex use its own built-in shell/patch tools instead of routing every
     * action through Claude Code's tools. Off by default: when Codex edits files
     * directly, Claude Code never sees the change and never asks permission.
     */
    allowNativeTools: boolean;
    /** How the ChatGPT sign-in page presents itself. */
    login: {
      /**
       * `codex` keeps the sign-in feeling like a CLI sign-in. `chatgpt` brands
       * OpenAI's page as ChatGPT, which offers to open the desktop app.
       */
      appBrand: 'codex' | 'chatgpt';
      /**
       * Finish on OpenAI's hosted success page instead of the local one Codex
       * serves. The hosted page is where the "open the app" detour comes from.
       */
      useHostedSuccessPage: boolean;
    };
  };
  session: {
    /** Drop an idle Codex thread after this many ms. */
    idleTtlMs: number;
    /** Maximum concurrently-mapped Codex threads. */
    maxThreads: number;
  };
  /**
   * Pass Claude models straight through to Anthropic.
   *
   * With this on, the gateway serves TWO backends: Codex for its own models,
   * and Anthropic for everything else. That is what lets a single Claude Code
   * Desktop instance — which can only be pointed at one endpoint — offer Opus,
   * Fable and Codex in the same model picker.
   */
  anthropic: {
    enabled: boolean;
    baseUrl: string;
    /**
     * A subscription token from `claude setup-token`, or an API key. Stored
     * 0600 and never logged. Leave null to read CLAUDE_CODE_OAUTH_TOKEN /
     * ANTHROPIC_API_KEY from the environment instead.
     */
    authToken: string | null;
    apiKey: string | null;
  };
  /**
   * Trim what `/v1/models` advertises.
   *
   * With both backends on, the picker lists every Claude model Anthropic
   * publishes plus every Codex model — around twenty rows, most of them older
   * versions nobody is going to choose. These two settings cut it to a usable
   * shortlist. Neither hides a model from being *used*: a request naming any
   * model still resolves, so an unlisted one stays reachable by name.
   */
  models: {
    /**
     * Claude families to advertise, newest version of each. `null` = all.
     * e.g. `["opus", "fable", "sonnet"]`.
     */
    claudeFamilies: string[] | null;
    /**
     * How many Codex models to advertise. `null` = all, plus the three
     * tier-alias rows. A number means exactly that many, Codex's own default
     * first, and the tier aliases are dropped — they are redundant once real
     * Claude models hold the opus/sonnet/haiku slots.
     */
    codexLimit: number | null;
    /**
     * Send a description with each advertised model.
     *
     * Turn this off to get a bare list of names. Claude Code Desktop resolves a
     * row's blurb as `entry.description ?? catalog ?? <tier word in the id>`,
     * so an EMPTY string is what suppresses it — omitting the field just lets
     * the app fall through to "Most efficient for everyday tasks" and friends.
     * That fallback only applies under discovery; a pinned `inferenceModels`
     * list in the desktop config supplies no description and always falls
     * through, so the desktop must be left on discovery for this to show.
     */
    descriptions: boolean;
    /**
     * List the Codex models before the Claude ones.
     *
     * This exists for the desktop's connection test, which picks what to probe
     * by scanning ids for "haiku", then "sonnet", then "opus" and taking the
     * shortest match — and, when no id contains any of those, falls back to the
     * FIRST row. Neutral ids (see `descriptions`) match none of them, so the
     * first row is what gets probed, and it is also the default model.
     *
     * Leading with Codex therefore points the health check at the gateway's own
     * backend instead of at a passthrough to Anthropic, whose quota is not
     * something the gateway controls or can fix. A rate-limited Claude model
     * otherwise reports the gateway itself as broken: the probe does not
     * special-case 429, so it renders the same "returned an error" card as a
     * genuine misconfiguration would.
     */
    codexFirst: boolean;
  };
  logging: {
    level: LogLevel;
    file: boolean;
  };
}

export const DEFAULT_CONFIG: BridgeConfig = {
  gateway: {
    host: '127.0.0.1',
    port: 4141,
    authToken: null,
    maxBodyBytes: 32 * 1024 * 1024,
    requestTimeoutMs: 15 * 60 * 1000,
    managementUi: true,
    allowNonLoopback: false,
  },
  codex: {
    model: 'auto',
    modelAliases: {},
    reasoningEffort: null,
    binPath: null,
    configOverrides: [],
    allowNativeTools: false,
    login: {
      appBrand: 'codex',
      useHostedSuccessPage: false,
    },
  },
  session: {
    idleTtlMs: 60 * 60 * 1000,
    maxThreads: 64,
  },
  anthropic: {
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    authToken: null,
    apiKey: null,
  },
  models: {
    claudeFamilies: null,
    codexLimit: null,
    descriptions: true,
    codexFirst: false,
  },
  logging: {
    level: 'info',
    file: true,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeInto<T extends Record<string, unknown>>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergeInto(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface LoadedConfig {
  config: BridgeConfig;
  /** Where the config came from, for `/codex-doctor`. */
  source: 'defaults' | 'file' | 'file+env' | 'env';
  path: string;
  /** Non-fatal problems found while reading the file. */
  warnings: string[];
}

export function loadConfig(overrides?: DeepPartial<BridgeConfig>): LoadedConfig {
  const file = bridgeConfigFile();
  const warnings: string[] = [];
  let fromFile: DeepPartial<BridgeConfig> | undefined;
  let sawFile = false;

  try {
    if (fs.existsSync(file)) {
      sawFile = true;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fromFile = parsed as DeepPartial<BridgeConfig>;
      } else {
        warnings.push(`${file}: expected a JSON object, ignoring.`);
      }
    }
  } catch (err) {
    warnings.push(`${file}: ${(err as Error).message}. Using defaults.`);
  }

  let config = mergeInto(DEFAULT_CONFIG as unknown as Record<string, unknown>, fromFile as never) as unknown as BridgeConfig;
  const fromEnv = envOverrides(warnings);
  const sawEnv = Object.keys(fromEnv).length > 0;
  config = mergeInto(config as unknown as Record<string, unknown>, fromEnv as never) as unknown as BridgeConfig;
  config = mergeInto(config as unknown as Record<string, unknown>, overrides as never) as unknown as BridgeConfig;

  // Guard rails that config must never be able to break.
  config.gateway.host = guardHost(config.gateway.host, config.gateway.allowNonLoopback, warnings);
  config.gateway.port = clampPort(config.gateway.port, warnings);
  config.gateway.maxBodyBytes = clampNumber(config.gateway.maxBodyBytes, 64 * 1024, 512 * 1024 * 1024);
  config.gateway.requestTimeoutMs = clampNumber(config.gateway.requestTimeoutMs, 5_000, 6 * 60 * 60 * 1000);
  config.session.maxThreads = clampNumber(config.session.maxThreads, 1, 4096);
  config.models = sanitiseModels(config.models, warnings);

  const source: LoadedConfig['source'] =
    sawFile && sawEnv ? 'file+env' : sawFile ? 'file' : sawEnv ? 'env' : 'defaults';
  return { config, source, path: file, warnings };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/**
 * Keep the shortlist settings to shapes the gateway can act on.
 *
 * A bad value here would quietly empty the model picker, which is a confusing
 * failure to debug from the outside — so anything unusable is dropped with a
 * warning and the setting falls back to "advertise everything".
 */
function sanitiseModels(models: BridgeConfig['models'], warnings: string[]): BridgeConfig['models'] {
  const out: BridgeConfig['models'] = {
    claudeFamilies: null,
    codexLimit: null,
    descriptions: typeof models?.descriptions === 'boolean' ? models.descriptions : true,
    codexFirst: models?.codexFirst === true,
  };

  const fams = models?.claudeFamilies;
  if (fams != null) {
    if (!Array.isArray(fams)) {
      warnings.push('models.claudeFamilies must be an array of family names; ignoring it.');
    } else {
      const clean = fams
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.trim().toLowerCase())
        .filter(Boolean);
      // An empty list would advertise no Claude models at all, which reads as
      // "the credential broke" rather than as a setting.
      if (clean.length) out.claudeFamilies = [...new Set(clean)];
      else warnings.push('models.claudeFamilies is empty; advertising every Claude model instead.');
    }
  }

  const limit = models?.codexLimit;
  if (limit != null) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
      warnings.push(`models.codexLimit=${String(limit)} must be a positive number; ignoring it.`);
    } else {
      out.codexLimit = Math.floor(limit);
    }
  }

  return out;
}

function guardHost(host: unknown, allowNonLoopback: boolean, warnings: string[]): string {
  const value = typeof host === 'string' && host.trim() ? host.trim() : DEFAULT_CONFIG.gateway.host;
  if (LOOPBACK_HOSTS.has(value)) return value;
  if (allowNonLoopback) {
    warnings.push(
      `Gateway is bound to ${value}, which is reachable from the network. ` +
        'Anyone who can reach it and holds the gateway token can use your ChatGPT session.',
    );
    return value;
  }
  warnings.push(
    `Refusing to bind ${value}: it is not a loopback address. ` +
      'Set "gateway.allowNonLoopback": true if you really mean to expose the gateway. ' +
      `Using ${DEFAULT_CONFIG.gateway.host}.`,
  );
  return DEFAULT_CONFIG.gateway.host;
}

function clampPort(port: unknown, warnings: string[]): number {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    warnings.push(`Invalid port ${String(port)}; using ${DEFAULT_CONFIG.gateway.port}.`);
    return DEFAULT_CONFIG.gateway.port;
  }
  return n;
}

function clampNumber(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function envOverrides(warnings: string[]): DeepPartial<BridgeConfig> {
  const out: DeepPartial<BridgeConfig> = {};
  const gateway: Partial<BridgeConfig['gateway']> = {};
  const codex: Partial<BridgeConfig['codex']> = {};
  const logging: Partial<BridgeConfig['logging']> = {};

  const port = process.env['CODEX_BRIDGE_PORT'];
  if (port) {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) gateway.port = n;
    else warnings.push(`CODEX_BRIDGE_PORT=${port} is not a valid port; ignoring.`);
  }
  const host = process.env['CODEX_BRIDGE_HOST'];
  if (host) gateway.host = host;

  const token = process.env['CODEX_BRIDGE_AUTH_TOKEN'];
  if (token) gateway.authToken = token;

  const model = process.env['CODEX_BRIDGE_MODEL'];
  if (model) codex.model = model;

  const bin = process.env['CODEX_BIN'];
  if (bin) codex.binPath = bin;

  const effort = process.env['CODEX_BRIDGE_REASONING_EFFORT'];
  if (effort) {
    if (['low', 'medium', 'high', 'xhigh'].includes(effort)) {
      codex.reasoningEffort = effort as BridgeConfig['codex']['reasoningEffort'];
    } else {
      warnings.push(`CODEX_BRIDGE_REASONING_EFFORT=${effort} is not a known effort; ignoring.`);
    }
  }

  const native = process.env['CODEX_BRIDGE_ALLOW_NATIVE_TOOLS'];
  if (native && native !== '0' && native.toLowerCase() !== 'false') codex.allowNativeTools = true;

  const anthropic: Partial<BridgeConfig['anthropic']> = {};
  const oauth = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (oauth) anthropic.authToken = oauth;
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) anthropic.apiKey = anthropicKey;
  const passthrough = process.env['CODEX_BRIDGE_ANTHROPIC_PASSTHROUGH'];
  if (passthrough && passthrough !== '0' && passthrough.toLowerCase() !== 'false') anthropic.enabled = true;

  const level = process.env['CODEX_BRIDGE_LOG_LEVEL']?.toLowerCase();
  if (level && ['error', 'warn', 'info', 'debug'].includes(level)) logging.level = level as LogLevel;
  if (process.env['CODEX_BRIDGE_DEBUG'] && process.env['CODEX_BRIDGE_DEBUG'] !== '0') logging.level = 'debug';

  if (Object.keys(gateway).length) out.gateway = gateway;
  if (Object.keys(codex).length) out.codex = codex;
  if (Object.keys(anthropic).length) out.anthropic = anthropic;
  if (Object.keys(logging).length) out.logging = logging;
  return out;
}

export function saveConfig(config: DeepPartial<BridgeConfig>): string {
  const file = bridgeConfigFile();
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* overwrite an unreadable config rather than failing */
  }
  const merged = mergeInto(existing, config as never);
  writeFileSecure(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}
