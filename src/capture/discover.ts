import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CaptureJob } from './worker.js';

/**
 * Claude Code's project dir name for a cwd: every non-alphanumeric char becomes `-`
 * (`/work/acme/billing-api` → `-work-acme-billing-api`). Lossy, so it is only a pre-filter;
 * the worker checks the real `cwd` from the transcript.
 */
export function projectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface FindOptions {
  projectsDir: string;
  /** Repo paths (main checkout top level). Sessions in their subdirectories are included. */
  repos: string[];
  /** Only transcripts modified at or after this time (ms). */
  sinceMs: number;
  /** session_id → transcript mtime at last capture; newer transcripts only. Omit to take all. */
  captures?: Record<string, number>;
  /** A session to leave out (the one that is running the hook). */
  exclude?: string;
  reason: string;
  max: number;
}

/** Transcripts of the given repos, newest first. Only readdir + stat, no file contents. */
export function findSessions(o: FindOptions): CaptureJob[] {
  const dirs = o.repos.map(projectDirName);
  if (dirs.length === 0) return [];
  const found: { job: CaptureJob; mtime: number }[] = [];
  for (const dir of safeReaddir(o.projectsDir)) {
    if (!dirs.some((r) => dir === r || dir.startsWith(`${r}-`))) continue;
    for (const file of safeReaddir(join(o.projectsDir, dir))) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = basename(file, '.jsonl');
      if (sessionId === o.exclude) continue;
      const path = join(o.projectsDir, dir, file);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < o.sinceMs) continue;
      const last = o.captures?.[sessionId];
      if (last !== undefined && mtime <= last) continue;
      found.push({ job: { session_id: sessionId, transcript_path: path, reason: o.reason }, mtime });
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, o.max)
    .map((f) => f.job);
}

/** Hand jobs to a detached capture worker; returns at once. */
export function spawnCapture(cliPath: string, jobs: CaptureJob[]): void {
  if (jobs.length === 0) return;
  spawn(process.execPath, [cliPath, 'capture', JSON.stringify(jobs)], { detached: true, stdio: 'ignore' }).unref();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
