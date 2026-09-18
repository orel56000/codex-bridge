import type { RateLimitSnapshot, ThreadItem, TokenUsage, Turn, TurnError } from './protocol.js';

/**
 * Normalised Codex turn events.
 *
 * Nothing above this layer sees raw JSON-RPC: the gateway consumes this union
 * and the translator maps it onto Anthropic SSE.
 */
export type CodexEvent =
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; itemId: string; text: string }
  | { type: 'text_done'; itemId: string; text: string }
  | { type: 'reasoning_delta'; itemId: string; text: string }
  | { type: 'reasoning_done'; itemId: string; text: string }
  /** Codex is asking us to run a Claude Code tool. The turn is parked until it is answered. */
  | { type: 'tool_call'; callId: string; name: string; namespace: string | null; input: unknown }
  | { type: 'tool_call_settled'; callId: string; success: boolean }
  /** Codex used one of its own tools (only possible when native tools are allowed). */
  | { type: 'native_activity'; item: ThreadItem }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'rate_limits'; snapshot: RateLimitSnapshot }
  | { type: 'turn_completed'; turn: Turn }
  | { type: 'turn_failed'; error: TurnError; willRetry: boolean }
  | { type: 'interrupted' };

export interface CodexAccount {
  kind: 'chatgpt' | 'apiKey' | 'other';
  email: string | null;
  /** `plus`, `pro`, `team`, `business`, `enterprise`, `free`, `unknown`, … */
  planType: string | null;
}

export interface LoginSession {
  kind: 'browser' | 'deviceCode';
  loginId: string;
  /** Browser flow: the URL to open. Device flow: the verification URL. */
  url: string;
  /** Device flow only. */
  userCode?: string;
  /** Resolves when the App Server reports the login finished. */
  completed: Promise<{ success: boolean; error: string | null }>;
}

export interface RateLimitWindowInfo {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: Date | null;
  label: string;
}

export interface RateLimitInfo {
  /** `null` when the backend did not say. Never inferred from percentages. */
  ordinaryUsageAllowed: boolean | null;
  primary: RateLimitWindowInfo | null;
  secondary: RateLimitWindowInfo | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
}

/** Human label for a rate-limit window, derived only from what Codex reports. */
export function describeWindow(mins: number | null): string {
  if (mins === null) return 'window';
  if (mins % (60 * 24 * 7) === 0) return `${mins / (60 * 24 * 7)}-week`;
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}
