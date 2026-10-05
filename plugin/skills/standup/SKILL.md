---
name: standup
description: Standup Agent — joining a team, the developer's morning standup, notes for it, and which repos go into it. Use when the user asks to join a Standup Agent team or sends a link like …/join/<CODE>; on /standup (the menu), /standup show, /standup <text> (a note), /standup notes, /standup repos, /standup leave; "write down for my standup: …", "add to today's standup: …", "what's in my standup notes", "which repos are in my standup", "turn repo X off/on in my standup", "this is a personal project, keep it out of my standup"; and when the Standup Agent hook asks to show the standup.
argument-hint: "[show | <note text> | notes | join <link> | leave | repos [scan] | repos set <path>=work|personal]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js *)
---

# Standup Agent

The manager only sees standups the developer confirmed. Code, chats and personal repos never leave the computer.

Run every command through Bash **exactly in this form** (no quotes around the cli.js path, no prefixes), otherwise a permission prompt appears:
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js --data ${CLAUDE_PLUGIN_DATA} <command>`

Below, `CLI` means exactly `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js --data ${CLAUDE_PLUGIN_DATA}`.

Talk to the user in their language — the one they write to you in. The quoted texts below (questions, headers, button labels and descriptions, confirmations) are English templates: say them in the user's language. The same goes for what the CLI prints (`note`, status lines): relay it in the user's language, don't paste it verbatim. Don't translate `standup.text` and `blocker_hint`: they're already in the developer's language.

What to do, by arguments:
- no arguments → "Menu";
- `show` → "Standup";
- `notes` → "My notes";
- `continue` → carry on from where you were (see the sections below);
- `join <link>`, or an invite link `…/join/<CODE>` in the user's message → "Joining a team";
- `leave` → "Leaving the team";
- `repos set …` → run `CLI repos set …` with the same arguments and confirm in one line;
- `repos scan` → "Initial repo marking";
- `repos` → "Viewing and changing repo marking";
- any other text (`/standup had a call with design: the banner moves to Friday`), or the user asks in words to write something down for the standup or add it to today's standup → "Quick note" with that text.

## Menu (`/standup` without arguments)

1. `CLI standup status` → `{joined, sent_today, notes}`. If `joined` is false, say in one line that they need to join a team first with the invite link from their manager, and stop.
2. Call AskUserQuestion, header "Standup", question "What do you want to do?". Options:
   - `sent_today` is false:
     - "Show the standup now" — "Build it, show it, send it in one tap";
     - "Note for the standup" — "A call, a review, a decision — goes into the next standup";
     - "My notes" — "<notes> waiting" (if `notes` is 0: "No notes yet").
   - `sent_today` is true:
     - "Add to today's standup" — "Your manager sees it in the next update";
     - "Note for tomorrow" — "Goes into tomorrow's standup";
     - "My notes" — as above.
3. By answer: "Show the standup now" → "Standup"; "Note for the standup" / "Note for tomorrow" → "Note"; "Add to today's standup" → "Addition to today's standup"; "My notes" → "My notes".

## Note

1. If you don't have the text yet, ask in one line what to write down. The answer comes as a new message: first call the Skill tool `standup-agent:standup` with args `continue`.
2. `CLI standup note add '<text>'` — the developer's words as they are (replace an apostrophe `'` with `’`). No LLM rewriting: don't polish, shorten or translate it.
3. Tell the user what the command printed, in one line.

## Quick note (`/standup <text>`, "write down for my standup: …")

1. `CLI standup status`.
2. `sent_today` is false → "Note" with this text, step 2. `sent_today` is true → AskUserQuestion, header "Standup", question "Where does it go?" with the text quoted under it, options: "Tomorrow's standup" — "Saved as a note for the next standup" / "Add to today's" — "Your manager sees it in the next update". Then "Note" step 2 or "Addition to today's standup" step 2.

## Addition to today's standup

For something that happened after today's standup was sent. It reaches the manager in their next update.

1. If you don't have the text yet, ask in one line what to add (a new message → first Skill `standup-agent:standup` with args `continue`).
2. AskUserQuestion, header "Standup", question "Add this to today's standup?", an empty line, then the text **verbatim**. Options: "Send" — "Your manager sees it in the next update" / "Edit" — "Tell me what to change".
3. **Send** → `CLI standup addendum '{"text": "<text exactly as shown>", "ticket": "<ticket id if the text or the branch names one, else null>"}'` (single quotes; replace `'` inside with `’`). Tell the user what it printed. **Edit** → apply exactly what they say, ask again.
4. If the command says today's standup isn't sent yet, offer to save it as a note instead ("Note", step 2).

## My notes (`/standup notes`)

1. `CLI standup note list`. No notes → say so in one line.
2. Show them as a numbered list (text; ticket or branch in brackets if set). Say they go into the next standup and sending it clears them.
3. Offer to delete: up to 4 notes — AskUserQuestion with `multiSelect: true`, header "Notes", question "Delete any of them?", an option per note (label — the start of its text, description — ticket or branch); more than 4 — ask for the numbers in text. Nothing chosen → leave them. Then `CLI standup note rm <n> <n> …` with the numbers from the list (numbers in a separate message → first Skill `standup-agent:standup` with args `continue`; run `note list` again before `rm`, the numbers may have shifted).

## Standup

