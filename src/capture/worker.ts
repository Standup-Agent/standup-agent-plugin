import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { CAPTURE, DEFAULTS } from '../config.js';
import { log } from '../log.js';
import { addFound, redactSecrets } from '../secrets.js';
import { isWorkRepo, readState, recordCapture, type State } from '../state.js';
import { writeRaw, type RawCapture } from '../store.js';
import { branchActivity, currentBranch, mainWorktreeRoot, repoRoot } from './git.js';
import { cutBytes, readTranscript, readTranscriptCwd, type TranscriptMessage } from './transcript.js';

export interface CaptureJob {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  /** SessionEnd reason, or `recover` for a session picked up on SessionStart. */
  reason?: string;
}

/**
 * Runs detached after SessionEnd (one job) or SessionStart recovery (several jobs).
 * transcript + git → secret filter → local store. Every job is independent: one failure is
 * logged and the rest go on.
 */
export async function runCapture(jobs: CaptureJob | CaptureJob[]): Promise<void> {
  for (const job of Array.isArray(jobs) ? jobs : [jobs]) {
    try {
      await captureSession(job);
    } catch (err) {
      log('error', 'capture failed', { session: short(job.session_id), error: err instanceof Error ? err.message : String(err) });
    }
  }
}

const short = (id: unknown) => (typeof id === 'string' ? id.slice(0, 8) : undefined);

export async function captureSession(job: CaptureJob, now = new Date()): Promise<void> {
  const session = short(job.session_id);
  if (typeof job.session_id !== 'string' || !job.transcript_path) {
    log('info', 'capture: skipped, no transcript', { session, reason: job.reason });
    return;
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(job.transcript_path).mtimeMs;
  } catch {
    log('info', 'capture: skipped, transcript missing', { session, reason: job.reason });
    return;
  }
  const done = (skip: string) => {
    // Remember skipped sessions too, so SessionStart recovery doesn't pick them up again.
    recordCapture(job.session_id, mtimeMs, now);
    log('info', `capture: skipped, ${skip}`, { session, reason: job.reason });
  };

  const cwd = job.cwd ?? (await readTranscriptCwd(job.transcript_path));
  if (!cwd) return done('no cwd');
  const root = repoRoot(cwd);
  if (!root) return done('not a git repo');
  // Personal and unmarked repos stop here: nothing of theirs is parsed into memory or written.
  const repo = markedWorkRepo(root, readState());
  if (!repo) return done('repo is not marked as work');

  const redacted: Record<string, number> = {};
  const transcript = await readTranscript(job.transcript_path, {
    maxBytes: DEFAULTS.rawMaxBytesPerSession,
    maxBytesPerMessage: CAPTURE.maxBytesPerMessage,
    transform: (text) => {
      const r = redactSecrets(text);
      addFound(redacted, r.found);
      return r.text;
    },
  });

  const fallbackBranch = currentBranch(root) ?? 'HEAD';
  const fallbackTs = new Date(mtimeMs).toISOString();
  let written = 0;
  let commits = 0;
  for (const [branch, messages] of groupByBranch(transcript.messages, fallbackBranch)) {
    const times = messages.map((m) => m.ts).filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b));
    const from = times[0] ?? transcript.firstTs ?? fallbackTs;
    const to = times[times.length - 1] ?? transcript.lastTs ?? fallbackTs;
    const until = new Date(new Date(to).getTime() + CAPTURE.commitSlackMinutes * 60_000);
    const activity = branchActivity(root, branch, new Date(from), until);
    if (messages.length === 0 && activity.commits.length === 0) continue;

    const capture: RawCapture = {
      schema: 1,
      session_id: job.session_id,
      repo: { path: repo, name: basename(repo) },
      branch,
      captured_at: now.toISOString(),
      period: { from, to },
      cc_version: transcript.version,
      reason: job.reason,
      messages: messages.map((m) => ({ role: m.role, ts: m.ts, text: m.text })),
      truncated: { dropped: transcript.dropped, cut: transcript.cut },
      commits: activity.commits.map((c) => {
        // Redact first, then cut: a cut through a key would leave its prefix unrecognizable.
        const r = redactSecrets(c.message);
        addFound(redacted, r.found);
        return { sha: c.sha, ts: c.ts, message: cutBytes(r.text, CAPTURE.maxCommitMessageBytes).text };
      }),
      files: activity.files,
      tickets: activity.tickets,
      redacted: {},
    };
    capture.redacted = { ...redacted };
    writeRaw(capture, now);
    written++;
    commits += capture.commits.length;
  }

  recordCapture(job.session_id, mtimeMs, now);
  log('info', 'capture: done', {
    session,
    reason: job.reason,
    repo: basename(repo),
    branches: written,
    messages: transcript.messages.length,
    commits,
    dropped: transcript.dropped,
    redacted,
  });
}

/** The marked repo this checkout belongs to: itself, or the main checkout of a linked worktree. */
function markedWorkRepo(root: string, state: State): string | null {
  if (isWorkRepo(root, state)) return root;
  const main = mainWorktreeRoot(root);
  return main && isWorkRepo(main, state) ? main : null;
}

/**
 * Messages grouped by the branch Claude Code recorded at the time, in order of first appearance.
 * A session with no messages still yields the fallback branch, so commits made in it are kept.
 */
function groupByBranch(messages: TranscriptMessage[], fallback: string): Map<string, TranscriptMessage[]> {
  const groups = new Map<string, TranscriptMessage[]>();
  for (const m of messages) {
    const b = m.branch && m.branch !== 'HEAD' ? m.branch : fallback;
    let list = groups.get(b);
    if (!list) groups.set(b, (list = []));
    list.push(m);
  }
  if (groups.size === 0) groups.set(fallback, []);
  return groups;
}
