import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { enqueueEvent } from '../api.js';
import { findSessions, spawnCapture } from '../capture/discover.js';
import type { CaptureJob } from '../capture/worker.js';
import { CAPTURE } from '../config.js';
import type { HookInput } from '../hookio.js';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { matchesWorkOrg, repoOf, type Repo } from '../repos.js';
import { outsideCommits, rawFilesSince } from '../standup/materials.js';
import { readNotes } from '../standup/notes.js';
import { gate, localDate, periodFrom } from '../standup/schedule.js';
import { backfill } from '../commands/repos.js';
import { markRepoAsked, readState, setRepoKindsWithSessions, updateState, workRepos, type State } from '../state.js';

export { projectDirName } from '../capture/discover.js';

/** Hook output understood by Claude Code; printed as JSON to stdout. */
export interface SessionStartOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'SessionStart'; additionalContext: string };
}

/**
 * Task 1: re-capture transcripts missed after a kill -9.
 * Task 3: a repo seen for the first time is marked (work org) or asked about once.
 * Task 2: decide whether to show today's standup.
 */
export function sessionStart(input: HookInput, cliPath: string, now = new Date()): SessionStartOutput | null {
  const outs: (SessionStartOutput | null)[] = [];
  try {
    outs.push(newRepoCheck(input, cliPath));
  } catch (err) {
    log('error', 'session-start: repo check failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const jobs = findMissedSessions(input);
    if (jobs.length > 0) {
      spawnCapture(cliPath, jobs);
      log('info', 'session-start: recovering missed sessions', { count: jobs.length });
    }
  } catch (err) {
    log('error', 'session-start: recovery failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try {
    outs.push(standupCheck(input, now));
    if (queueNotEmpty()) spawn(process.execPath, [cliPath, 'flush'], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    log('error', 'session-start: standup check failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return merge(outs);
}

/**
 * Task 2: announce the standup and tell Claude to run it before the user's first request.
 * No work since last_checkin → no standup, one `no_work` event per day.
 */
export function standupCheck(input: HookInput, now: Date, state: State = readState()): SessionStartOutput | null {
  if (input.source === 'compact') return null;
  const repos = workRepos(state);
  if (repos.length === 0 || gate(state, now) !== 'ok') return null;

  const from = periodFrom(state, now);
  // A note alone (a call, a review) is work for the standup too.
  const hasWork = readNotes().length > 0 || rawFilesSince(from.getTime()).length > 0 || outsideCommits(repos, from, new Set(), 1).length > 0;
  if (!hasWork) {
    const today = localDate(now);
    if (state.standup?.no_work_date !== today) {
      enqueueEvent('no_work', now);
      updateState((s) => {
        s.standup = { ...s.standup, no_work_date: today };
      });
    }
    return null;
  }
  log('info', 'standup: ready');
  return {
    systemMessage: '📋 Your standup is ready',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[Standup Agent] First session of the day: there is work since the last standup, so a standup draft can be put together.
Before doing what the user asks, call the Skill tool: skill «standup-agent:standup», args «show» — and follow it to the end (show the standup and the question with 4 buttons). Only after the answer move on to the user's request.
Exception: if the user writes about an urgent incident, help first and offer the standup afterwards.
Talk to the user in their language.`,
    },
  };
}

function queueNotEmpty(): boolean {
  try {
    return readdirSync(paths.queue()).some((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

/** Several checks may speak at once: join their messages and contexts. */
function merge(outs: (SessionStartOutput | null)[]): SessionStartOutput | null {
  const msgs = outs.map((o) => o?.systemMessage).filter((m): m is string => !!m);
  const ctx = outs.map((o) => o?.hookSpecificOutput?.additionalContext).filter((c): c is string => !!c);
  if (msgs.length === 0 && ctx.length === 0) return null;
  const out: SessionStartOutput = {};
  if (msgs.length) out.systemMessage = msgs.join('\n');
  if (ctx.length) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: ctx.join('\n\n') };
  return out;
}

/**
 * Transcripts of work repos changed since their last capture. Only readdir + stat, no file
 * contents: the hook must stay fast.
 */
export function findMissedSessions(input: HookInput, now = Date.now()): CaptureJob[] {
  const state = readState();
  return findSessions({
    projectsDir: projectsDirFor(input),
    repos: workRepos(state),
    sinceMs: now - CAPTURE.recoverLookbackDays * 86_400_000,
    captures: state.captures ?? {},
    exclude: input.session_id,
    reason: 'recover',
    max: CAPTURE.recoverMaxSessions,
  });
}

/**
 * The hook's own transcript lives in <projects>/<project>/<session>.jsonl — the most reliable
 * way to find the projects dir; CLAUDE_CONFIG_DIR / ~/.claude is the fallback.
 */
export function projectsDirFor(input: HookInput): string {
  return input.transcript_path ? dirname(dirname(input.transcript_path)) : paths.claudeProjects();
}

/**
 * Only after joining a team (before that nothing is captured anyway). An unmarked repo whose
 * remote is in a work org becomes `work` silently; any other unmarked repo is asked about once.
 * First the repo of this session's cwd, then the newest unmarked repo an earlier session `cd`-ed
 * into (state.unmarked_seen) — one question per session start at most.
 */
export function newRepoCheck(input: HookInput, cliPath: string, state: State = readState(), now = Date.now()): SessionStartOutput | null {
  if (!state.team) return null;
  const fresh = (r: Repo | null): r is Repo => !!r && !state.repos?.[r.path] && !state.repos_asked?.[r.path];
  let repo = input.cwd ? repoOf(input.cwd) : null;
  let visited = false;
  if (!fresh(repo)) {
    repo = null;
    const seen = Object.entries(state.unmarked_seen ?? {}).sort((a, b) => b[1].last_seen.localeCompare(a[1].last_seen));
    for (const [path] of seen) {
      const r = repoOf(path);
      if (fresh(r) && r.path === path) {
        repo = r;
        visited = true;
        break;
      }
    }
    if (!repo) return null;
  }

  if (matchesWorkOrg(repo.remotes, state.team.work_orgs ?? [])) {
    const { becameWork, sessions } = setRepoKindsWithSessions({ [repo.path]: 'work' });
    if (visited || Object.keys(sessions).length > 0) backfill(becameWork, cliPath, now, sessions);
    log('info', 'repos: marked work by org', { repo: repo.name });
    return { systemMessage: `📋 Standup Agent: ${repo.name} belongs to your team’s org — included in your standup` };
  }

  markRepoAsked(repo.path);
  log('info', 'repos: asking about a new repo', { repo: repo.name, visited });
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: askAboutRepo(repo, state.team.name, visited) },
  };
}

/** Shell-quote for a POSIX shell. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function askAboutRepo(repo: Repo, teamName?: string, visited = false): string {
  const where = repo.remotes[0] ? ` (${repo.remotes[0]})` : ' (no remote)';
  const set = (kind: string) => `call the Skill tool: skill «standup-agent:standup», args «repos set ${sq(`${repo.path}=${kind}`)}»`;
  const what = visited
    ? `In an earlier Claude Code session the user also worked in the repo ${repo.name}${where} (${repo.path}), which isn't marked yet`
    : `The user is working in the repo ${repo.name}${where} for the first time since joining the team${teamName ? ` «${teamName}»` : ''}`;
  return `[Standup Agent] ${what}. This question is asked once. Ask it in the user's language: the quoted texts below are English templates.

Before doing the user's first request, call AskUserQuestion: question «Include ${repo.name} in your standup?», header «Standup», two options:
- «Yes, it’s work» — description: work in this repo goes into your standup draft (your manager only sees what you confirm);
- «No, personal» — description: nothing from this repo is stored, not even locally.

Do one action based on the answer and don't come back to it:
- «Yes, it’s work»: ${set('work')}
- «No, personal»: ${set('personal')}
If the user didn't answer or refused to choose, do nothing (the repo stays unmarked and isn't captured; it can be changed with /standup repos). Then move on to their request.`;
}
