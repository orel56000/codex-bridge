---
description: Stop the local Codex Bridge gateway
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" stop`

Report the result in one line. Note that Claude Code will fail to reach the gateway until
it is started again with `/codex-start`.
