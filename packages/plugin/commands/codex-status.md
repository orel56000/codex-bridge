---
description: Show Codex connection, gateway and usage status
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" status`

Present the status above to the user as-is. Do not invent or estimate any usage numbers
that are not printed — if usage is absent it is because Codex did not report it.
