# Protocol mapping

Anthropic Messages API ↔ Codex App Server, field by field. Verified against
`codex-cli 0.154.0-alpha` and `@anthropic-ai/claude-code 2.1.241`.

The Codex side is not guesswork: the CLI emits its own bindings.

```bash
codex app-server generate-ts          --out ./proto/ts
codex app-server generate-json-schema --experimental --out ./proto/schema
```

`npm run protocol:check` regenerates those and diffs the method names against
`CLIENT_REQUEST_METHODS` in `packages/codex-client/src/protocol.ts`, so a Codex upgrade
that renames a method fails loudly instead of at runtime.

---

## Requests

### Anthropic → Codex thread

| Anthropic | Codex | Notes |
| --- | --- | --- |
| `system` (string or text blocks) | `thread/start.baseInstructions` | Concatenated with `\n\n`. Replaces Codex's own agent persona entirely. A hard rule about local execution being disabled is appended unless `allowNativeTools`. |
| `tools[]` | `thread/start.dynamicTools[]` | Requires `capabilities.experimentalApi: true` on `initialize`. `name` → `name` (see **Tool names** below), `description` → `description` (a placeholder is substituted when empty, because Codex requires one), `input_schema` → `inputSchema`. |
| `tools[]` of `{type: "web_search_20250305"}` | *(dropped)* | Server-side tools have no client-callable Codex equivalent. Reported in the `skipped` list and logged, never silently discarded. |
| — | `cwd` | Parsed from the system prompt (`Working directory: …`), falling back to the gateway's cwd. |
| — | `approvalPolicy: "untrusted"`, `sandbox: "read-only"` | See [architecture](architecture.md#isolation). |
| `model` | `thread/start.model` | Via the alias table, then an exact Codex id, then `model/list`'s default. Never hardcoded. |
| — | `turn/start.effort` | Set explicitly from the model's own `defaultReasoningEffort` (or config). Without it the bridge inherits `model_reasoning_effort` from the user's personal `~/.codex/config.toml`, so an `xhigh` there would silently make every Claude Code turn take minutes. |

### Tool names

Codex validates dynamic tool names and rejects a reserved set. The important one is
`mcp__*` — which is exactly how Claude Code names every MCP tool, so a user with any MCP
server attached would get `dynamic tool name is reserved` and no session at all.

Names are therefore encoded on the way in and decoded on the way out:

| Anthropic name | Codex name |
| --- | --- |
| `Read`, `Edit`, `Bash` | unchanged |
| `mcp__blender__bpy_api_lookup` | `cbx_mcp__blender__bpy_api_lookup` |
| `shell`, `apply_patch`, `exec_command`, … (Codex built-ins) | `cbx_` prefixed |
| anything already starting with `cbx_` | `cbx_` prefixed again, so the mapping stays a bijection |
| longer than 64 characters | truncated with an 8-hex-character hash of the original |

The per-request map is authoritative for decoding; the deterministic rule is the fallback.
The reserved list also lives inside the Codex binary and changes between releases, so a
`dynamic tool name is reserved: X` error is parsed, `X` is escaped, and `thread/start` is
retried — bounded to four attempts.

Because `baseInstructions` and `dynamicTools` are bound at `thread/start`, a change to
either forces a new thread. That is what `SessionManager`'s `shapeHash` detects.

### Anthropic → Codex turn

| Anthropic | Codex |
| --- | --- |
| trailing user message, `text` blocks | `turn/start.input: [{type:"text", text, text_elements: []}]` |
| trailing `system` message | the same, prefixed `[system]` — Claude Code sends `role: "system"` messages inside `messages[]`, and rejecting them 400s every real session |
| `image` block, `source.type: "url"` | `{type:"image", url}` |
| `image` block, `source.type: "base64"` | `{type:"image", url: "data:<media_type>;base64,<data>"}` |
| `tool_result` blocks | resolve the parked `item/tool/call`, or `turn/start.toolOutput` when no parked call matches |
| earlier messages Codex has not seen | `thread/inject_items` as raw Responses items |
| `document` block | a text placeholder — Codex has no equivalent input |

History replay maps to Responses items, preserving message semantics:

| Anthropic | Responses item |
| --- | --- |
| user text | `{type:"message", role:"user", content:[{type:"input_text", text}]}` |
| assistant text | `{type:"message", role:"assistant", content:[{type:"output_text", text}]}` |
| `tool_use` | `{type:"function_call", name, call_id, arguments}` |
| `tool_result` | `{type:"function_call_output", call_id, output:[{type:"input_text", text}, …]}` — `FunctionCallOutputBody` is `string \| ContentItem[]`, **not** an object with `content`/`success`; an object is rejected as "not a valid response item" |
| `system` message | `{type:"message", role:"developer", content:[…]}` |
| `thinking` / `redacted_thinking` | *(dropped)* — the signatures are provider-specific and meaningless to Codex |

### Fields accepted and ignored

Claude Code sends first-party request bodies to any `ANTHROPIC_BASE_URL`, so the gateway
must tolerate fields Codex has no notion of. These are accepted and dropped without error:

`cache_control`, `context_management`, `output_config`, `tool_reference`,
`stop_sequences`, `temperature`, `top_p`, `top_k`, `tool_choice`, `metadata`,
`anthropic-beta` values, and `thinking: {type: "adaptive"}`.

`thinking.type: "adaptive"` matters specifically: Claude Code sends it to any model name it
does not recognise — which is exactly a gateway alias. Rejecting it would 400 every
request. It is treated as "not enabled": Codex reasoning is not surfaced.

`max_tokens` has no Codex equivalent (`turn/start` takes no output cap) and is not
enforced. `stop_reason: "max_tokens"` is therefore only produced by the credential-probe
fast path and by a gateway timeout.

`metadata.user_id` is parsed locally for its `session_id` and is **never** forwarded to
Codex: it carries Anthropic account identifiers.

---

## Responses

### Codex events → Anthropic stream events

| Codex notification | Anthropic |
| --- | --- |
| *(start of turn)* | `message_start` |
| `item/agentMessage/delta` | `content_block_start{type:"text"}` then `content_block_delta{text_delta}` |
| `item/completed` (`agentMessage`) | used only if no deltas arrived |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `content_block_delta{thinking_delta}` — **only** when the request enabled thinking; otherwise dropped |
| `item/tool/call` (server **request**) | `content_block_start{type:"tool_use"}` + one `input_json_delta` + `content_block_stop` |
| `thread/tokenUsage/updated` | the `usage` object |
| `turn/completed` | `message_delta{stop_reason}` + `message_stop` |
| `error` (`willRetry: false`) | `event: error` mid-stream, or an HTTP error before headers are sent |
| `error` (`willRetry: true`) | nothing — Codex is retrying |
| `item/completed` (`commandExecution`, `fileChange`, `mcpToolCall`) | nothing; recorded as native activity for logs |

### stop_reason

| Situation | `stop_reason` |
| --- | --- |
| Turn finished with no pending tools | `end_turn` |
| Tool calls emitted and parked | `tool_use` |
| Gateway timeout | `max_tokens` |
| Credential probe fast path | `max_tokens` |
| Turn failed, rate limited | `refusal`, plus an `error` event |

### usage

| Codex `tokenUsage.last` | Anthropic |
| --- | --- |
| `inputTokens` | `input_tokens` |
| `outputTokens` | `output_tokens` |
| `cachedInputTokens` | `cache_read_input_tokens` |
| `cacheWriteInputTokens` | `cache_creation_input_tokens` |

`message_delta` always carries `usage`, even when it is zero: Claude Code reads
`usage.output_tokens` with no optional chaining and crashes without it.

---

## Streaming rules the gateway must obey

These are enforced by the client and fail silently rather than loudly, so they are pinned
by tests in `codex-to-anthropic.test.ts` and `integration.test.ts`.

1. **Every frame carries an `event:` line**, and its value equals the payload's `type`.
   Claude Code dispatches on the `event:` name, not on the JSON. A frame with only a
   `data:` line is discarded and the stream then dies as "ended without sending chunks".
2. **Never send `data: [DONE]`.** That is the OpenAI convention and appears nowhere in
   Claude Code. Terminate with `message_stop` and close the response.
3. **`message_delta` must include `usage`.**
4. **Deltas are type-gated against the block they target.** A `text_delta` sent at the
   index of a `tool_use` block is dropped without error and the user sees an empty reply.
   Every `content_block_start` type must match the deltas that follow at that index.
5. **A `thinking` block's `content_block_start` must include both `thinking: ""` and
   `signature: ""`.** The accumulator has no `|| ""` fallback for `thinking`.
6. **Exactly one `message_start` per HTTP response.** A second one throws
   "Unexpected event order" and kills the turn.
7. **Ping during silence.** Claude Code has a byte-level idle watchdog; Codex reasoning can
   stall well past a proxy timeout. The gateway emits `event: ping` every 15 s.
8. **Non-streaming responses must be `Content-Type: application/json`**, or the SDK returns
   the raw string instead of a Message.
9. **Mid-stream failures use `event: error`**, not an HTTP status — the status is already
   sent.
10. **Malformed streams cost double.** Claude Code silently retries the whole request with
    `stream: false`, so the non-streaming path must work too.

## Errors

`{"type":"error","request_id":"req_…","error":{"type":…,"message":…}}`, plus a `request-id`
response header. Claude Code validates request ids against `/^req_[A-Za-z0-9_-]{1,36}$/`.

Only types Claude Code recognises are emitted — `invalid_request_error`,
`authentication_error`, `permission_error`, `not_found_error`, `request_too_large`,
`rate_limit_error`, `not_supported`, `overloaded_error`, `api_error`, `billing_error`,
`policy_blocked` — because the type drives its retry and capability-downgrade behaviour
more than the HTTP status does.

| Bridge condition | HTTP | type |
| --- | --- | --- |
| Not signed in / session expired | 401 | `authentication_error` |
| Codex usage limit | 429 | `rate_limit_error` (+ `retry-after` when Codex gives a reset) |
| Bad request body | 400 | `invalid_request_error` |
| Body over the cap | 413 | `request_too_large` |
| Codex not installed / App Server down | 503 | `api_error` |
| Non-loopback `Host` | 403 | `permission_error` |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/messages` | inference (also matches `?beta=true`) |
| `POST /v1/messages/count_tokens` | context-window accounting |
| `GET /v1/models` | model discovery; ids read `claude-<tier>-bridge` / `claude-sonnet-bridge-<model>` — see [Why the model ids look like that](#why-the-model-ids-look-like-that) |
| `HEAD|GET /api/hello` | Claude Code's startup probe |
| `GET /health` | liveness, used by the CLI to detect a running gateway |
| `GET /` | the local management page |
| `/admin/*` | status, doctor, login, logout, restart — used by the page and the CLI |

Routing matches on the path only, so query strings (`?beta=true`) are handled.


## Why the model ids look like that

The ids the gateway advertises name no vendor: `claude-opus-bridge`,
`claude-sonnet-bridge`, `claude-haiku-bridge`, plus one
`claude-sonnet-bridge-<model>` per Codex model (`claude-sonnet-bridge-5-6-sol`).
They have to clear two filters that pull in opposite directions.

**Claude Code (CLI)** drops any id that does not contain `claude` or
`anthropic`. So the id must claim to be Claude.

**Claude Code Desktop** then runs the same id past a blocklist of foreign-model
words, and that list contains both `codex` and `gpt`:

```js
// Claude.app/Contents/Resources/app.asar, reformatted
const BLOCKED = /ark-code|astron|…|gpt|…|codex|…/;
const ALLOWED = ["claude", …, "anthropic"];
function acceptable(id) {
  const t = id.toLowerCase();
  return BLOCKED.test(t) ? false : KNOWN.test(t) || ALLOWED.some(a => t.includes(a));
}
```

A rejected row is removed **silently**. The log says so and nothing else does:

```
[warn] inferenceModels: "claude-codex-sonnet" is not an Anthropic model and was removed from the list
[custom-3p] Model discovery: 8 found in 375ms; picker = 0 (empty)
```

With every row removed the picker is empty, and the app shows *"Models are still
loading. Try again in a moment."* — forever, with discovery reporting success.
So the obvious names, `claude-codex-sonnet` and `claude-codex-gpt-5.6-sol`, are
precisely the two that cannot work.

Only the **id** is filtered. `display_name` is not, so that is where the model is
named honestly: the row with id `claude-sonnet-bridge-5-6-sol` is labelled
`Codex GPT-5.6-Sol`, which is what you actually see in the picker.

Three consequences worth keeping in mind:

- The tier slots and the pinned-model ids **share no common prefix**
  (`claude-opus-bridge` vs `claude-sonnet-bridge-…`), so routing between Codex
  and the Anthropic passthrough asks `isBridgeModelId()` rather than testing a
  prefix. A prefix test hands the Opus and Haiku slots to Anthropic.
- Every pinned model is tiered `sonnet`. Tiering is what keeps the row alive in
  the desktop; claiming a Codex model "is" an Opus would be a lie the picker
  then tells you.
- `isAcceptableModelId()` in `packages/gateway/src/models.ts` carries a copy of
  the blocklist, and the integration suite asserts every advertised id passes
  it. That is the regression test for this whole section.
