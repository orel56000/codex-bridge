import type { CodexAppServerClient, RateLimitInfo } from '@codex-bridge/codex-client';
import type { ModelMapper } from './models.js';
import type { SessionManager } from './session.js';
import type { ClaudeUsage } from './passthrough.js';

/**
 * The single source of truth behind `/codex-status`, `/codex-doctor` and the
 * management page, so the three can never disagree.
 */

export interface BridgeStatus {
  gateway: {
    running: boolean;
    url: string | null;
    host: string;
    port: number | null;
    pid: number;
    uptimeSeconds: number;
    activeSessions: number;
  };
  codex: {
    installed: boolean;
    binary: string | null;
    appServerRunning: boolean;
    version: string | null;
  };
  account: {
    connected: boolean;
    authMethod: 'ChatGPT OAuth' | 'API key' | 'other' | null;
    email: string | null;
    plan: string | null;
  };
  model: {
    configured: string;
    resolved: string | null;
    available: Array<{ id: string; displayName: string; isDefault: boolean }>;
  };
  /** `null` when Codex did not report usage — never invented. */
  usage: RateLimitInfo | null;
  /**
   * Claude plan usage, read from the rate-limit headers Anthropic returns.
   *
   * `null` until a Claude model has actually been used through the gateway —
   * the headers only arrive on an answered request, so there is nothing to
   * report before the first one.
   */
  claudeUsage: ClaudeUsage | null;
  claudeCode: {
    /** True only when Claude Code points at THIS gateway. */
    configured: boolean;
    /** A base URL is set, but it is not ours. */
    pointsElsewhere: boolean;
    baseUrl: string | null;
    settingsPath: string;
  };
}

export interface StatusSources {
  /** The most recent Claude plan usage, if any has been observed. */
  claudeUsage?: ClaudeUsage | null;
  client: CodexAppServerClient;
  models: ModelMapper;
  sessions: SessionManager;
  host: string;
  port: number | null;
  startedAt: number;
  codexVersion: string | null;
  claudeCode: { baseUrl: string | null; settingsPath: string };
}

export async function collectStatus(src: StatusSources): Promise<BridgeStatus> {
  const appServerRunning = src.client.isRunning;

  let account: BridgeStatus['account'] = { connected: false, authMethod: null, email: null, plan: null };
  let usage: RateLimitInfo | null = null;

  if (appServerRunning) {
    try {
      const acct = await src.client.getAccount();
      if (acct) {
        account = {
          connected: true,
          authMethod: acct.kind === 'chatgpt' ? 'ChatGPT OAuth' : acct.kind === 'apiKey' ? 'API key' : 'other',
          email: acct.email,
          plan: acct.planType ? prettyPlan(acct.planType) : null,
        };
      }
    } catch {
      /* leave disconnected */
    }
    if (account.connected) {
      usage = await src.client.getRateLimits();
    }
  }

  await src.models.refresh().catch(() => undefined);

  const gatewayUrl = src.port === null ? null : `http://${src.host}:${src.port}`;
  const baseUrl = src.claudeCode.baseUrl;
  const claudeCode = {
    ...src.claudeCode,
    configured: Boolean(baseUrl) && normalizeUrl(baseUrl) === normalizeUrl(gatewayUrl),
    pointsElsewhere: Boolean(baseUrl) && normalizeUrl(baseUrl) !== normalizeUrl(gatewayUrl),
  };

  return {
    gateway: {
      running: src.port !== null,
      url: src.port === null ? null : `http://${src.host}:${src.port}`,
      host: src.host,
      port: src.port,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - src.startedAt) / 1000),
      activeSessions: src.sessions.size,
    },
    codex: {
      installed: src.client.codexBinary !== null,
      binary: src.client.codexBinary,
      appServerRunning,
      version: src.codexVersion,
    },
    account,
    model: {
      configured: 'auto',
      resolved: src.models.resolvedDefault,
      available: src.models.catalogue.map((m) => ({
        id: m.id,
        displayName: m.displayName || m.id,
        isDefault: m.isDefault,
      })),
    },
    usage,
    claudeUsage: src.claudeUsage ?? null,
    claudeCode,
  };
}

/** Compare base URLs without letting a trailing slash create a false mismatch. */
function normalizeUrl(url: string | null): string | null {
  return url ? url.replace(/\/+$/, '') : null;
}

/** ChatGPT plan ids rendered the way the product names them. */
export function prettyPlan(plan: string): string {
  const map: Record<string, string> = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    unknown: 'Unknown',
  };
  return map[plan.toLowerCase()] ?? plan;
}
