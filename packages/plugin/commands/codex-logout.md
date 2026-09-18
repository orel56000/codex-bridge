---
description: Disconnect the ChatGPT account from Codex
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" logout`

Report the result. Codex owns the stored credentials and has removed them itself; the
bridge never held a copy. Mention that `/logincodex` reconnects.
