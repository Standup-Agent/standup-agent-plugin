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
import { gate, localDate, periodFrom } from '../standup/schedule.js';
import { markRepoAsked, readState, setRepoKinds, updateState, workRepos, type State } from '../state.js';

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
  const hasWork = rawFilesSince(from.getTime()).length > 0 || outsideCommits(repos, from, new Set(), 1).length > 0;
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
    systemMessage: '📋 Стендап готов',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[Standup Agent] Первая сессия дня: с прошлого стендапа есть работа, черновик стендапа можно собрать.
Прежде чем выполнять просьбу пользователя, вызови инструмент Skill: skill «standup-agent:standup», args «show» — и пройди его сценарий до конца (показ стендапа и вопрос с 4 кнопками). Только после ответа переходи к просьбе пользователя.
Исключение: если пользователь пишет о срочной аварии — сначала помоги, стендап предложи потом.`,
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
 */
export function newRepoCheck(input: HookInput, cliPath: string, state: State = readState()): SessionStartOutput | null {
  if (!state.team || !input.cwd) return null;
  const repo = repoOf(input.cwd);
  if (!repo || state.repos?.[repo.path] || state.repos_asked?.[repo.path]) return null;

  if (matchesWorkOrg(repo.remotes, state.team.work_orgs ?? [])) {
    setRepoKinds({ [repo.path]: 'work' });
    log('info', 'repos: marked work by org', { repo: repo.name });
    return { systemMessage: `📋 Standup Agent: ${repo.name} — репо организации команды, включён в стендап` };
  }

  markRepoAsked(repo.path);
  log('info', 'repos: asking about a new repo', { repo: repo.name });
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: askAboutRepo(repo, state.team.name) },
  };
}

/** Shell-quote for a POSIX shell. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function askAboutRepo(repo: Repo, teamName?: string): string {
  const where = repo.remotes[0] ? ` (${repo.remotes[0]})` : ' (без remote)';
  const set = (kind: string) => `вызови инструмент Skill: skill «standup-agent:standup», args «repos set ${sq(`${repo.path}=${kind}`)}»`;
  return `[Standup Agent] Пользователь впервые работает в репо ${repo.name}${where} с тех пор, как вступил в команду${teamName ? ` «${teamName}»` : ''}. Этот вопрос задаётся один раз.

Прежде чем выполнять первую просьбу пользователя, вызови AskUserQuestion: вопрос «Включать репо ${repo.name} в стендап?», header «Стендап», две опции:
- «Да, рабочий» — описание: работа в этом репо попадёт в черновик стендапа (менеджер видит только то, что ты подтвердишь);
- «Нет, личный» — описание: ничего из этого репо не сохраняется даже локально.

По ответу сделай одно действие и больше к этому не возвращайся:
- «Да, рабочий»: ${set('work')}
- «Нет, личный»: ${set('personal')}
Если пользователь не ответил или отказался выбирать — ничего не выполняй (репо останется неразмеченным и не будет захватываться; поменять можно через /standup repos). После этого переходи к его просьбе.`;
}
