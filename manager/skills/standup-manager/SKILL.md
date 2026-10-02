---
name: standup-manager
description: Team standups for the manager in Claude (Cowork) through the Standup Agent connector. Use when the manager asks to set up, connect, fix or change the team's standups, digests or checks ("set up standups", "a team digest every morning"); when a run comes from the scheduled task "Standup <team>"; and when the manager, in any chat, discusses the standup — decides, asks, assigns or clarifies something about the team's people or tasks.
---

# Standups for the manager

How it works for the manager:
- One recurring scheduled task per team: on weekdays, every hour. The first run of the day sends the morning digest, the rest only what's new (late standups, new blockers).
- One pinned document "Standups <team>" with a tab per day — the single place to look.
- The manager's discussions (decisions, questions, assignments) go to the day log on the server. Every next run shows the new things first, then "Earlier today", discussions included. So it doesn't matter in which chat the manager asked.

The source of truth is the Standup Agent server (the day log, cursors, the format). The document is the display. You write the digests strictly following `format_instruction` from the server's response, adding nothing beyond the data.

Talk to the manager in their language — the one they write to you in. The quoted texts below (headings, section names, confirmations) are English templates: say them in the manager's language. Server hints and errors are in English: retell them in the manager's language.

---

## Mode 1. Setup (once per team)

When: the manager asks to set up or fix the standups, or has just created a team with `create_team`.

1. **Team.** `list_teams`. If there are several teams and the manager didn't name one, ask which to set up.
2. **Schedule.** Take the team's `timezone` and `digest_time` from the server. If they're missing, ask the manager in one question: their timezone and when the morning digest suits them (default 10:00). Working hours by default: from the morning digest until 19:00, weekdays.
3. **Document.** If `get_day` returned no `doc_url`: create a Claude Docs document "Standups <team>", save its link with `set_doc(team, url)` and pin the document in the sidebar. If there is a link, don't create a second one.
4. **Task.** With `list_triggers`, check whether the task "Standup <team>" already exists.
   - It exists and is enabled — don't create a duplicate. Compare the schedule and the prompt; if they differ, fix them with `update_trigger`.
   - It exists and is disabled — enable it.
   - It doesn't exist — create it with `create_trigger`:
     - `name`: exactly "Standup <team>" (don't translate: this is how the task is found later);
     - `cron_expression`: `CRON_TZ=<timezone> <M> <H1>-<H2> * * 1-5`, where the first run is 5 minutes before `digest_time` (for 10:00 → minute 55, H1 = 9) and the last one is around 19:00;
     - `prompt` — verbatim, with the values filled in:
       ```
       Scheduled run: standups of team <team> (id <team_id>).
       Follow the standup-manager skill, mode "Scheduled run".
       If you don't have the skill, call check for the team, follow format_instruction from the response, and after sending call ack with the cursor from check.
       ```
5. **Test.** Fire the task once (`fire_trigger`) and make sure the message arrived and today's tab was updated.
6. **Summary for the manager** — 2–3 lines: when the morning digest arrives, how often the checks run, where the document is. Say which permission mode the task runs in: if its runs will ask for confirmation, suggest turning on auto-approval in the task settings.

---

## Mode 2. Scheduled run

When: the message starts with "Scheduled run: standups of team …".

1. Call `check(team)`. The server decides the mode itself (`mode`: `morning` / `update`) and returns what's new, the day context (`day`), `doc_url`, `format_instruction` and `cursor`.
2. If `nothing_new: true` — send the manager nothing, write nothing to the document, finish with the line "No new updates". No `ack` needed.
3. **Document.** Open `doc_url` and find the tab with today's date (DD.MM, in the team's timezone). No tab — create one with the sections "Morning standup", "Updates", "Discussed and decided", "Open questions".
   - `morning` → the digest goes to "Morning standup".
   - `update` → to "Updates", one line with the time: "14:55 — Pete (late): …".
4. **Message to the manager** (SendUserMessage), following `format_instruction`:
   - First **what's new**: blockers first. In `update` mode, late standups in full, marked "late".
   - Then, in `update` mode, **"Earlier today"** — 2–4 lines from `day`: the main thing from the morning digest, what was discussed and decided, which questions are open.
   - At the end — the link to the document.
5. **Notification** — by the rules of `format_instruction`: after the morning digest always (how many checked in, how many blockers); during the day only on a new blocker.
6. **`ack(team, cursor)`** — only after the message is sent and the document is written. If anything failed before that, don't call `ack`: the next run will get the same data again.

---

## Mode 3. The manager discusses the standup (in any chat)

When: about the standup or the team's people and tasks, the manager decides, asks, assigns or clarifies something. For example: "on downgrades we refund to the balance", "ask Mike when the wallet gets topped up", "what's up with TON?".

1. Answer the question from the data. For today use `get_day(team)`, for the past — `get_history`.
2. Save the gist with `add_note(team, kind, text, member?, ticket?)`. The date is today in the team's timezone (the server sets it).
   - `decision` — a decision made;
   - `question` — a question with no answer yet;
   - `answer` — an answer to an earlier open question (pass `reply_to` with its id from `open_questions` in `get_day`; the question closes);
   - `task` — an assignment to a specific person.
3. Copy it to today's tab of the document: decisions and answers to "Discussed and decided", open questions and assignments to "Open questions".
4. Confirm in one line: "Saved to today's log: …".

Don't save small talk, repeats or what's already in the standups. Save only what the manager will want to see in "Earlier today".

---

## Rules

- The log belongs to the day. Carrying unresolved items over to the next day isn't done yet.
- Don't make up anything beyond the server's data. Don't translate tickets, names and branches.
- Never create a second task for the same team. Always `list_triggers` before creating one.
- If a server tool returned an error, tell the manager in one line what didn't work and what to do. Don't pretend it all went fine.
