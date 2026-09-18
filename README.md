# Codex Bridge

Use **OpenAI Codex** as the model behind **Claude Code**, over your existing ChatGPT
subscription. No OpenAI API key.

```
Claude Code  →  local gateway (127.0.0.1)  →  Codex App Server  →  ChatGPT OAuth  →  Codex
```

Authentication is handled entirely by the official `codex app-server`: the bridge never
sees, stores, or refreshes an OAuth token.

---

## Quick start

```bash
git clone <this repo> && cd codex-bridge
npm install
node scripts/install.mjs
```

Then, in a **new** Claude Code session:

```
/logincodex
```

Sign in with ChatGPT in the browser window that opens. Then start a Claude Code session
on Codex:

```bash
codex-bridge run
```

That session uses Codex; every other Claude Code session keeps using Claude. Signing in
does **not** reconfigure anything on its own.

```
/codex-status
```

```
Codex
────────────────────────
Status:       Connected
Auth:         ChatGPT OAuth
Account:      you@example.com
Plan:         Plus
Gateway:      Running (http://127.0.0.1:4141)
Codex Server: Running
Model:        gpt-5.6-sol
Claude Code:  Routed through this gateway

Usage
5-hour window:  34%   (resets in 3h)
7-day window:   21%   (resets in 5d)
```

Requirements: **Node 20+**, the **Codex CLI** (`npm install -g @openai/codex`), and a
ChatGPT account with Codex access.

---

## Commands

| Command | What it does |
| --- | --- |
| `/logincodex` | Sign in with ChatGPT through the Codex App Server |
| `/codex-status` | Connection, plan, gateway, model and usage |
| `/codex-logout` | Disconnect the ChatGPT account |
| `/codex-start` / `/codex-stop` / `/codex-restart` | Manage the local gateway |
| `/codex-run` | How to start a session on Codex |
| `/codex-doctor` | Diagnose the installation (`--fix` repairs the Claude Code config) |

Everything is also a terminal command:

```bash
codex-bridge run                # a Claude Code session on Codex, nothing else changes
codex-bridge run -- --continue  # extra args pass through to claude
codex-bridge env                # the env vars, if you'd rather wire it up yourself
codex-bridge status
codex-bridge doctor --fix
codex-bridge ui                 # opens the local management page
```

A local management page lives at <http://127.0.0.1:4141/> — account, usage meters,
diagnostics and a restart button. It is served from the gateway with no external
resources, so it works offline.

---

## Keeping your Claude models

Three ways to opt in, smallest blast radius first:

| | Affects | Undo |
| --- | --- | --- |
| `codex-bridge run` | one session | close it |
| `codex-bridge configure --scope project` | one repo (`.claude/settings.local.json`) | `unconfigure --scope project` |
| `codex-bridge configure --scope user` | **every** session on the machine | `unconfigure --scope user`, then restart Claude Code |

Only the last one takes over your Claude models. Claude Code reads its provider when a
session starts, so switching is always "start a new session", never mid-conversation —
and the `user` scope additionally needs a restart to undo, because removing a key from
`settings.json` does not unset it in a process that is already running.

Switching ChatGPT accounts: run `/logincodex` again. It shows the current account and
starts a fresh sign-in so you can pick a different one; cancelling keeps the current one.

## What actually works

Verified end to end against live Codex (`npm run test:e2e`):

- ✅ ChatGPT OAuth via the official App Server — no API key
- ✅ Claude Code's own tools (Read, Edit, Bash, …) called by Codex, executed by Claude Code
- ✅ Streaming, including tool calls mid-stream
- ✅ Conversation continuity across the request/response tool loop
- ✅ Non-streaming requests, `count_tokens`, model discovery
- ✅ Reconnect, logout, diagnostics, automatic process management

## Claude models alongside Codex

One gateway can serve both, so the desktop picker offers Opus, Sonnet, Haiku
*and* Codex. Codex needs nothing; Claude models are forwarded to Anthropic and
need a credential of your own:

```bash
claude setup-token                     # authorise in the browser
codex-bridge anthropic --token-stdin   # paste at the prompt
codex-bridge anthropic --status        # verifies it for real
```

