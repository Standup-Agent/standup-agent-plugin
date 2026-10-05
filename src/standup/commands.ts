/**
 * `standup prepare [--part N] | send '<json>' | snooze | event <type> | status | note add|list|rm |
 * addendum '<json>'` — run by Claude through Bash from the standup skill and the synthesis
 * subagent. Output is for Claude to read.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueAddendum, enqueueEvent, enqueueReport, flush, memberToken, type EventType, type Report, type ReportItem } from '../api.js';
import { findSessions } from '../capture/discover.js';
import { runCapture } from '../capture/worker.js';
import { CAPTURE, DEFAULTS } from '../config.js';
import { writeFileAtomic } from '../fsutil.js';
import { log } from '../log.js';
import { dataDir, paths } from '../paths.js';
import { standupPrompt } from '../prompt.js';
import { readState, updateState, workRepos } from '../state.js';
import { collect, render } from './materials.js';
import { addNote, NOTE_MAX_CHARS, readNotes, removeNotes } from './notes.js';
import { localDate, periodFrom } from './schedule.js';
import { REPO_ID_RE, writeDigest } from '../store.js';

const H = 3_600_000;
const partsFile = () => join(dataDir(), 'standup-materials.json');

export async function standupCommand(args: string[], pluginRoot: string, now = new Date(), cwd = process.cwd()): Promise<{ code: number; out: string }> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'prepare':
      return prepare(rest, pluginRoot, now);
    case 'send':
      return send(rest.join(' '), now);
    case 'snooze':
      return snooze(now);
    case 'save-digests':
      return saveDigests(rest.join(' '));
    case 'event': {
      const type = rest[0] as EventType;
      if (!['edited', 'blocker'].includes(type)) return { code: 1, out: 'usage: standup event edited|blocker' };
      enqueueEvent(type, now);
      return { code: 0, out: 'ok' };
    }
    case 'status':
      return status(now);
    case 'note':
      return note(rest, now, cwd);
    case 'addendum':
      return addendum(rest.join(' '), now);
    default:
      return {
        code: 1,
        out: "usage: standup prepare [--part N] | send '<json>' | save-digests '<json>' | snooze | event edited|blocker | status | note add '<text>' | note list | note rm <n>… | addendum '<json>'",
      };
  }
}

/** What the /standup menu needs: is today's standup sent (then it can be added to), how many notes wait. */
function status(now: Date): { code: number; out: string } {
  const st = readState().standup ?? {};
  const sentToday = st.done_date === localDate(now) && !!st.sent_report_id;
  return { code: 0, out: JSON.stringify({ joined: memberToken() !== null, sent_today: sentToday, notes: readNotes().length }, null, 2) };
}

/** `note add '<text>'` (secrets filtered, branch and ticket attached in a work repo) | `note list` | `note rm <n|id>…`. */
function note(args: string[], now: Date, cwd: string): { code: number; out: string } {
  const [sub, ...rest] = args;
  if (sub === 'add') {
    const r = addNote(rest.join(' '), cwd, now);
    if (typeof r === 'string') return { code: 1, out: r };
    log('info', 'standup: note added', { ticket: !!r.note.ticket, branch: !!r.note.branch, redacted: r.redacted });
    const where = r.note.ticket ?? r.note.branch;
    return {
      code: 0,
      out: `Note saved${where ? ` (${where})` : ''}: it goes into your next standup and reaches your manager only when you send it.${r.redacted ? ` ${r.redacted} secret(s) were masked.` : ''}`,
    };
  }
  if (sub === 'list') {
    const notes = readNotes().map((n, i) => ({ n: i + 1, text: n.text, ticket: n.ticket ?? null, branch: n.branch ?? null, written: n.ts }));
    return { code: 0, out: JSON.stringify({ notes, note: notes.length ? 'They go into your next standup; sending it clears them.' : 'No notes.' }, null, 2) };
  }
  if (sub === 'rm' && rest.length > 0) {
    const removed = removeNotes(rest);
    return { code: removed ? 0 : 1, out: removed ? `Deleted: ${removed}. Left: ${readNotes().length}.` : 'No such notes — see standup note list.' };
  }
  return { code: 1, out: "usage: standup note add '<text>' | note list | note rm <n|id>…" };
}

/**
 * Add to today's sent standup: what happened after it was sent. Goes to the manager's next update.
 * The developer confirms the text before this runs.
 */
