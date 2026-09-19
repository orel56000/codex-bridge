# Troubleshooting

Start here:

```bash
codex-bridge doctor
```

It checks Node, the Codex install, the App Server, your ChatGPT session, the gateway, the
Claude Code configuration, model availability and connectivity — and every line that is not
a ✓ carries the fix.

---

## I want to keep using Claude models too

You can. Signing in does not reconfigure Claude Code; nothing routes through Codex until
you opt in, and there are three sizes of opt-in:

```bash
codex-bridge run                          # one session on Codex
codex-bridge configure --scope project    # one repo
codex-bridge configure --scope user       # every session on this machine
```

`run` is the one to use if you want both. It sets the environment for a single `claude`
process, so a Codex window and a normal Claude window can be open side by side, and
closing the window is the entire undo.

The `user` scope is the only one that takes your Claude models away, and it is the only
one that needs care to undo: Claude Code merges `settings.json` `env` into its process
environment, and removing a key does not unset it in a running process. So:

```bash
codex-bridge unconfigure --scope user
# then quit and restart Claude Code
```

Switching between them mid-conversation is not possible — Claude Code resolves its
provider when a session starts, not per message.

## Switching ChatGPT accounts

Run `/logincodex` again. It prints the account you are currently signed in as and then
starts a fresh sign-in anyway, so you can choose a different one. Cancelling (Ctrl-C, or
just closing the browser tab) leaves the existing account in place.

When the new account differs from the old one, the bridge drops its Codex threads — they
belong to the previous account's context and quota.

## Claude Code is still using Claude, not Codex

This is the most common report, and it usually has one of five causes.

**1. The session started before the configuration was written.** Claude Code applies
`settings.json` `env` when it builds a request, and in a trusted workspace it picks up
changes to the file. But if the session started with a different `ANTHROPIC_BASE_URL`
already in its environment, that wins. Start a new session.

**2. A shell export is overriding it.** Settings-file `env` beats a shell export inside
Claude Code, but a shell export beats *nothing* if the settings file was never written.
Check both:

```bash
echo "$ANTHROPIC_BASE_URL"
grep -A6 '"env"' ~/.claude/settings.json
```

**3. You are in the desktop app's Code tab.** See below — env vars do not work there.

**4. A managed-settings policy.** If your organisation sets `forceLoginMethod` or
`forceLoginOrgUUID`, Claude Code refuses a non-OAuth credential outright. You will see a
message about a first-party login being required. Nothing the bridge can do.

**5. An Anthropic profile is active.** A profile at `~/.config/anthropic` (from
`ant auth login`, or `ANTHROPIC_PROFILE`) outranks everything else and carries its own base
URL. `/status` shows a Profile row when one is in play.

Confirm which side is serving you by watching the gateway log while you send a message:

```bash
tail -f ~/Library/Application\ Support/codex-bridge/logs/codex-bridge.log
```

No entries means Claude Code is not talking to the bridge.

---

## Claude Code Desktop (the Code tab)

**Environment variables do not work here.** The desktop app overwrites
`ANTHROPIC_BASE_URL` with its own API host and blanks `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` in the session's environment. It reads
gateway routing from its own third-party inference configuration instead.

The supported route:

1. **Help → Troubleshooting → Enable Developer Mode**
2. **Developer → Configure Third-Party Inference**
3. Point it at the gateway URL from `codex-bridge status` and supply the gateway token as
   the key. `codex-bridge status --json` prints both.

Managed deployments can set `inferenceProvider=gateway` and `inferenceGatewayBaseUrl` by
MDM instead.

Turning that mode on costs you some desktop features: the environment picker stops offering
SSH and cloud environments, and Remote Control is unavailable. If you want the
no-caveats experience today, use the terminal CLI.

Note also that the two Claude Codes on your machine are **different builds** — the terminal
one from npm, and the desktop's own copy under its application-support directory. A working
terminal setup tells you nothing about the desktop one.

---

## `/model codex` does not exist

It cannot be made to exist, and the bridge does not pretend otherwise.

