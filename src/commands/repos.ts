import { isAbsolute } from 'node:path';
import { findSessions, spawnCapture } from '../capture/discover.js';
import { CAPTURE, DEFAULTS } from '../config.js';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { classify, repoOf, scanRepos, type RepoCandidate } from '../repos.js';
import type { CaptureJob } from '../capture/worker.js';
import { readState, setRepoKindsWithSessions, type RepoKind } from '../state.js';

/**
 * `repos scan | set <path>=work|personal ... | list` — run by Claude through Bash from the standup
 * skill and the SessionStart question. Prints JSON for Claude to read.
 */
export async function reposCommand(args: string[], cliPath: string, now = Date.now()): Promise<{ code: number; out: unknown }> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'scan':
      return { code: 0, out: await scan(cliPath, now) };
    case 'set':
      return set(rest, cliPath, now);
    case 'list':
    case undefined:
      return { code: 0, out: list() };
    default:
      return { code: 1, out: { error: `unknown subcommand: ${sub}`, usage: 'repos scan | set <path>=work|personal ... | list' } };
  }
}

const brief = (r: RepoCandidate) => ({ path: r.path, name: r.name, remote: r.remotes[0] ?? null, last_activity: r.lastActivity.slice(0, 10) });

/** Join-time scan: org repos are marked work right away, the rest are returned for one question. */
async function scan(cliPath: string, now: number) {
  const state = readState();
  const found = classify(await scanRepos(paths.claudeProjects(), DEFAULTS.repoScanDays, now), state);
  if (found.autoWork.length > 0) {
    const { becameWork, sessions } = setRepoKindsWithSessions(Object.fromEntries(found.autoWork.map((r) => [r.path, 'work' as const])));
    backfill(becameWork, cliPath, now, sessions);
  }
  log('info', 'repos: scan', { found: found.marked.length + found.autoWork.length + found.ask.length, auto: found.autoWork.length, ask: found.ask.length });
  return {
    team: state.team?.name ?? null,
    work_orgs: state.team?.work_orgs ?? [],
    auto_marked_work: found.autoWork.map(brief),
    ask: found.ask.map(brief),
    already_marked: found.marked.map((r) => ({ ...brief(r), kind: r.kind })),
  };
}

function set(pairs: string[], cliPath: string, now: number): { code: number; out: unknown } {
  const kinds: Record<string, RepoKind> = {};
  for (const p of pairs) {
    const eq = p.lastIndexOf('=');
    const path = p.slice(0, eq);
    const kind = p.slice(eq + 1);
    if (eq <= 0 || !isAbsolute(path) || (kind !== 'work' && kind !== 'personal')) {
      return { code: 1, out: { error: `expected <absolute path>=work|personal, got: ${p}` } };
    }
    // A subdirectory or a linked worktree is stored under its main checkout, the key capture uses.
    kinds[repoOf(path)?.path ?? path] = kind;
  }
  if (Object.keys(kinds).length === 0) return { code: 1, out: { error: 'nothing to set' } };
  const { becameWork, sessions } = setRepoKindsWithSessions(kinds);
  const backfilled = backfill(becameWork, cliPath, now, sessions);
  log('info', 'repos: set', { work: Object.values(kinds).filter((k) => k === 'work').length, personal: Object.values(kinds).filter((k) => k === 'personal').length, backfilled });
  return { code: 0, out: { updated: kinds, backfill_sessions: backfilled } };
}

function list() {
  const state = readState();
  return {
    team: state.team?.name ?? null,
    repos: Object.entries(state.repos ?? {}).map(([path, kind]) => ({ path, kind })),
  };
}

/**
 * Newly work repos: capture their last DEFAULTS.joinBackfillDays so a first standup can be shown
 * right away. Captures are ignored on purpose — the worker recorded these sessions as skipped
 * while the repo was unmarked. `visited` adds sessions that started elsewhere and `cd`-ed into
 * these repos (state.unmarked_seen): their transcripts live under another project dir.
 */
export function backfill(repos: string[], cliPath: string, now: number, visited: Record<string, string> = {}): number {
  if (repos.length === 0) return 0;
  const found = findSessions({
    projectsDir: paths.claudeProjects(),
    repos,
    sinceMs: now - DEFAULTS.joinBackfillDays * 86_400_000,
    reason: 'backfill',
    max: CAPTURE.backfillMaxSessions,
  });
  const ids = new Set(found.map((j) => j.session_id));
  const extra: CaptureJob[] = Object.entries(visited)
    .filter(([id]) => !ids.has(id))
    .map(([id, path]) => ({ session_id: id, transcript_path: path, reason: 'backfill' }));
  const jobs = [...found, ...extra];
  spawnCapture(cliPath, jobs);
  return jobs.length;
}
