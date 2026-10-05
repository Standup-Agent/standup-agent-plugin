import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CAPTURE } from './config.js';
import { sleepSync, writeFileAtomic } from './fsutil.js';
import { log } from './log.js';
import { paths } from './paths.js';

export type RepoKind = 'work' | 'personal';

/**
 * state.json. Only the fields task 1 needs are typed here; other tasks add theirs. Unknown fields
 * are preserved on write.
 */
export interface State {
  /** Repo marking, written by task 3. Key: absolute repo top level (`git rev-parse --show-toplevel`). */
  repos?: Record<string, RepoKind>;
  /** Team the developer joined (task 4). Its work orgs mark repos as work without a question. */
  team?: { name?: string; work_orgs?: string[]; joined_at?: string };
  /** Repos we already asked about on SessionStart: path → ISO time. Asked at most once. */
  repos_asked?: Record<string, string>;
  /** End of the period covered by the last sent standup (ISO). The next standup starts here. */
  last_checkin?: string;
  /** Daily standup display state (task 2). Dates are the developer's local YYYY-MM-DD. */
  standup?: StandupState;
  /** When the last capture finished (ISO). */
  last_capture_at?: string;
  /** session_id → transcript mtime (ms) at its last capture. SessionStart recovery compares against it. */
  captures?: Record<string, number>;
  /**
   * Unmarked repos that sessions visited (a session started in a work repo and `cd`-ed into one).
   * Paths only, no content. SessionStart asks about them; marking one `work` captures these sessions.
   */
  unmarked_seen?: Record<string, UnmarkedSeen>;
  [key: string]: unknown;
}

export interface UnmarkedSeen {
  last_seen: string;
  /** session_id → transcript path. */
  sessions: Record<string, string>;
}

export interface StandupState {
  /** Sent or skipped today: no more standups until tomorrow. */
  done_date?: string;
  /** Not before this time (ISO): after «Not now», or after a show left without an answer. */
  snooze_until?: string;
  /** «Not now» count for `snooze_date`; the second one skips the day. */
  snooze_date?: string;
  snoozes?: number;
  /** Another terminal is showing the standup until this time (ISO). */
  showing_until?: string;
  /** The `no_work` event was already sent for this date. */
  no_work_date?: string;
  /**
   * Period and prompt of the standup being shown, so `send` doesn't depend on Claude echoing them;
   * note_ids — the developer's notes in its materials, removed once it is sent.
   */
  pending?: { from: string; to: string; prompt_version: string; note_ids?: string[] };
  /** Id of the standup sent on `done_date`: an addendum goes to it (card 2a). */
  sent_report_id?: string;
}

export function readState(): State {
  try {
    const data = JSON.parse(readFileSync(paths.state(), 'utf8')) as unknown;
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as State) : {};
  } catch {
    return {};
  }
}

/** Only an explicitly `work` repo is captured. Unmarked and personal repos are not. */
export function isWorkRepo(repoPath: string, state: State = readState()): boolean {
  return state.repos?.[repoPath] === 'work';
}

export function workRepos(state: State = readState()): string[] {
  return Object.entries(state.repos ?? {})
    .filter(([, kind]) => kind === 'work')
    .map(([path]) => path);
}

/**
 * Read-modify-write under a lock file, written atomically. If the lock can't be taken in time the
 * update still happens: losing a race on a timestamp is better than losing the capture.
 */
export function updateState(mutate: (s: State) => void): State {
  const lock = `${paths.state()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const locked = acquire(lock);
  try {
    const state = readState();
    mutate(state);
    writeFileAtomic(paths.state(), JSON.stringify(state, null, 2) + '\n');
    return state;
  } finally {
    if (locked) rmSync(lock, { force: true });
  }
}

function acquire(lock: string): boolean {
  const deadline = Date.now() + CAPTURE.stateLockWaitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      return true;
    } catch {
      try {
        if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > CAPTURE.stateLockStaleMs) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // raced with the holder releasing it
      }
      if (Date.now() >= deadline) {
        log('error', 'state: lock timeout, writing without lock');
        return false;
      }
      sleepSync(25);
    }
  }
}

/** Record a finished capture of one session (also used for sessions we decided not to capture). */
export function recordCapture(sessionId: string, transcriptMtimeMs: number, now = new Date()): void {
  updateState((s) => {
    const captures = { ...(s.captures ?? {}) };
    captures[sessionId] = transcriptMtimeMs;
    // Entries older than the recovery window are never consulted again.
    const floor = now.getTime() - CAPTURE.recoverLookbackDays * 86_400_000;
    for (const [id, mtime] of Object.entries(captures)) if (mtime < floor) delete captures[id];
    s.captures = captures;
    s.last_capture_at = now.toISOString();
  });
}

/** Remember unmarked repos a session visited, so they can be asked about and captured later. */
export function noteUnmarked(roots: string[], sessionId: string, transcriptPath: string, now = new Date()): void {
  if (roots.length === 0) return;
  updateState((s) => {
    const seen = { ...(s.unmarked_seen ?? {}) };
    for (const root of roots) {
      if (s.repos?.[root]) continue;
      const sessions = { ...(seen[root]?.sessions ?? {}), [sessionId]: transcriptPath };
      const ids = Object.keys(sessions);
      for (const id of ids.slice(0, Math.max(0, ids.length - CAPTURE.maxUnmarkedSessionsPerRepo))) delete sessions[id];
      seen[root] = { last_seen: now.toISOString(), sessions };
    }
    // Repos not seen within the recovery window are forgotten.
    const floor = now.getTime() - CAPTURE.recoverLookbackDays * 86_400_000;
    for (const [root, v] of Object.entries(seen)) if (Date.parse(v.last_seen) < floor) delete seen[root];
    s.unmarked_seen = seen;
  });
}

/**
 * Set work/personal for several repos at once. Returns the paths that became `work` just now, with
 * the sessions that visited them while they were unmarked (to be captured now).
 */
export function setRepoKinds(kinds: Record<string, RepoKind>): string[] {
  return setRepoKindsWithSessions(kinds).becameWork;
}

export function setRepoKindsWithSessions(kinds: Record<string, RepoKind>): { becameWork: string[]; sessions: Record<string, string> } {
  const becameWork: string[] = [];
  const sessions: Record<string, string> = {};
  updateState((s) => {
    const repos = { ...(s.repos ?? {}) };
    const seen = { ...(s.unmarked_seen ?? {}) };
    for (const [path, kind] of Object.entries(kinds)) {
      if (kind === 'work' && repos[path] !== 'work') {
        becameWork.push(path);
        Object.assign(sessions, seen[path]?.sessions ?? {});
      }
      repos[path] = kind;
      delete seen[path];
    }
    s.repos = repos;
    s.unmarked_seen = seen;
  });
  return { becameWork, sessions };
}

/** Remember that we asked about a repo, so SessionStart never asks again. */
export function markRepoAsked(path: string, now = new Date()): void {
  updateState((s) => {
    s.repos_asked = { ...(s.repos_asked ?? {}), [path]: now.toISOString() };
  });
}
