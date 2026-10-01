import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULTS } from './config.js';
import { writeFileAtomic } from './fsutil.js';
import { log } from './log.js';
import { paths } from './paths.js';

/**
 * Local digest store:
 *   digests/<repo>/<branch>/raw/<session_id>.json   raw capture of one session on one branch
 *   digests/<repo>/<branch>/digest.md               synthesized digest (task 2)
 * Raw files live DEFAULTS.rawTtlDays counted from the session's last activity; expired ones are
 * removed on every write.
 */

export interface RawCapture {
  schema: 1;
  session_id: string;
  repo: { path: string; name: string };
  branch: string;
  captured_at: string;
  /** Session activity on this branch (first/last transcript entry). */
  period: { from: string; to: string };
  cc_version?: string;
  reason?: string;
  messages: { role: 'user' | 'assistant'; ts?: string; text: string }[];
  /** Messages dropped / cut to fit DEFAULTS.rawMaxBytesPerSession. */
  truncated: { dropped: number; cut: number };
  commits: { sha: string; ts: string; message: string }[];
  files: string[];
  tickets: string[];
  /** Secrets removed before writing, per kind (counts only). */
  redacted: Record<string, number>;
}

/**
 * Repo dir: readable name + short hash of the absolute path, so two checkouts called `api` don't
 * mix. The full path is also inside every raw file.
 */
export function repoKey(repoPath: string): string {
  const hash = createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
  return `${safeName(basename(repoPath)) || 'repo'}-${hash}`;
}

/** Branch dir: reversible encoding, `feature/PAY-42` → `feature%2FPAY-42`. */
export function branchKey(branch: string): string {
  const enc = encodeURIComponent(branch).replace(/\*/g, '%2A');
  return enc === '.' || enc === '..' ? enc.replace(/\./g, '%2E') : enc;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
const safeFile = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function rawPath(repoPath: string, branch: string, sessionId: string): string {
  return join(paths.digests(), repoKey(repoPath), branchKey(branch), 'raw', `${safeFile(sessionId)}.json`);
}

/** The branch digest (standup prompt, step A): the developer's private running summary of a branch. */
export function digestPath(repoId: string, branch: string): string {
  return join(paths.digests(), repoId, branchKey(branch), 'digest.md');
}

export function readDigest(repoId: string, branch: string): string {
  try {
    return readFileSync(digestPath(repoId, branch), 'utf8');
  } catch {
    return '';
  }
}

/** repo ids are `repoKey()` values; anything else could point outside the store. */
export const REPO_ID_RE = /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/;

export function writeDigest(repoId: string, branch: string, text: string): void {
  if (!REPO_ID_RE.test(repoId) || repoId.startsWith('.')) throw new Error(`bad repo id: ${repoId}`);
  writeFileAtomic(digestPath(repoId, branch), text.trim() + '\n');
}

/** Atomic write; file mtime is set to the session's last activity so TTL counts from the session. */
export function writeRaw(capture: RawCapture, now = new Date()): string {
  const file = rawPath(capture.repo.path, capture.branch, capture.session_id);
  writeFileAtomic(file, JSON.stringify(capture, null, 2) + '\n');
  const last = new Date(capture.period.to);
  if (!Number.isNaN(last.getTime())) utimesSync(file, now, last);
  cleanupExpired(now);
  return file;
}

/** Delete raw files older than the TTL, then empty raw/branch/repo dirs. Never throws. */
export function cleanupExpired(now = new Date()): number {
  const cutoff = now.getTime() - DEFAULTS.rawTtlDays * 86_400_000;
  let removed = 0;
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const repo of list(paths.digests())) {
    if (!repo.isDirectory()) continue;
    const repoDir = join(paths.digests(), repo.name);
    for (const branch of list(repoDir)) {
      if (!branch.isDirectory()) continue;
      const rawDir = join(repoDir, branch.name, 'raw');
      for (const f of list(rawDir)) {
        if (!f.isFile()) continue;
        const file = join(rawDir, f.name);
        try {
          const mtime = statSync(file).mtimeMs;
          // Temp files left by a worker killed mid-write are dropped after an hour.
          const expired = f.name.endsWith('.tmp') ? mtime < now.getTime() - 3_600_000 : mtime < cutoff;
          if ((f.name.endsWith('.json') || f.name.endsWith('.tmp')) && expired) {
            rmSync(file, { force: true });
            removed++;
          }
        } catch {
          // gone already
        }
      }
      removeIfEmpty(rawDir);
      removeIfEmpty(join(repoDir, branch.name));
    }
    removeIfEmpty(repoDir);
  }
  if (removed > 0) log('info', 'store: expired raw captures removed', { removed });
  return removed;
}

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir); // fails unless empty — exactly what we want
  } catch {
    // not empty or missing
  }
}