1. Call the Skill tool: skill "standup-agent:synth", and wait for the result — it builds the standup in a separate context. Don't read the materials yourself and don't start subagents with Agent: only the finished standup comes into the main context.
2. The skill returns JSON `{"standup": {"text", "items", "blockers"}, "blocker_hint", "prompt_version"}` — keep all of it, you need it below. If `standup.text` is "NO WORK", say in one line that there's no work since the last standup and move on to the user's request.
3. The user **doesn't see** the `synth` result. Show the standup like this: call AskUserQuestion where `question` is the line "Send this standup to your manager?", an empty line, and then `standup.text` **verbatim and in full** (with edits applied). If `blocker_hint` is not null, add an empty line and `💡 <blocker_hint>` after the text (it's a hint, not part of the standup: don't add it to the text or to `blockers`). Don't repeat the text in a separate message. header "Standup", exactly 4 options in this order:
   - "Send" — "Goes to your manager as is";
   - "Edit" — "Tell me what to change";
   - "⚠️ Add a blocker" — "Let your manager know you're stuck";
   - "Not now" — "I'll remind you later".
4. By answer:
   - **Send** → `CLI standup send '<json>'`, where json is `{"text": "<text exactly as shown, without the 💡 hint>", "items": [...], "blockers": [...]}` from `standup` with edits applied; `blockers` only has what the developer added. JSON in single quotes; replace an apostrophe `'` inside with `’`. Tell the user what the command printed.
   - **Edit** → ask what to change (or take the edit from the answer if it's already there). Do exactly what the developer said and leave the rest alone — their wording wins, don't argue. Update the text and the JSON, run `CLI standup event edited`, then ask the same question again with the updated text inside.
   - **⚠️ Add a blocker** → ask in one sentence what's in the way (if there was a 💡 hint, offer its wording). Append a line `⚠️ <blocker>` to the text and add it to `blockers`, drop the hint, run `CLI standup event blocker`, then ask the question again with the updated text inside.
   - **Not now** → `CLI standup snooze`, tell the user what it printed.
   - The user ignored the question and asked for something else — just do what they asked.
5. Notes the developer wrote down (`/standup <text>`) are already in the draft; sending it clears them, "Not now" keeps them.
6. If the user sent the edit or the blocker **as a separate message**, the command permission has already been reset by then: first call the Skill tool `standup-agent:standup` again with args `continue`, then carry on from the same place (edit → show → question). `continue` resumes the current standup; don't call `synth` again.
7. After the answer, move on to the user's original request, if there was one.

## Joining a team

1. `CLI join-info '<the whole link>'`. On error, show it in one line and stop.
2. Before asking anything, show this message — in the user's language, translated faithfully: all three points, nothing softened or added. The privacy link goes small under it (`privacy_url`):

   > **Your standup, your call**
   > • Drafted on your computer from work repos only. Code and chats never leave it.
   > • Nothing reaches your team until you confirm.
   > • We store only the standups you send. Leave anytime with `/standup leave`.
   >
   > <sub>Privacy policy: <privacy_url></sub>

   Then call AskUserQuestion: question "Joining team <team_name> as <name> (<email>) — correct?" — name and email from `suggested` (if they're missing, ask in text). If `leaves_current_team`, add a line: "You'll leave the team <current_team>." header "Team", options: "Yes, join" and "Change name or email".
3. "Change…" → ask what to change (a new message → first Skill `standup-agent:standup` with args `continue`).
4. `CLI join '<link>' '<name>' '<email>'` (replace an apostrophe in the name with ’). The answer has `team_name`, `work_orgs`.
5. Go straight to "Initial repo marking" below. When it's done, offer the first standup right away: AskUserQuestion, header "Standup", question "Show your standup for the last days now?", options "Show it" — "Build it from the last 3 days" / "Later" — "Tomorrow morning in your first session". "Show it" → "Standup" (the sessions are still being picked up in the background: if it says there's no work, say it'll be there tomorrow morning).

## Leaving the team (`/standup leave`)

Confirm with AskUserQuestion: "Leave the team? Your standups will be deleted on the server and your local materials on this computer", options "Leave" / "Cancel". On "Leave" — `CLI leave` and tell the user its `note`.

## Initial repo marking (after joining a team or `/standup repos scan`)

1. `CLI repos scan`. Repos from the team's org (`auto_marked_work`) are already turned on by the scan — don't ask about them.
2. One message: "Found N repos you worked in this month. K are from your team's org, I turned them on: …". If `ask` is empty, that's it.
3. Ask about the repos in `ask` **once and on one screen**:
   - up to 4 repos — AskUserQuestion with `multiSelect: true`: question "Which of these repos are work? The rest will be personal", header "Repos", an option per repo (label — repo name, description — remote and last activity date);
   - more than 4 — a numbered list in text (name, remote, last activity; path if names clash) and ask to reply with the numbers of the work ones; the rest will be personal.
4. With one command `CLI repos set '<path>=work' '<path>=personal' …` mark the chosen ones `work` and the rest of `ask` `personal`. If the user declined to answer, write nothing. (If the numbers came in a separate message, first Skill `standup-agent:standup` with args `continue`.)
5. `backfill_sessions` in the answer is how many sessions from the last 3 days are being picked up in the background. Confirm: what's on, what's off, and that it can be changed with `/standup repos`.

## Viewing and changing repo marking (`/standup repos` without `scan`)

Here **don't run** `repos scan` and don't ask about unmarked repos. Run `CLI repos list` and show it briefly: work repos, then personal (by folder name; path if names clash). End with one line: "To mark the other repos you worked in this month: /standup repos scan". If the user asks to change something — `CLI repos set '<path>=work|personal'` and confirm in one line.
