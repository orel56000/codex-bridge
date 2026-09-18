# Authentication

## The short version

The bridge does not implement OAuth. It asks the official `codex app-server` to run the
login it already knows how to run, and Codex keeps the resulting credentials.

At no point does the bridge read, store, copy, refresh, log or transmit an access token, an
ID token, or a refresh token.

## The flow

```
/logincodex
     │
     ▼
codex-bridge login --start
     │
     ├─ ensure the gateway is running
     ├─ account/read              ──▶ already signed in? report and stop
     │
     ├─ account/login/start       ──▶ { type: "chatgpt",
     │                                  useHostedLoginSuccessPage: false,
     │                                  appBrand: "codex" }
     │   ◀── { loginId, authUrl }
     │
     └─ open authUrl in the OS default browser
              │
              ▼  (user signs in with ChatGPT; OpenAI redirects to Codex's own callback)
              │
     ◀── account/login/completed { loginId, success, error }
              │
codex-bridge login --wait
     │
     ├─ account/read              ──▶ { account: { type: "chatgpt", email, planType } }
     └─ write ANTHROPIC_BASE_URL + the gateway token into Claude Code's settings
```

`account/login/completed` is a **notification**, not a response, which is why the login is
split into `--start` and `--wait`: the gateway holds the pending login and the CLI polls
it. That also keeps `/logincodex` from being killed by the prompt-build timeout while a
human is typing a password.

### Why those two flags

`useHostedLoginSuccessPage: false` makes Codex finish the flow on the page it
serves itself from its local callback (`http://localhost:1455/auth/callback`).
Set it to `true` and the browser is forwarded to OpenAI's hosted success page
instead, which — combined with `appBrand: "chatgpt"` — offers to open the
**ChatGPT desktop app**. That is a confusing detour when you started from a
terminal, so the defaults avoid it. To get the ChatGPT-branded flow back:

```json
{ "codex": { "login": { "appBrand": "chatgpt", "useHostedSuccessPage": true } } }
```

## Device-code fallback

If the browser callback cannot work — a remote shell, a container, a machine with no
browser — `/logincodex --device` uses the official device flow:

```
account/login/start { type: "chatgptDeviceCode" }
  ◀── { loginId, verificationUrl, userCode }
```

```
Open this URL:

  https://auth.openai.com/codex/device

Code:

  ABCD-1234
```

The wait is identical; the same `account/login/completed` notification ends it.

## Where the credentials live

In Codex's own store, under `$CODEX_HOME` (default `~/.codex`), exactly as if you had run
`codex login` yourself. If your platform's Codex build uses the OS keyring, they stay
there. The bridge:

- never reads `auth.json`;
- never copies credentials into its own config or state;
- never passes a token to the HTTP layer;
- lets Codex refresh tokens on its own schedule (`account/read` takes a `refreshToken`
  flag, which asks *Codex* to refresh — it does not hand us anything).

`codex-bridge logout` calls `account/logout`. It does not delete files.

If the App Server asks the client to supply tokens — the `account/chatgptAuthTokens/refresh`
server request, used by hosts that manage auth externally — the bridge does not answer it
with credentials. We are a managed-auth client; Codex owns the refresh.

## What the bridge *does* store

| File | Contents | Permissions |
| --- | --- | --- |
| `<config>/codex-bridge/config.json` | gateway host/port, model aliases, log level, and the **gateway token** | `0600` |
| `<state>/codex-bridge/run/gateway.json` | pid, port, url, gateway token | `0600` |
| `<state>/codex-bridge/sessions.json` | Claude-session → Codex-thread ids, timestamps | `0600` |
| `<state>/codex-bridge/logs/*.log` | structured JSON logs, secrets redacted | `0600` |

The **gateway token** is a locally-generated random string (`cbk_` + 24 random bytes). It
authenticates Claude Code to the local gateway and has nothing to do with OpenAI or
Anthropic. It is written into Claude Code's `settings.json` as `ANTHROPIC_AUTH_TOKEN`,
which is also written `0600`.

Paths, per OS:

