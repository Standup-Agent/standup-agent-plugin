// Values marked [ДЕФОЛТ] on the Trello board. Keep them here, not scattered in code.
export const DEFAULTS = {
  /** Raw session capture is kept locally this long, then deleted. */
  rawTtlDays: 30,
  /** Soft cap on text taken from one session transcript. */
  rawMaxBytesPerSession: 64 * 1024,
  /** Standup is not shown before this local hour. */
  showNotBeforeHour: 6,
  /** "Не сейчас" postpones the standup for this long. */
  snoozeHours: 2,
  /** Another terminal won't show the standup while one is showing it. */
  showLockMinutes: 10,
  /** Repo scan window when joining a team. */
  repoScanDays: 30,
  /** Transcripts re-captured right after join, to show a first standup immediately. */
  joinBackfillDays: 3,
} as const;

// Capture limits chosen in task 1. They are not on the board, so they live apart from DEFAULTS
// until the board confirms them.
export const CAPTURE = {
  /** One message longer than this is cut; keeps a pasted log from eating the session budget. */
  maxBytesPerMessage: 8 * 1024,
  /** SessionStart recovery only looks at transcripts modified within this window. */
  recoverLookbackDays: 7,
  /** At most this many missed sessions are handed to one recovery worker. */
  recoverMaxSessions: 50,
  /** Commits after the last transcript entry still count to the session (commit right before /exit). */
  commitSlackMinutes: 5,
  /** At most this many sessions are captured right after repos are marked work (task 3). */
  backfillMaxSessions: 200,
  maxCommitsPerBranch: 100,
  maxFilesPerBranch: 200,
  maxCommitMessageBytes: 1024,
  gitTimeoutMs: 5000,
  /** state.json lock: wait this long, and treat an older lock file as stale. */
  stateLockWaitMs: 2000,
  stateLockStaleMs: 10_000,
} as const;

export const API_BASE_URL = process.env.STANDUP_AGENT_API_URL ?? 'https://standupagent.ai/api';
