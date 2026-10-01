# Standup Agent — Claude Code plugin

Writes your standup from your work in Claude Code. In the morning you get a ready draft: what got done on each task since your last check-in, what's next, whether anything is blocking you. Send it in one tap or edit it first.

**Privacy.** Your manager only sees standups you confirmed. Code, chats and personal repos never leave your computer.

## Install

Your manager gives you the invite page `standupagent.co/join/<CODE>` with these lines:

```
/plugin marketplace add Standup-Agent/standup-agent-plugin
/plugin install standup-agent@standup-agent
```

Restart Claude Code, then join the team by pasting this as a regular message:

```
Join the Backend team in Standup Agent: standupagent.co/join/K7X2M9QPLA
```

Requires Node.js ≥ 22 (the plugin hooks run on it). On the first standup Claude Code asks permission for the plugin's skills — choose "don't ask again".

## Commands

| Command | What it does |
|---|---|
| `/standup` | show the standup now |
| `/standup repos` | see and change which repos are work and which are personal |
| `/standup join <CODE>` | join a team if the link wasn't recognized |
| `/standup leave` | leave the team and delete your data on the server |

## How it works

1. **Capture (no LLM).** When a session ends, a hook takes your messages and Claude's text replies from the transcript, and the branch, commits and changed files from git. Secrets are stripped, and the result goes into a local store. Nothing from personal repos is stored at all.
2. **Synthesis.** On the first session of the day, the plugin's subagent turns the store into a standup by ticket (`PROJ-123`) or branch.
3. **Confirmation.** Send / Edit / ⚠️ Add a blocker / Not now. Only what you send reaches the server.

Raw materials stay on your computer for 30 days and are never sent anywhere.