| | config | state |
| --- | --- | --- |
| macOS | `~/Library/Application Support/codex-bridge` | same |
| Linux | `$XDG_CONFIG_HOME` or `~/.config/codex-bridge` | `$XDG_STATE_HOME` or `~/.local/state/codex-bridge` |
| Windows | `%APPDATA%\codex-bridge` | `%LOCALAPPDATA%\codex-bridge` |

Override with `CODEX_BRIDGE_HOME`.

## Redaction

Every log line goes through `redact()` first. It replaces the values of keys matching
`authorization`, `cookie`, `*token*`, `*api*key*`, `secret`, `password`, and anything
nested under `tokens.` or `auth.`, and additionally scrubs inline patterns: JWTs,
`rt.*` refresh tokens, `sk-…`, `sk-ant-…`, `gh[pousr]_…`. It bounds depth, string length
and array length, and breaks cycles, so a debug log cannot be made to dump a whole payload.

`CODEX_BRIDGE_DEBUG=1` raises the level to `debug`. It does **not** disable redaction —
there is no flag that does.

The integration suite asserts that nothing token-shaped ever appears in an HTTP response.

## The gateway token

Everything except `/`, `/health` and `/api/hello` requires the token. That includes the
whole `/admin/*` API — the management page is served with the token embedded in it and
sends it as a bearer like any other client.

This is not a formality. A loopback bind is **not** an access control: any web page you
visit can `fetch('http://localhost:4141/admin/logout', {mode:'no-cors'})`, which sends
`Host: localhost`, is a CORS "simple request" so is never preflighted, and would otherwise
reach the handler and destroy your ChatGPT session. Three things stop it:

1. `/admin/*` requires the bearer token, which a cross-site page cannot read.
2. Any request carrying a cross-site `Origin` or `Sec-Fetch-Site` is refused with 403.
   Browsers attach these to exactly those requests; Claude Code and curl send neither, so
   legitimate callers are unaffected.
3. Non-loopback `Host` headers are refused, which is what defeats DNS rebinding.

## Threat model

What the gateway defends against:

- **Other users on the machine** — loopback bind, `0600` state files, a required bearer
  token compared with `timingSafeEqual`.
- **A web page in your browser reaching the gateway** — the three layers above.
- **Binding the gateway to the network by accident** — a non-loopback `gateway.host` is
  refused unless `gateway.allowNonLoopback` is also set, and then it warns loudly.
- **Un-normalised request paths** — `//admin/status` and `/..//v1/messages` are rejected
  with 400 before routing, so a doubled slash cannot slip past an authorisation check.
- **A hostile `authUrl`** — the URL is parsed and refused unless it is `http(s)`, and it is
  passed as an argv element, never through a shell.
- **Command injection via config** — `-c key=value` overrides are validated against a
  dotted-path pattern, and no child process is ever spawned with `shell: true`.
- **Resource exhaustion** — request bodies are capped (32 MB default), JSON-RPC lines are
  capped (64 MB), sessions are capped and idle-evicted.

What it does **not** defend against, by design:

- Another process running as **you** on the same machine. It can read `0600` files.
- Anything you type into the ChatGPT login page. That is between you and OpenAI.
- Claude Code itself. The gateway trusts the system prompt and tool definitions it is sent.

## Verifying it yourself

```bash
# The admin API refuses an unauthenticated caller:
curl -s -o /dev/null -w '%{http_code}\n' localhost:4141/admin/status         # expect 401

# ...and a cross-site one, even with the token:
TOKEN=$(codex-bridge status --json >/dev/null 2>&1; \
  python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/codex-bridge/run/gateway.json')))['token'])")
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" \
  -H 'origin: https://evil.example.com' localhost:4141/admin/status           # expect 403

# The gateway never returns credentials:
curl -s -H "authorization: Bearer $TOKEN" localhost:4141/admin/status | grep -Ei 'eyJ|refresh_token'
echo "exit=$?"                                                                # expect no match

# Logs contain no secrets:
grep -REi 'eyJ[A-Za-z0-9_-]{20,}|rt\.[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}' \
  ~/Library/Application\ Support/codex-bridge/logs/ ; echo "exit=$?"          # expect no match

# The bridge never opens Codex's credential file:
#   macOS:  sudo fs_usage -w -f filesys | grep auth.json
#   Linux:  strace -f -e trace=openat -p <gateway pid> 2>&1 | grep auth.json
```
