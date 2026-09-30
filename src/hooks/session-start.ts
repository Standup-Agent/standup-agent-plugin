import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CaptureJob } from '../capture/worker.js';
import { CAPTURE } from '../config.js';
import type { HookInput } from '../hookio.js';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { readState, workRepos } from '../state.js';

/** Hook output understood by Claude Code; printed as JSON to stdout. */
export interface SessionStartOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'SessionStart'; additionalContext: string };
}

/**
 * Task 1: re-capture transcripts missed after a kill -9.
 * Task 2: decide whether to show today's standup.
 */
export function sessionStart(input: HookInput, cliPath: string): SessionStartOutput | null {
  try {
    const jobs = findMissedSessions(input);
    if (jobs.length > 0) {
      spawn(process.execPath, [cliPath, 'capture', JSON.stringify(jobs)], { detached: true, stdio: 'ignore' }).unref();
      log('info', 'session-start: recovering missed sessions', { count: jobs.length });
    }
  } catch (err) {
    log('error', 'session-start: recovery failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

/**
 * Claude Code's project dir name for a cwd: every non-alphanumeric char becomes `-`
 * (`/work/acme/billing-api` → `-work-acme-billing-api`). Lossy, so it is only a pre-filter;
 * the worker checks the real `cwd` from the transcript.
 */
export function projectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Transcripts of work repos changed since their last capture. Only readdir + stat, no file
 * contents: the hook must stay fast. Sessions in subdirectories of a repo are included (their
 * project dir starts with the repo's).
 */
export function findMissedSessions(input: HookInput, now = Date.now()): CaptureJob[] {
  const state = readState();
  const repos = workRepos(state).map(projectDirName);
  if (repos.length === 0) return [];

  // The hook's own transcript lives in <projects>/<project>/<session>.jsonl — the most reliable
  // way to find the projects dir; CLAUDE_CONFIG_DIR / ~/.claude is the fallback.
  const projectsDir = input.transcript_path ? dirname(dirname(input.transcript_path)) : paths.claudeProjects();
  const floor = now - CAPTURE.recoverLookbackDays * 86_400_000;
  const captures = state.captures ?? {};

  const found: { job: CaptureJob; mtime: number }[] = [];
  for (const dir of safeReaddir(projectsDir)) {
    if (!repos.some((r) => dir === r || dir.startsWith(`${r}-`))) continue;
    for (const file of safeReaddir(join(projectsDir, dir))) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = basename(file, '.jsonl');
      if (sessionId === input.session_id) continue;
      const path = join(projectsDir, dir, file);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < floor) continue;
      const last = captures[sessionId];
      if (last !== undefined && mtime <= last) continue;
      found.push({ job: { session_id: sessionId, transcript_path: path, reason: 'recover' }, mtime });
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CAPTURE.recoverMaxSessions)
    .map((f) => f.job);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
