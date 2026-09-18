---
description: Explain how to start a Claude Code session running on Codex
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" status`

Using the status above, tell the user how to run Claude Code on Codex. A session cannot
switch its own model provider mid-flight — Claude Code reads that when it starts — so
this is about starting a session, not changing this one.

If the account is connected, give them these three, in this order:

```bash
codex-bridge run                          # one session on Codex, nothing else changes
codex-bridge configure --scope project    # this repo only
codex-bridge configure --scope user       # every session on this machine
```

Say plainly that only the third one affects their other Claude Code sessions, and that
undoing it needs `codex-bridge unconfigure --scope user` plus a restart.

If the account is not connected, tell them to run `/logincodex` first and stop.
