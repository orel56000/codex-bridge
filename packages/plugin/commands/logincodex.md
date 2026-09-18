---
description: Connect (or switch) the ChatGPT account Codex uses
argument-hint: "[--device]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

# Connect Codex

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" login --start $ARGUMENTS`

A ChatGPT sign-in has been started through the official Codex App Server. If an account
was already connected, its details are shown above and a **fresh** sign-in has been
started anyway, so a different account can be chosen — cancelling leaves the current one
in place.

Now wait for the user to finish signing in by running exactly this command with a 15
minute timeout:

```
"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" login --wait --timeout 780
```

Report its output verbatim, including the list of ways to route Claude Code through
Codex. If it fails, report the error as-is and suggest `/logincodex --device` as the
fallback. Do not retry automatically more than once.

Then make sure the user understands this, because it is the part people get wrong:

> Signing in does **not** change how Claude Code runs. Your normal sessions keep using
> Claude models. `codex-bridge run` starts one session on Codex and changes nothing else;
> `codex-bridge configure --scope project` opts in a single repo; `--scope user` opts in
> every session on the machine and needs a restart to undo.
