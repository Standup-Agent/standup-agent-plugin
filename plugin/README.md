# Standup Agent

Standups that write themselves. Standup Agent turns your real work in Claude Code into a daily standup. Each morning it drafts what you did since your last check-in — grouped by ticket, with the *why*, not a list of files. You send it in one tap, edit it, add a blocker, or skip the day. Your manager gets a team summary in Claude: blockers first, then who did what.

From the team behind Standuply — standups for software teams since 2015. Free during early access.

## Install

Requires Claude Code and Node.js 22 or newer (the plugin's hooks run on Node).

1. Install the plugin from the Claude plugin directory, or in Claude Code:
   ```
   /plugin marketplace add Standup-Agent/standup-agent-plugin
   /plugin install standup-agent@standup-agent
   ```
   Then restart Claude Code.
2. Join your team: paste the invite link your manager sent you (`standupagent.co/join/<CODE>`) into Claude Code as a regular message and confirm your name.

Managers create the team and read the summaries in Claude with the Standup Agent connector: see https://standupagent.co/#install-manager.

## How it works

- **When you start your first session of the day**, a `SessionStart` hook prepares your standup from your Claude Code sessions and git commits since the last standup you sent. Claude shows the draft with four options: Send, Edit, Add blocker, Not now.
- **When a session ends**, a `SessionEnd` hook saves a short local summary of that session, so tomorrow's draft has the context.
- **Only work repositories count.** When you join, the plugin asks which of your repositories are work ones. Personal projects never go into a standup.

Commands:

- `/standup` — the menu: show today's standup, add a note for tomorrow, or add to today's
- `/standup show` — show the draft now
- `/standup <text>` — add a note to your next standup
- `/standup notes` — list your notes
- `/standup repos` — which repositories go into your standup; mark one as work or personal
- `/standup leave` — leave the team and delete your data on the server

## Data handling and privacy

Private by design: nothing leaves your machine until you confirm it.

- **Stays on your computer:** your code, your Claude Code transcripts, raw session logs, local drafts and summaries, and anything from repositories you didn't mark as work. Local data is stored in the plugin's data folder and deleted after 30 days.
- **Sent to our server only when you confirm:** the standup text you approved and its structured parts (tasks, ticket IDs, next steps, blockers), the period it covers and the prompt version used to draft it.
- **Sent when you join:** your display name and email, which you confirm in the join step.
- **Sent as you use it:** usage events without any content (for example "standup shown", "sent", "postponed"), so your manager can see who checked in.
- **Where it goes:** the Standup Agent backend at `https://standupagent.co/api`, operated by Standuply, Inc. and hosted by Hetzner in Germany. The plugin sends data nowhere else.
- **Who sees it:** only your team's managers.
- **Retention and deletion:** standups are kept until you or your manager delete them. `/standup leave`, or being removed by your manager, deletes your standups and events. Requests: hello@standupagent.co.

Full privacy policy: https://standupagent.co/privacy · Terms: https://standupagent.co/terms

## For reviewers

A review team is ready: paste `Join the Standup Agent Review team in Standup Agent: standupagent.co/join/D3C6BAVFF4` into Claude Code after installing, confirm your name, open any git repository, make a small change with Claude, end the session, then start a new one and run `/standup`. Choose "Send" to deliver the standup to the review team.

## Support

hello@standupagent.co · https://standupagent.co

## License

MIT — see [LICENSE](LICENSE).