async function addendum(json: string, now: Date): Promise<{ code: number; out: string }> {
  let input: { text?: unknown; ticket?: unknown };
  try {
    input = JSON.parse(json) as typeof input;
  } catch {
    return { code: 1, out: 'The argument must be JSON {text, ticket} in single quotes (replace apostrophes inside with ’).' };
  }
  const text = str(input.text);
  if (!text) return { code: 1, out: 'text is required — the addition exactly as the developer confirmed it' };
  if (text.length > NOTE_MAX_CHARS) return { code: 1, out: `The addition is too long (at most ${NOTE_MAX_CHARS} characters).` };
  const st = readState().standup ?? {};
  if (st.done_date !== localDate(now) || !st.sent_report_id) {
    return { code: 1, out: 'Today’s standup isn’t sent yet — save this as a note instead: standup note add.' };
  }
  enqueueAddendum(st.sent_report_id, { id: randomUUID(), text, ticket: str(input.ticket) });
  enqueueEvent('amended', now);
  const r = await flush(now.getTime());
  log('info', 'standup: addendum', { delivered: r.left === 0, stopped: r.stopped });
  if (r.left === 0) return { code: 0, out: 'Added to today’s standup: your manager will see it in the next update.' };
  return { code: 0, out: 'Saved, but the server is unreachable right now — it will be sent automatically next time Claude Code starts.' };
}

/**
 * Part 1 collects materials since last_checkin, remembers the period, marks the standup as being
 * shown (other terminals wait) and snoozes it until an answer comes; later parts come from the snapshot.
 */
/**
 * Sessions still open (this one too) or closed without SessionEnd hold work since their last
 * capture: capture them now, so the standup sees today, not only what ended before it.
 */
async function captureFresh(from: Date): Promise<void> {
  const state = readState();
  const jobs = findSessions({
    projectsDir: paths.claudeProjects(),
    repos: workRepos(state),
    sinceMs: from.getTime(),
    captures: state.captures ?? {},
    reason: 'standup',
    max: CAPTURE.recoverMaxSessions,
  });
  if (jobs.length > 0) await runCapture(jobs);
}

async function prepare(args: string[], pluginRoot: string, now: Date): Promise<{ code: number; out: string }> {
  const partArg = args.indexOf('--part');
  const part = partArg >= 0 ? Number(args[partArg + 1]) : 1;
  if (!Number.isInteger(part) || part < 1) return { code: 1, out: 'usage: standup prepare [--part N]' };

  let parts: string[];
  if (part === 1) {
    const from = periodFrom(readState(), now);
    await captureFresh(from);
    const state = readState();
    const prompt = await standupPrompt(pluginRoot, now.getTime());
    parts = render(collect(from, now, workRepos(state)), prompt);
    writeFileAtomic(partsFile(), JSON.stringify(parts));
    updateState((s) => {
      s.standup = {
        ...s.standup,
        pending: { from: from.toISOString(), to: now.toISOString(), prompt_version: prompt.version, note_ids: readNotes().map((n) => n.id) },
        showing_until: new Date(now.getTime() + DEFAULTS.showLockMinutes * 60_000).toISOString(),
        // No answer (the user went straight to an emergency) = ask again later, like «Not now».
        snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString(),
      };
    });
    enqueueEvent('shown', now);
  } else {
    try {
      parts = JSON.parse(readFileSync(partsFile(), 'utf8')) as string[];
    } catch {
      return { code: 1, out: 'No prepared materials: run standup prepare without --part first.' };
    }
  }
  if (part > parts.length) return { code: 1, out: `There are only ${parts.length} parts.` };
  const header = parts.length > 1 ? `[Part ${part} of ${parts.length}${part < parts.length ? ` — next: standup prepare --part ${part + 1}` : ''}]\n` : '';
  return { code: 0, out: header + parts[part - 1] };
}

