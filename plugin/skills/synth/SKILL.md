---
name: synth
description: Builds the Standup Agent standup draft in a separate context. Called only from the standup-agent:standup skill.
user-invocable: false
context: fork
agent: standup-agent:standup-synth
background: false
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js *)
---

Build the standup draft following your instructions. The command for the materials:
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js --data ${CLAUDE_PLUGIN_DATA} standup prepare`
(further parts — the same command with `--part N`).
