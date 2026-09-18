import { createHash } from 'node:crypto';
import type {
  AnthropicMessage,
  ContentBlock,
  MessagesRequest,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@codex-bridge/shared';
import type { UserInput } from '@codex-bridge/codex-client';
import { anthropicToolResultToCodex, type ToolResult } from './tools.js';

/**
 * Anthropic request -> Codex thread/turn inputs.
 *
 * Message semantics are preserved rather than flattened: user text stays user
 * text, images stay images, tool results are matched back to the Codex call
 * that is parked waiting for them, and prior history is replayed as structured
 * Responses API items rather than one giant string.
 */

/** Hard rule appended to the caller's system prompt. See docs/protocol-mapping.md. */
export const TOOL_DISCIPLINE_INSTRUCTIONS = `
# Execution environment

You are running behind a bridge. You have NO ability to run commands, edit files,
or touch this machine yourself. Your own built-in tools (shell, exec_command,
apply_patch, view_image, web search) are disabled and any attempt to use them
will be declined.

The ONLY way to act is to call one of the tools provided to you in this session.
Every tool call is executed by the client on your behalf and its result is
returned to you. If a task needs a command run or a file changed, call the
appropriate provided tool.`.trim();

export function extractSystemPrompt(system: MessagesRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((b): b is TextBlock => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

export function buildBaseInstructions(system: MessagesRequest['system'], allowNativeTools: boolean): string {
  const base = extractSystemPrompt(system).trim();
  if (allowNativeTools) return base;
  return base ? `${base}\n\n${TOOL_DISCIPLINE_INSTRUCTIONS}` : TOOL_DISCIPLINE_INSTRUCTIONS;
}

/* ------------------------------ conversation ------------------------------ */

export interface ConversationPlan {
  /** Tool results in the trailing user message that answer parked Codex calls. */
  toolResults: ToolResult[];
  /** Fresh user input to start a new turn with, if any. */
  turnInput: UserInput[];
  /** Per-message fingerprints, used to detect history rewrites. */
  fingerprints: string[];
  /** Index into `fingerprints` of the first message not yet sent to Codex. */
  newFrom: number;
}

// The role set is closed ('user' | 'assistant' | 'system'), so a plain
// delimiter cannot make two different messages hash alike.
const FINGERPRINT_SEPARATOR = ':';

export function fingerprintMessage(msg: AnthropicMessage): string {
  const h = createHash('sha256');
  h.update(msg.role);
  h.update(FINGERPRINT_SEPARATOR);
  h.update(typeof msg.content === 'string' ? msg.content : stableStringify(msg.content));
  return h.digest('hex').slice(0, 24);
}

export function fingerprintMessages(messages: AnthropicMessage[]): string[] {
  return messages.map(fingerprintMessage);
}

/** JSON with sorted keys, so semantically equal blocks fingerprint identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `cache_control` is a caching hint, not content; ignoring it keeps a
    // conversation stable when Claude Code moves its cache breakpoints.
    .filter(([k]) => k !== 'cache_control')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function blocksOf(msg: AnthropicMessage): ContentBlock[] {
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }];
  return msg.content ?? [];
}

/**
 * Everything that is not the assistant is input to the model. Claude Code's
 * mid-conversation `system` messages are context, so they travel with the user
 * side rather than being dropped.
 */
export function isInputRole(role: AnthropicMessage['role']): boolean {
  return role !== 'assistant';
}

export function collectToolResults(msg: AnthropicMessage | undefined): ToolResult[] {
  if (!msg || msg.role !== 'user') return [];
  return blocksOf(msg)
    .filter((b): b is ToolResultBlock => b.type === 'tool_result')
    .map(anthropicToolResultToCodex);
}

export function collectToolUses(msg: AnthropicMessage | undefined): ToolUseBlock[] {
  if (!msg || msg.role !== 'assistant') return [];
  return blocksOf(msg).filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Turn one Anthropic input message into Codex `UserInput` items. */
export function messageToUserInput(msg: AnthropicMessage): UserInput[] {
  const out: UserInput[] = [];
  const texts: string[] = [];
  // A `system` message is context, not something the user typed; label it so the
  // model does not answer it as if it were a question.
  const prefix = msg.role === 'system' ? '[system]\n' : '';
  for (const block of blocksOf(msg)) {
    if (block.type === 'text') {
      if (block.text) texts.push(block.text);
    } else if (block.type === 'image') {
      const src = block.source;
      if (src?.type === 'url' && src.url) out.push({ type: 'image', url: src.url });
      else if (src?.type === 'base64' && src.data && src.media_type) {
        out.push({ type: 'image', url: `data:${src.media_type};base64,${src.data}` });
      }
    } else if (block.type === 'document') {
      texts.push('[document attached by the client]');
    }
    // tool_result blocks are handled separately: they resolve a parked call.
  }
  if (texts.length) out.unshift({ type: 'text', text: prefix + texts.join('\n\n'), text_elements: [] });
  return out;
}

/**
 * Replay prior conversation as raw Responses API items for `thread/inject_items`.
 *
 * Used only when a thread has to be rebuilt (first sight of an existing
 * conversation, or after Claude Code rewrote its history). In steady state
 * Codex keeps its own context and nothing is replayed.
 */
export function messagesToResponseItems(messages: AnthropicMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const msg of messages) {
    const blocks = blocksOf(msg);
    if (isInputRole(msg.role)) {
      const contents: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) contents.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image') {
          const src = b.source;
          const url =
            src?.type === 'url'
              ? src.url
              : src?.type === 'base64' && src.data && src.media_type
                ? `data:${src.media_type};base64,${src.data}`
                : null;
          if (url) contents.push({ type: 'input_image', image_url: url });
        } else if (b.type === 'tool_result') {
          const r = anthropicToolResultToCodex(b);
          const content: Array<Record<string, unknown>> = [];
          const text = r.text || (r.isError ? 'Error' : '(no output)');
          content.push({ type: 'input_text', text: r.isError ? `Error: ${text}` : text });
          for (const img of r.images) content.push({ type: 'input_image', image_url: img.url });
          items.push({ type: 'function_call_output', call_id: r.toolUseId, output: content });
        }
      }
      if (contents.length) {
        // The Responses API models instruction-shaped context as `developer`.
        items.push({ type: 'message', role: msg.role === 'system' ? 'developer' : 'user', content: contents });
      }
    } else {
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) texts.push(b.text);
        else if (b.type === 'tool_use') {
          items.push({
            type: 'function_call',
            name: b.name,
            call_id: b.id,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
        // thinking / redacted_thinking carry provider-specific signatures that
        // are meaningless to Codex; dropping them is safer than replaying them.
      }
      if (texts.length) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: texts.join('\n\n') }],
        });
      }
    }
  }
  return items;
}

/**
 * A request with no tools is a Claude Code utility call (conversation titles,
 * topic detection, quota pings) rather than part of the coding conversation.
 * Those run in a throwaway thread so they never pollute the session's context.
 */
export function isUtilityRequest(req: MessagesRequest): boolean {
  return !req.tools || req.tools.length === 0;
}

/** Claude Code puts its session id in `metadata.user_id` as a JSON blob. */
export function extractSessionId(req: MessagesRequest): string | null {
  const meta = req.metadata;
  const raw = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['user_id'] : undefined;
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const sid = obj['session_id'];
      if (typeof sid === 'string' && sid) return sid;
    }
  } catch {
    // Older/other clients may send a plain string; use it verbatim.
  }
  return raw || null;
}

/**
 * Fallback key when `metadata.user_id` is absent: the system prompt plus the
 * first user message identify a conversation well enough to keep continuity.
 */
export function fallbackSessionKey(req: MessagesRequest): string {
  const h = createHash('sha256');
  h.update(extractSystemPrompt(req.system));
  const first = req.messages.find((m) => m.role === 'user');
  if (first) h.update(fingerprintMessage(first));
  return `anon_${h.digest('hex').slice(0, 24)}`;
}
