import { dirname } from 'node:path';
import { findSessions, spawnCapture } from '../capture/discover.js';
import type { CaptureJob } from '../capture/worker.js';
import { CAPTURE } from '../config.js';
import type { HookInput } from '../hookio.js';
import { log } from '../log.js';
import { dataDir, paths } from '../paths.js';
import { matchesWorkOrg, repoOf, type Repo } from '../repos.js';
import { markRepoAsked, readState, setRepoKinds, workRepos, type State } from '../state.js';

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
export function sessionStart(input: HookInput, cliPath: string): SessionStartOutput | null {
  let out: SessionStartOutput | null = null;
  try {
    out = newRepoCheck(input, cliPath);
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
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: askAboutRepo(repo, cliPath, state.team.name) },
  };
}

/** Shell-quote for a POSIX shell. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command Claude runs through Bash; the data dir isn't in the Bash tool's environment. */
export function cliCommand(cliPath: string, args: string): string {
  return `CLAUDE_PLUGIN_DATA=${sq(dataDir())} node ${sq(cliPath)} ${args}`;
}

function askAboutRepo(repo: Repo, cliPath: string, teamName?: string): string {
  const where = repo.remotes[0] ? ` (${repo.remotes[0]})` : ' (без remote)';
  const set = (kind: string) => cliCommand(cliPath, `repos set ${sq(`${repo.path}=${kind}`)}`);
  return `[Standup Agent] Пользователь впервые работает в репо ${repo.name}${where} с тех пор, как вступил в команду${teamName ? ` «${teamName}»` : ''}. Этот вопрос задаётся один раз.

Прежде чем выполнять первую просьбу пользователя, вызови AskUserQuestion: вопрос «Включать репо ${repo.name} в стендап?», header «Стендап», две опции:
- «Да, рабочий» — описание: работа в этом репо попадёт в черновик стендапа (менеджер видит только то, что ты подтвердишь);
- «Нет, личный» — описание: ничего из этого репо не сохраняется даже локально.

По ответу выполни одну команду через Bash и больше к этому не возвращайся:
- «Да, рабочий»: ${set('work')}
- «Нет, личный»: ${set('personal')}
Если пользователь не ответил или отказался выбирать — ничего не выполняй (репо останется неразмеченным и не будет захватываться; поменять можно через /standup repos). После этого переходи к его просьбе.`;
}