Use `--token-stdin` rather than `--token`: the token is long enough that a
terminal wraps it, and a copy of wrapped text carries the line breaks. Reading
only the first line stores a truncated token that looks fine and fails every
request; `--token-stdin` rejoins it. `--status` and `/codex-doctor` make a real
request, so a credential that does not work is reported as broken rather than as
"stored".

Until one works, Codex holds the opus/sonnet/haiku slots. Once one does, those
slots go back to real Claude models.

## Honest limitations

These are real and worth knowing before you install:

1. **Anthropic does not support this.** Their gateway documentation says plainly that they
   don't support routing Claude Code to non-Claude models through any gateway. It works,
   but you are outside the supported envelope and a Claude Code release can move under you.
2. **`/model codex` is not a thing you can create.** Claude Code's model alias list is a
   frozen constant. What the installer does instead is honest and supported: every
   built-in model name is pointed at Codex, and `ANTHROPIC_CUSTOM_MODEL_OPTION` adds a real
   "Codex" row to the picker. See [docs/troubleshooting.md](docs/troubleshooting.md).
3. **Claude Code Desktop's Code tab ignores `ANTHROPIC_BASE_URL`.** It overwrites the
   variable in its child environment. Use its Developer → Configure Third-Party Inference
   setting instead; `/codex-doctor` tells you so when it detects the desktop app.
4. **`/cost` will be wrong.** Claude Code prices unknown models from a hardcoded table.
   Use `/codex-status` for real Codex usage.
5. **Token counts are estimated.** Codex exposes no tokenizer, so `count_tokens` returns a
   deliberate over-estimate. Real per-turn usage comes back from Codex and is reported
   accurately in the `usage` field.

---

## Configuration

None is required. To change something, write
`<config>/codex-bridge/config.json` (see [docs/authentication.md](docs/authentication.md)
for the per-OS path):

```json
{
  "gateway": { "host": "127.0.0.1", "port": 4141 },
  "codex":   {
    "model": "auto",
    "reasoningEffort": null,
    "login": { "appBrand": "codex", "useHostedSuccessPage": false }
  },
  "logging": { "level": "info" }
}
```

Environment variables override the file: `CODEX_BRIDGE_PORT`, `CODEX_BRIDGE_HOST`,
`CODEX_BRIDGE_MODEL`, `CODEX_BRIDGE_REASONING_EFFORT`, `CODEX_BRIDGE_LOG_LEVEL`,
`CODEX_BRIDGE_DEBUG`, `CODEX_BIN`, `CODEX_BRIDGE_HOME`.

Binding a non-loopback address additionally requires `"gateway": {"allowNonLoopback": true}`
— it is refused otherwise, because it would expose your ChatGPT session to the network.

## Layout

```
packages/shared         types, config, logging, redaction, cross-platform helpers
packages/codex-client   the only code that knows the Codex App Server protocol
packages/gateway        Anthropic-compatible HTTP server + protocol translation
packages/cli            codex-bridge command line + gateway process management
packages/plugin         the Claude Code plugin (slash commands, hooks)
```

Zero runtime dependencies. TypeScript only for the build.

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit, and the one hard problem
- [Authentication](docs/authentication.md) — what the bridge does and does not touch
- [Protocol mapping](docs/protocol-mapping.md) — Anthropic ↔ Codex, field by field
- [Troubleshooting](docs/troubleshooting.md) — when it does not work

## Development

```bash
npm run build          # compile
npm test               # 162 unit + integration tests, no credentials needed
npm run test:e2e       # real end-to-end test against live Codex (needs a login)
npm run protocol:check # regenerate Codex bindings and diff against ours
```

## Uninstall

```bash
codex-bridge stop
codex-bridge unconfigure --scope user      # only if you ever ran configure
codex-bridge unconfigure --scope project   # per-repo, run inside that repo
node scripts/install.mjs --uninstall
```

## Security

The gateway binds `127.0.0.1`, requires a locally-generated bearer token on **every**
endpoint except the management page and health, rejects cross-site and non-loopback
requests, refuses to bind a public address without an explicit opt-in, caps request
bodies, and redacts secrets from every log line. Codex keeps sole ownership of your OAuth
credentials.

The implementation was reviewed adversarially (six dimensions, each finding independently
verified by a second reviewer); the confirmed findings are fixed and regression-tested.
See [docs/authentication.md](docs/authentication.md).

## License

MIT.