interface SendInput {
  text?: unknown;
  items?: unknown;
  blockers?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Validate what Claude passes; the period and prompt version come from `prepare`, not from Claude. */
export function buildReport(input: SendInput, pending: { from: string; to: string; prompt_version: string }, now: Date): Report | string {
  const text = str(input.text);
  if (!text) return 'text is required — the standup exactly as the developer saw it';
  if (!Array.isArray(input.items)) return 'items is required: [{ticket, branch, done, why, next}]';
  const items: ReportItem[] = [];
  for (const raw of input.items as unknown[]) {
    const i = (raw ?? {}) as Record<string, unknown>;
    const done = str(i.done);
    if (!done) return 'every item needs a done field';
    items.push({ ticket: str(i.ticket), branch: str(i.branch), done, why: str(i.why), next: str(i.next) });
  }
  const blockers = Array.isArray(input.blockers) ? input.blockers.map(str).filter((b): b is string => b !== null) : [];
  return { id: randomUUID(), date: localDate(now), period: { from: pending.from, to: pending.to }, items, blockers, text, prompt_version: pending.prompt_version };
}

async function send(json: string, now: Date): Promise<{ code: number; out: string }> {
  let input: SendInput;
  try {
    input = JSON.parse(json) as SendInput;
  } catch {
    return { code: 1, out: 'The argument must be JSON {text, items, blockers} in single quotes (replace apostrophes inside with ’).' };
  }
  const state = readState();
  const pending = state.standup?.pending ?? { from: periodFrom(state, now).toISOString(), to: now.toISOString(), prompt_version: 'unknown' };
  const report = buildReport(input, pending, now);
  if (typeof report === 'string') return { code: 1, out: report };

  enqueueReport(report);
  enqueueEvent('sent', now);
  // Confirmed and queued = sent from the developer's side: the next standup starts after this period
  // even if the network is down now; the queue delivers it later.
  updateState((s) => {
    s.last_checkin = report.period.to;
    s.standup = { done_date: localDate(now), sent_report_id: report.id };
  });
  // The notes it was built from are in the standup now; notes written while it was shown stay.
  if (pending.note_ids?.length) removeNotes(pending.note_ids);
  const r = await flush(now.getTime());
  log('info', 'standup: sent', { items: report.items.length, blockers: report.blockers.length, delivered: r.left === 0, stopped: r.stopped });
  if (r.left === 0) return { code: 0, out: 'Sent to your manager.' };
  if (r.stopped === 'no_token') return { code: 0, out: 'Saved. It will go to your manager once you join a team.' };
  return { code: 0, out: 'Saved, but the server is unreachable right now — it will be sent automatically next time Claude Code starts.' };
}

/** First «Not now» today: again in 2 hours. Second: skip the day, last_checkin stays. */
function snooze(now: Date): { code: number; out: string } {
  const today = localDate(now);
  let skipped = false;
  updateState((s) => {
    const st = s.standup ?? {};
    const snoozes = (st.snooze_date === today ? st.snoozes ?? 0 : 0) + 1;
    skipped = snoozes >= 2;
    s.standup = skipped
      ? { done_date: today }
      : { ...st, snooze_date: today, snoozes, snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString(), showing_until: undefined, pending: undefined };
  });
  enqueueEvent(skipped ? 'skipped' : 'snoozed', now);
  return skipped
    ? { code: 0, out: 'Skipping today. Today’s work will go into tomorrow’s standup.' }
    : { code: 0, out: `OK, I’ll remind you in ${DEFAULTS.snoozeHours} h at the earliest.` };
}

/** Step A of the standup prompt: the subagent saves updated branch digests (they never leave the machine). */
function saveDigests(json: string): { code: number; out: string } {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return { code: 1, out: 'The argument is a JSON array [{repo, branch, digest}] in single quotes (replace apostrophes inside with ’).' };
  }
  if (!Array.isArray(list)) return { code: 1, out: 'an array [{repo, branch, digest}] is required' };
  let saved = 0;
  const skipped: string[] = [];
  for (const raw of list) {
    const d = (raw ?? {}) as Record<string, unknown>;
    const repo = str(d.repo);
    const branch = str(d.branch);
    const digest = str(d.digest);
    if (!repo || !branch || !digest || !REPO_ID_RE.test(repo)) {
      skipped.push(String(d.repo ?? '?'));
      continue;
    }
    writeDigest(repo, branch, digest);
    saved++;
  }
  log('info', 'standup: digests saved', { saved, skipped: skipped.length });
  return { code: skipped.length && !saved ? 1 : 0, out: `Digests saved: ${saved}${skipped.length ? `; skipped (repo must be the repo_id from the materials): ${skipped.join(', ')}` : ''}` };
}
