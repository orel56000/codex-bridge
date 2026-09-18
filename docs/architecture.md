# Architecture

## The shape of the problem

Claude Code and Codex disagree about who is in charge of a turn.

**Claude Code** is a stateless HTTP client. It sends the entire conversation on every
request, receives an assistant message, and if that message contains `tool_use` blocks it
executes them locally and sends a *new* request carrying the results. The model never runs
anything; the client does.

**Codex** is a stateful agent. `thread/start` opens a conversation and `turn/start` runs a
turn that lives on the server. When the model wants a tool, the App Server sends the
client a JSON-RPC **request** — `item/tool/call` — and the turn *blocks* until the client
answers it.

So one side finishes its HTTP response to ask for a tool, and the other side refuses to
finish anything until the tool comes back.

## The resolution

The gateway parks the Codex call across the HTTP boundary.

```
Claude Code                     Gateway                        Codex App Server
───────────                     ───────                        ────────────────
POST /v1/messages ─────────────▶
                                thread/start (+dynamicTools) ─▶
                                turn/start ───────────────────▶
                                                               (model runs)
                                ◀── item/agentMessage/delta ───
   ◀── text_delta …
                                ◀── item/tool/call ────────────  ⟵ turn BLOCKS here
   ◀── tool_use block                    │
   ◀── stop_reason: tool_use             │  promise parked,
   ◀── message_stop                      │  not answered
◀────── response ends                    │
                                         │
(Claude Code runs the tool)              │
                                         │
POST /v1/messages ─────────────▶         │
  (…history…, tool_result)      ─────────┘ resolve the parked promise
                                                               (same turn resumes)
                                ◀── item/agentMessage/delta ───
   ◀── text_delta …
                                ◀── turn/completed ────────────
   ◀── stop_reason: end_turn
```

The model experiences one continuous turn. Claude Code experiences the request/response
loop it expects. Neither has to change.

Mechanically:

- `CodexAppServerClient.onServerRequest` returns a promise it does **not** resolve, and
  records it under the Codex `callId`.
- The translator emits an Anthropic `tool_use` block whose `id` is derived deterministically
  from that `callId`, then closes the message with `stop_reason: "tool_use"`.
- `SessionManager.park()` remembers `anthropicId → codexCallId` and which turn is parked.
- The next request's `tool_result` blocks are matched back by `tool_use_id`, the promise is
  resolved, and the gateway **re-attaches** to the same event queue and keeps streaming.

Matching on the tool-use id rather than on a session header is deliberate: it is exact, and
it works even when a client sends no usable metadata.

## Components

```
packages/plugin      Claude Code plugin: slash commands + a SessionStart hook
      │  shells out to
      ▼
packages/cli         codex-bridge: process management, login, status, doctor
      │  owns
      ▼
packages/gateway     HTTP server, translation, sessions, models, management UI
      │  uses
      ▼
packages/codex-client   the ONLY module that knows Codex JSON-RPC method names
      │  spawns
      ▼
codex app-server     official binary — owns auth, tokens, and the Codex backend
```

`packages/shared` sits underneath everything: wire types, config, logging, redaction, and
the cross-platform helpers (browser opening, binary discovery, per-OS paths).

The layering rule that matters: **no Codex JSON-RPC method name appears outside
`packages/codex-client`**, and **no HTTP concept appears inside it**. That is what makes
the translator unit-testable without a Codex install and the client testable without a
listening port.

## Request lifecycle

1. **Validate** (`http/body.ts`) — size-capped read, then a shape check that is strict
   about what we must translate and permissive about everything else, because Claude Code
   sends vendor fields (`context_management`, `output_config`, beta flags) that we ignore.
2. **Authenticate** — the gateway's own bearer token, then `account/read` to confirm the
   ChatGPT session is live.
3. **Short-circuit the credential probe** — Claude Code validates credentials and `/model`
   switches with a real `max_tokens: 1` request. Answering it directly costs the user no
   Codex quota, and the `account/read` above is what the probe was actually asking.
4. **Classify** — a request with no `tools` is a Claude Code utility call (conversation
   titles, topic detection). Those run in a throwaway `ephemeral` thread so they never
   enter the coding conversation's context.
5. **Resolve the session** — by parked tool-use id, else by `metadata.user_id`'s
   `session_id`, else by a content hash of the system prompt and first user message.
6. **Ensure a thread** — reuse, or rebuild when the system prompt, tool set, or working
   directory changed, or when the client rewrote its history (compaction, rewind).
7. **Replay only what is missing** — on a fresh thread, prior history goes in through
   `thread/inject_items` as structured Responses items, not as a flattened string. In
   steady state nothing is replayed: Codex already holds the context.
8. **Run the turn**, translating events to SSE as they arrive.
9. **Close** on `turn/completed`, on the tool-call grace window expiring, or on the client
   disconnecting (which interrupts the Codex turn rather than leaking it).

## Isolation

A Codex thread started by the bridge is not a Codex session. Three things are turned off:

| Concern | Mechanism |
| --- | --- |
| The user's MCP servers and plugins would appear as extra tools Claude Code cannot render or gate | `codex app-server -c mcp_servers={} -c plugins={} -c tools.web_search=false` |
| Codex's own `apply_patch` / `exec_command` would edit files Claude Code never sees, bypassing its permission prompts | `sandbox: "read-only"` + `approvalPolicy: "untrusted"`, and the gateway declines every approval request |
| Codex's agent persona would fight Claude Code's system prompt | `baseInstructions` replaces it wholesale |

The system prompt also carries an explicit rule that local execution is disabled and only
the provided tools work. In practice Codex does not attempt its native tools at all — the
end-to-end test asserts zero approval requests — but the sandbox is what makes that a
guarantee rather than a hope.

Setting `codex.allowNativeTools: true` reverses all of this. It is off by default because
a tool call Claude Code never sees is a tool call the user never approved.

## Process management

`codex-bridge` runs the gateway as a detached background process:

- a PID record under the per-OS state directory, holding pid, port, url and token (mode `0600`);
- `start` detects a healthy existing gateway via `/health` and does not start a second one;
- a stale record — process gone, or alive but not answering — is reaped before spawning;
- the gateway walks forward from port 4141 when the port is taken, and says so;
- `SIGTERM`/`SIGINT`/`SIGHUP` and an uncaught exception all clear the record and shut the
  App Server down, so a crash cannot strand an orphan;
- the App Server child is supervised with exponential backoff, capped at 5 restarts.

The plugin's `SessionStart` hook runs `codex-bridge start` asynchronously, so a new Claude
Code session brings the gateway up without the user thinking about it.

## Testing strategy

Three layers, and only the last needs credentials:

- **Unit** — pure translation, session rules, redaction, config, framing.
- **Integration** — a real `Gateway`, a real HTTP server, and a real child process
  (`test/fixtures/fake-codex.mjs`) that speaks the App Server's JSON-RPC. This covers the
  spawn, the handshake, streaming, the tool-call park/resume, login, logout and errors
  without touching OpenAI.
- **End-to-end** (`scripts/e2e.mjs`) — drives the gateway exactly as Claude Code does,
  against live Codex, and asserts the bug in a scratch repo is actually fixed on disk.
