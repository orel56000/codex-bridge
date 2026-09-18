import { createHash } from 'node:crypto';
import type { AnthropicToolDefinition, JsonSchema } from '@codex-bridge/shared';
import type { DynamicToolSpec } from '@codex-bridge/codex-client';

/**
 * Tool translation between Claude Code (Anthropic) and Codex.
 *
 * Structured on both sides — nothing here parses generated text.
 */

export interface ToolTranslationResult {
  tools: DynamicToolSpec[];
  /** Tools we could not represent, with the reason, for logging and diagnostics. */
  skipped: Array<{ name: string; reason: string }>;
  /** Codex tool name -> the Anthropic name Claude Code knows it by. */
  nameMap: Record<string, string>;
}

/**
 * Names Codex refuses as dynamic tools.
 *
 * `mcp__*` is the important one: that is exactly how Claude Code names every
 * MCP tool, so a user with any MCP server attached would otherwise get
 * "dynamic tool name is reserved" and no session at all. The rest are Codex's
 * own built-ins, which must not be shadowed.
 */
const RESERVED_PREFIXES = ['mcp__', 'functions.', 'tools.', 'container.'];
const RESERVED_NAMES = new Set([
  'shell',
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
  'update_plan',
  'web_search',
  'web',
  'browser',
  'container',
  'request_user_input',
  'request_plugin_install',
  'wait',
  'exec',
]);

/**
 * Escape marker. Chosen so it is not a plausible tool name prefix, and applied
 * to already-escaped names too, which keeps the mapping a true bijection.
 */
const ESCAPE = 'cbx_';

/** Responses API function-name limit. */
const MAX_TOOL_NAME = 64;

export function isReservedToolName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true;
  return RESERVED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Anthropic tool name -> a name Codex will accept.
 *
 * Deterministic and reversible. Over-long names are truncated with a hash
 * suffix so two different long names cannot collide.
 */