Claude Code's model alias list (`sonnet`, `opus`, `haiku`, `fable`, `best`, `opusplan`, …)
is a frozen constant in the binary with no settings or environment hook. `availableModels`
in settings is an allowlist filter, not a registration mechanism, and `modelOverrides` maps
Anthropic ids onto Bedrock/Vertex ids.

What the installer does instead — all supported, none of it cosmetic:

| Setting | Effect |
| --- | --- |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` = `codex` | whichever built-in row you pick in `/model`, the request is served by Codex |
| `ANTHROPIC_CUSTOM_MODEL_OPTION=codex` + `_NAME="Codex"` | a real, honestly-labelled **Codex** row in the picker |
| `/v1/models` returning `claude-*-bridge` ids | gateway model discovery; the names dodge two client-side filters — see [protocol-mapping.md](protocol-mapping.md#why-the-model-ids-look-like-that) |

The gateway maps *any* model name it receives to a Codex model anyway, so routing is
correct regardless of which row you choose.

---

## Errors you might see

**`Codex is not installed.`**
```bash
npm install -g @openai/codex     # or: brew install --cask codex
```
If it is installed somewhere unusual, point the bridge at it:
```bash
CODEX_BIN=/path/to/codex codex-bridge doctor
```

**`Your ChatGPT authentication expired.`** — `/logincodex`.

**`Codex usage limit reached.`** — `/codex-status` shows the real windows and reset times.
The bridge reports what Codex reports and never estimates.

**`Port 4141 is already in use. Using port 4142.`** — informational; the gateway walks
forward. If Claude Code was configured for the old port, run `codex-bridge doctor --fix`
and start a new session. To pin a port:
```bash
codex-bridge stop
CODEX_BRIDGE_PORT=4200 codex-bridge start
codex-bridge configure
```

**`Codex App Server exited unexpectedly. Attempting restart…`** — supervised with backoff,
up to five times. If it keeps happening, run `codex doctor` and check
`~/Library/Application Support/codex-bridge/logs/codex-bridge.log`.

**`The Codex Bridge gateway did not start.`** — the last log lines are included in the
error. Most often Codex itself cannot start; `codex app-server --help` is a quick check.

**401 from the gateway** — Claude Code's token does not match. `codex-bridge doctor --fix`
rewrites it, then start a new session.

---

## Behaviour that is different on Codex

| Thing | What happens |
| --- | --- |
| `[claude-code:unrecognized_model] {"model":"codex[1m]"}` | Harmless, and unavoidable. Claude Code logs this **before sending anything**, when it parses its own model alias and cannot match `codex` to a known family; the `[1m]` suffix is its 1M-context marker. Any custom model name produces it. The request is served normally. |
| `/cost` | Wrong. Claude Code prices unknown models from a hardcoded table. Use `/codex-status`. |
| Prompt caching | `cache_control` is accepted and ignored. Codex does its own caching; `cache_read_input_tokens` reflects it. |
| Extended thinking | Off unless the request enables it. Codex reasoning is not a signed Anthropic thinking block, so the signature is a clearly-marked synthetic value and the blocks are dropped on the way back in. |
| MCP tool search | Disabled by Claude Code on a non-first-party base URL. With many MCP servers your context will be larger. |
| Telemetry, WebFetch domain checks, fast-mode availability | Still go to `api.anthropic.com`, not through the gateway. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `skipWebFetchPreflight` reduce that. |
| Sub-agents | Get their own `session_id`, so their own Codex thread. Expected. |
| `/compact` | Rewrites the transcript; the bridge detects the divergence and rebuilds the Codex thread, replaying the compacted history. |

---

## Debugging

```bash
CODEX_BRIDGE_DEBUG=1 codex-bridge restart
tail -f ~/Library/Application\ Support/codex-bridge/logs/codex-bridge.log
```

Debug logs include stack traces and full protocol traffic, with secrets redacted — there is
no flag that turns redaction off.

Talk to the gateway directly:

```bash
TOKEN=$(codex-bridge status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["gateway"]["url"])')
curl -s localhost:4141/health
curl -s localhost:4141/admin/status | python3 -m json.tool
```

Run the whole acceptance test against live Codex:

```bash
npm run test:e2e
```

Run everything that needs no credentials:

```bash
npm test
```

---

## Clean slate

```bash
codex-bridge stop
codex-bridge unconfigure                 # undo the Claude Code settings
node scripts/install.mjs --uninstall     # remove the plugin
rm -rf ~/Library/Application\ Support/codex-bridge
```

Your Codex login is untouched by all of this — it belongs to Codex. Use `codex logout` if
you want that gone too.

---

## Reporting a problem

Include:

```bash
codex-bridge doctor
codex-bridge version
codex --version
claude --version
node --version
```

and the tail of `codex-bridge.log`. It is already redacted, but skim it anyway.

## The picker shows Codex but no Claude models

Both live behind one gateway, but only Codex works without setup: Claude models
are forwarded to `api.anthropic.com` and that needs a credential of your own.

```bash
codex-bridge anthropic --status
```

This makes a real request rather than checking that a value exists, so it
distinguishes the two cases that look identical from the picker:

```
Claude passthrough: enabled, but NOT working
Credential:         rejected — subscription token rejected with HTTP 401 — OAuth access token is invalid.
```

A **rejected** credential is usually one that was copied by hand. The token is
around 100 characters, so a terminal displays it wrapped across several lines —
and selecting wrapped text carries the line breaks into the clipboard. Anything
that reads only the first line stores a truncated token that still *looks*
well-formed, and every request comes back `401 OAuth access token is invalid`
with nothing saying it was cut short.

`--token-stdin` rejoins a wrapped paste, so use it rather than `--token`:

```bash
claude setup-token                  # authorise in the browser
codex-bridge anthropic --token-stdin   # paste at the prompt; wrapping is fine
```

Storing now fails loudly instead of silently saving something that cannot work,
and `/codex-doctor` reports the same check.

While no Claude credential works, Codex keeps the `opus` / `sonnet` / `haiku`
slots, so the picker still has entries. As soon as one does work, real Claude
models appear with their own tiers and Codex stops claiming the defaults —
picking "Opus" then really is Opus. If your desktop config pins an explicit
`inferenceModels` list, regenerate it from `GET /v1/models` afterwards so the
new Claude rows are included.


## Opening normal Claude opens the bridge instead

The two instances stop being separate, and turning one off turns off the other.

Claude Desktop decides where to read its deployment config with one line:

```js
function profileDir(){
  const dir = app.getPath("userData");
  return dir.endsWith("-3p") ? dir : `${dir}-3p`;   //  Claude  ->  Claude-3p
}
```

Both `deploymentMode` and `configLibrary/` are read from whatever that returns. So a
bridge profile at `Claude-3p` is *exactly* where the normal instance — whose userData is
`Claude` — goes looking. It finds the gateway config there, adopts it, and relocates
itself into the bridge profile. And since `deploymentMode` lives in that same shared
directory, setting it to `"1p"` to get your normal Claude back also disables the bridge.
There is no per-instance setting; that is why it ping-pongs.

**The fix is the profile's name.** The bridge lives at `ClaudeCodex-3p`:

| Instance | userData | reads config from | result |
| --- | --- | --- | --- |
| normal Claude | `…/Claude` | `…/Claude-3p` — absent | stays first-party |
| the bridge | `…/ClaudeCodex-3p` | itself (already ends `-3p`) | gateway mode |

`npm run claudecodex` moves an old `Claude-3p` profile across automatically and clears a
`deploymentMode` left on `"1p"`. Verified by launching the real app against both shapes:
a profile with no `-3p` sibling comes up on `https_claude.ai_0` (first-party), and one
named `…-3p` with a gateway config comes up on `app_localhost_0` (third-party).

**Windows is different and cannot be separated this way.** There the app returns
`join(LOCALAPPDATA, "Claude-3p")` unconditionally, ignoring `--user-data-dir` for this
purpose, so both instances always read the same directory. Run the bridge or normal
Claude, not both.
