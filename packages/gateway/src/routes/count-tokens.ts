import type { ServerResponse } from 'node:http';
import type { CountTokensRequest, CountTokensResponse } from '@codex-bridge/shared';
import { sendJson } from '../http/respond.js';
import { blocksOf, extractSystemPrompt } from '../translate/anthropic-to-codex.js';

/**
 * POST /v1/messages/count_tokens
 *
 * Claude Code calls this to decide when to compact a conversation, so the
 * gateway must answer it. The Codex App Server does not expose a tokenizer, and
 * OpenAI's models do not use Anthropic's, so an exact count is not obtainable
 * here.
 *
 * We therefore return a deliberate estimate rather than a fabricated exact
 * figure, and bias it *upward*: over-counting makes Claude Code compact
 * slightly early, which is harmless. Under-counting would let a conversation
 * overflow the model's context, which is not.
 *
 * Codex reports real usage per turn (`thread/tokenUsage/updated`), and those
 * numbers are what the `usage` field of a response carries.
 */

/** Rough bytes-per-token for English + code, measured against o200k_base. */
const CHARS_PER_TOKEN = 3.6;
/** Per-message and per-tool framing overhead. */
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_OVERHEAD_TOKENS = 12;
const IMAGE_TOKENS = 1_600;
/** Safety margin so the estimate errs high. */
const SAFETY_FACTOR = 1.12;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countRequestTokens(req: CountTokensRequest): number {
  let total = estimateTokens(extractSystemPrompt(req.system));

  for (const msg of req.messages ?? []) {
    total += MESSAGE_OVERHEAD_TOKENS;
    for (const block of blocksOf(msg)) {
      switch (block.type) {
        case 'text':
          total += estimateTokens(block.text);
          break;
        case 'image':
          total += IMAGE_TOKENS;
          break;
        case 'thinking':
          total += estimateTokens(block.thinking);
          break;
        case 'redacted_thinking':
          total += estimateTokens(block.data);
          break;
        case 'tool_use':
          total += TOOL_OVERHEAD_TOKENS + estimateTokens(JSON.stringify(block.input ?? {}));
          break;
        case 'tool_result': {
          total += TOOL_OVERHEAD_TOKENS;
          if (typeof block.content === 'string') total += estimateTokens(block.content);
          else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (inner.type === 'text') total += estimateTokens(inner.text);
              else if (inner.type === 'image') total += IMAGE_TOKENS;
            }
          }
          break;
        }
        case 'document':
          total += estimateTokens(JSON.stringify(block.source ?? {}));
          break;
        default:
          break;
      }
    }
  }

  for (const tool of req.tools ?? []) {
    total += TOOL_OVERHEAD_TOKENS;
    total += estimateTokens(String(tool.name ?? ''));
    total += estimateTokens(String(tool.description ?? ''));
    total += estimateTokens(JSON.stringify(tool.input_schema ?? {}));
  }

  if (req.thinking?.type === 'enabled') total += 8;

  return Math.ceil(total * SAFETY_FACTOR);
}

export function handleCountTokens(res: ServerResponse, body: CountTokensRequest): void {
  const payload: CountTokensResponse = { input_tokens: countRequestTokens(body) };
  sendJson(res, 200, payload);
}
