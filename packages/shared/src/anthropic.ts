/**
 * Anthropic Messages API wire types — the subset a gateway must implement for
 * Claude Code, plus the SSE event shapes.
 *
 * Reference: https://docs.claude.com/en/api/messages
 */

/**
 * Claude Code sends `system` messages inside `messages[]` (its "system
 * reminder" mechanism), alongside the top-level `system` prompt. A gateway that
 * only accepts user/assistant rejects every real session.
 */
export type AnthropicRole = 'user' | 'assistant' | 'system';

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl | null;
  citations?: unknown;
}

export interface ImageSource {
  type: 'base64' | 'url';
  media_type?: string;
  data?: string;
  url?: string;
}

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
  cache_control?: CacheControl | null;
}

export interface DocumentBlock {
  type: 'document';
  source: unknown;
  title?: string | null;
  context?: string | null;
  cache_control?: CacheControl | null;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControl | null;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
  cache_control?: CacheControl | null;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | ContentBlock[];
}

export interface AnthropicToolDefinition {
  /** Client tools always carry a name + input_schema. */
  name?: string;
  description?: string;
  input_schema?: JsonSchema;
  /** Server tools (e.g. `web_search_20250305`) are typed instead. */
  type?: string;
  cache_control?: CacheControl | null;
  [k: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [k: string]: unknown;
}

export type ToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export interface ThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<TextBlock>;
  tools?: AnthropicToolDefinition[];
  tool_choice?: ToolChoice;
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: ThinkingConfig;
  metadata?: { user_id?: string | null; [k: string]: unknown };
  [k: string]: unknown;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | null;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  service_tier?: string | null;
}

export interface MessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<TextBlock | ToolUseBlock | ThinkingBlock>;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: Usage;
}

/* ------------------------------ SSE events ------------------------------ */

export interface MessageStartEvent {
  type: 'message_start';
  message: Omit<MessagesResponse, 'content'> & { content: [] };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, never> }
    | { type: 'thinking'; thinking: string; signature?: string };
}

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: StopReason; stop_sequence: string | null };
  usage: { output_tokens: number; input_tokens?: number };
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface PingEvent {
  type: 'ping';
}

export interface ErrorEvent {
  type: 'error';
  error: { type: string; message: string };
}

export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent;

/* ---------------------------- count_tokens ------------------------------ */

export interface CountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<TextBlock>;
  tools?: AnthropicToolDefinition[];
  thinking?: ThinkingConfig;
  tool_choice?: ToolChoice;
}

export interface CountTokensResponse {
  input_tokens: number;
}

/* ------------------------------- errors --------------------------------- */

/**
 * Claude Code branches on the error `type` string more than on the HTTP status,
 * so only values it recognises may be emitted. Anything else degrades to
 * generic handling and loses the client's retry/recovery behaviour.
 */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'not_supported'
  | 'overloaded_error'
  | 'api_error'
  | 'billing_error'
  | 'policy_blocked';

export interface AnthropicErrorBody {
  type: 'error';
  error: { type: AnthropicErrorType; message: string };
  request_id?: string | null;
}
