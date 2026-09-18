---
description: Restart the local Codex Bridge gateway and Codex App Server
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" restart`

Report the result in one line. In-flight Codex conversations are dropped by a restart;
the next message starts a fresh Codex thread.
