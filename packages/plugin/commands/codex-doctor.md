---
description: Diagnose the Codex Bridge installation
argument-hint: "[--fix]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs:*)
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/codex-bridge.cjs" doctor $ARGUMENTS`

Show the report above verbatim. For each line marked ✗ or !, restate its suggested fix in
plain language. Do not attempt the fixes yourself unless the user asks — `--fix` repairs
the Claude Code configuration and nothing else.
