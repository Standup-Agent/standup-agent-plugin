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

export const API_BASE_URL = process.env.STANDUP_AGENT_API_URL ?? 'https://standupagent.ai/api';
