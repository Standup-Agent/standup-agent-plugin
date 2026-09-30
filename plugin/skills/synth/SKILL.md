---
name: synth
description: Собирает черновик стендапа Standup Agent в отдельном контексте. Вызывается только из скилла standup-agent:standup.
user-invocable: false
context: fork
agent: standup-agent:standup-synth
background: false
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js *)
---

Собери черновик стендапа по своим инструкциям. Команда для материалов:
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js --data ${CLAUDE_PLUGIN_DATA} standup prepare`
(следующие части — та же команда с `--part N`).