export function encodeToolName(name: string, extraReserved: ReadonlySet<string> = new Set()): string {
  let out = name;
  if (isReservedToolName(out) || out.startsWith(ESCAPE) || extraReserved.has(out)) {
    out = `${ESCAPE}${out}`;
  }
  if (out.length > MAX_TOOL_NAME) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
    out = `${out.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
  }
  return out;
}

/** Codex tool names must be a plain identifier the model can emit reliably. */
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/** Server-side tools are executed by the model provider, not the client. */
function isServerTool(tool: AnthropicToolDefinition): boolean {
  return typeof tool.type === 'string' && tool.type !== 'custom' && !tool.input_schema;
}

export function anthropicToolToCodex(tool: AnthropicToolDefinition): DynamicToolSpec | { error: string } {
  if (isServerTool(tool)) {
    return { error: `server-side tool type "${String(tool.type)}" has no Codex equivalent` };
  }
  // Codex rejects leading/trailing whitespace outright.
  const name = typeof tool.name === 'string' ? tool.name.trim() : '';
  if (!TOOL_NAME_RE.test(name)) {
    return { error: `tool name ${JSON.stringify(name)} is not a valid identifier` };
  }
  const schema = normalizeSchema(tool.input_schema);
  return {
    type: 'function',
    name,
    // Codex requires a description; an empty one degrades tool selection badly.
    description: (tool.description ?? '').trim() || `The ${name} tool.`,
    inputSchema: schema,
  };
}

export function anthropicToolsToCodex(
  tools: AnthropicToolDefinition[] | undefined,
  /** Names Codex rejected at runtime; escaped on the next attempt. */
  extraReserved: ReadonlySet<string> = new Set(),
): ToolTranslationResult {
  const out: DynamicToolSpec[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const nameMap: Record<string, string> = {};
  const seen = new Set<string>();

  for (const tool of tools ?? []) {
    const converted = anthropicToolToCodex(tool);
    if ('error' in converted) {
      skipped.push({ name: String(tool.name ?? tool.type ?? 'unknown'), reason: converted.error });
      continue;
    }
    const anthropicName = converted.name;
    const codexName = encodeToolName(anthropicName, extraReserved);
    if (seen.has(codexName)) {
      skipped.push({ name: anthropicName, reason: 'duplicate tool name' });
      continue;
    }
    seen.add(codexName);
    nameMap[codexName] = anthropicName;
    out.push({ ...converted, name: codexName });
  }
  return { tools: out, skipped, nameMap };
}

/**
 * Make an Anthropic `input_schema` safe for Codex.
 *
 * Codex (via the Responses API) wants a JSON Schema object at the root. Anything
 * that is not an object schema is wrapped so the tool is still callable rather
 * than silently dropped.
 */
export function normalizeSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  if (schema.type !== 'object') {
    return { type: 'object', properties: { value: schema as Record<string, unknown> }, required: ['value'] };
  }
  const out: JsonSchema = { ...schema, type: 'object' };
  if (!out.properties) out.properties = {};
  return out;
}

/* ------------------------- tool calls and results ------------------------- */

export interface ToolCall {
  /** Anthropic `tool_use.id`, as seen by Claude Code. */
  anthropicId: string;
  /** Codex `callId`, as seen by the App Server. */
  codexCallId: string;
  name: string;
  input: unknown;
}

/**
 * Derive a stable Anthropic tool-use id from a Codex call id.
 *
 * Deterministic in both directions so a restart of the gateway cannot orphan an
 * in-flight tool call, and so nothing has to be persisted.
 */
export function codexCallIdToAnthropicId(codexCallId: string): string {
  return `toolu_${codexCallId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

export function anthropicIdToCodexCallId(anthropicId: string, known: Iterable<string>): string | null {
  for (const codexCallId of known) {
    if (codexCallIdToAnthropicId(codexCallId) === anthropicId) return codexCallId;
  }
  return null;
}

export function codexToolCallToAnthropic(
  call: { callId: string; name: string; input: unknown },
  /** Codex name -> Anthropic name, from the request that declared the tools. */
  nameMap: Record<string, string> = {},
): ToolCall {
  return {
    anthropicId: codexCallIdToAnthropicId(call.callId),
    codexCallId: call.callId,
    name: nameMap[call.name] ?? decodeToolName(call.name),
    input: call.input ?? {},
  };
}

/** Reverse of {@link encodeToolName} when no explicit map is available. */
export function decodeToolName(name: string): string {
  return name.startsWith(ESCAPE) ? name.slice(ESCAPE.length) : name;
}

export interface ToolResult {
  toolUseId: string;
  text: string;
  images: Array<{ url: string }>;
  isError: boolean;
}

export interface AnthropicToolResultLike {
  tool_use_id: string;
  /** `string | Array<TextBlock | ImageBlock>` on the wire; kept loose so any
   *  structurally-compatible block type can be passed without a cast. */
  content?: unknown;
  is_error?: boolean;
}

/** Flatten an Anthropic `tool_result` block into what Codex accepts. */
export function anthropicToolResultToCodex(block: AnthropicToolResultLike): ToolResult {
  const images: Array<{ url: string }> = [];
  let text = '';

  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (const raw of block.content as unknown[]) {
      const item = raw as Record<string, unknown>;
      if (item['type'] === 'text' && typeof item['text'] === 'string') {
        parts.push(item['text']);
      } else if (item['type'] === 'image') {
        const src = item['source'] as { type?: string; url?: string; media_type?: string; data?: string } | undefined;
        if (src?.type === 'url' && src.url) images.push({ url: src.url });
        else if (src?.type === 'base64' && src.data && src.media_type) {
          images.push({ url: `data:${src.media_type};base64,${src.data}` });
        }
        parts.push('[image]');
      }
    }
    text = parts.join('\n');
  }

  return {
    toolUseId: block.tool_use_id,
    text,
    images,
    isError: block.is_error === true,
  };
}
