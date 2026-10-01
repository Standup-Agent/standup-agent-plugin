import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { CAPTURE, DEFAULTS } from '../config.js';
import { log } from '../log.js';
import { addFound, redactSecrets } from '../secrets.js';
import { localDate } from '../standup/schedule.js';
import { isWorkRepo, noteUnmarked, readState, recordCapture, type State } from '../state.js';
import { removeSessionRaw, writeRaw, type RawCapture } from '../store.js';
import { fitTurns } from './budget.js';
import { branchActivity, currentBranch, mainWorktreeRoot, repoRoot } from './git.js';
import { BYTES, cutBytes, MIN_CAP_BYTES, readTranscript, type TranscriptMessage } from './transcript.js';

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

  // Every entry carries its own cwd: a session can start in one repo and end in another.
  const state = readState();
  const roots = new Map<string, string | null>(); // cwd → repo top level
  const rootOf = (cwd: string) => {
    if (!roots.has(cwd)) roots.set(cwd, repoRoot(cwd));
    return roots.get(cwd)!;
  };
  const works = new Map<string, string | null>(); // top level → marked work repo
  const unmarked = new Set<string>();
  let sawRepo = false;
  const workOf = (cwd: string | undefined): string | null => {
    const root = cwd ? rootOf(cwd) : null;
    if (!root) return null;
    sawRepo = true;
    if (!works.has(root)) {
      const repo = markedWorkRepo(root, state);
      works.set(root, repo);
      if (!repo && !isMarked(root, state)) unmarked.add(root);
    }
    return works.get(root)!;
  };

  const redacted: Record<string, number> = {};
  // Personal and unmarked repos stop here: their entries are never transformed or kept in memory.
  const transcript = await readTranscript(job.transcript_path, {
    maxBytesPerMessage: CAPTURE.maxBytesPerMessage,
    maxBytesPerSummary: CAPTURE.maxBytesPerSummary,
    defaultCwd: job.cwd,
    accept: (cwd) => workOf(cwd) !== null,
    transform: (text) => {
      const r = redactSecrets(text);
      addFound(redacted, r.found);
      return r.text;
    },
  });
  noteUnmarked([...unmarked], job.session_id, job.transcript_path, now);
  // A new capture rewrites the whole session: files of repos no longer marked work go away too.
  removeSessionRaw(job.session_id);

  const fallbackTs = new Date(mtimeMs).toISOString();
  const segments = groupSegments(transcript.messages, workOf, (repo) => currentBranch(repo) ?? 'HEAD', fallbackTs);
  if (segments.size === 0) {
    // No messages in work repos: commits made from the last directory still count.
    const repo = workOf(transcript.cwd ?? job.cwd);
    if (!repo) return done(sawRepo ? 'repo is not marked as work' : 'not a git repo');
    const day = localDate(new Date(transcript.lastTs ?? fallbackTs));
    segments.set(`${repo}\0${currentBranch(repo) ?? 'HEAD'}\0${day}`, { repo, branch: currentBranch(repo) ?? 'HEAD', day, messages: [] });
  }

  let written = 0;
  let commits = 0;
  let dropped = 0;
  let cut = transcript.cut;
  for (const seg of segments.values()) {
    const times = seg.messages.map((m) => m.ts).filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b));
    const from = times[0] ?? transcript.firstTs ?? fallbackTs;
    const to = times[times.length - 1] ?? transcript.lastTs ?? fallbackTs;
    const until = new Date(new Date(to).getTime() + CAPTURE.commitSlackMinutes * 60_000);
    const activity = branchActivity(seg.repo, seg.branch, new Date(from), until);
    if (seg.messages.length === 0 && activity.commits.length === 0) continue;

    const fitted = fitTurns(seg.messages, DEFAULTS.rawMaxBytesPerSegment, BYTES, MIN_CAP_BYTES);
    dropped += fitted.dropped;
    cut += fitted.cut;
    const summaries = transcript.compactSummaries.filter(
      (c) => (c.cwd ? workOf(c.cwd) : null) === seg.repo && (c.branch && c.branch !== 'HEAD' ? c.branch : seg.branch) === seg.branch && c.ts && localDate(new Date(c.ts)) === seg.day,
    );

    const capture: RawCapture = {
      schema: 1,
      session_id: job.session_id,
      repo: { path: seg.repo, name: basename(seg.repo) },
      branch: seg.branch,
      segment: seg.day,
      captured_at: now.toISOString(),
      period: { from, to },
      cc_version: transcript.version,
      reason: job.reason,
      messages: fitted.kept.map((m) => ({ role: m.role, ts: m.ts, text: m.text })),
      truncated: { dropped: fitted.dropped, cut: fitted.cut },
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
    if (summaries.length) capture.compact_summaries = summaries.map((c) => ({ ts: c.ts, text: c.text }));
    capture.redacted = { ...redacted };
    writeRaw(capture, now);
    written++;
    commits += capture.commits.length;
  }

  recordCapture(job.session_id, mtimeMs, now);
  log('info', 'capture: done', {
    session,
    reason: job.reason,
    repos: [...new Set([...segments.values()].map((g) => basename(g.repo)))],
    segments: written,
    messages: transcript.messages.length,
    commits,
    dropped,
    cut,
    summaries: transcript.compactSummaries.length,
    skipped_entries: transcript.rejected,
    unmarked_repos: unmarked.size,
    redacted,
  });
}

/** The marked repo this checkout belongs to: itself, or the main checkout of a linked worktree. */
function markedWorkRepo(root: string, state: State): string | null {
  if (isWorkRepo(root, state)) return root;
  const main = mainWorktreeRoot(root);
  return main && isWorkRepo(main, state) ? main : null;
}

/** Whether a repo (or its main checkout) has any marking: personal ones are not remembered as unmarked. */
function isMarked(root: string, state: State): boolean {
  if (state.repos?.[root]) return true;
  const main = mainWorktreeRoot(root);
  return !!main && !!state.repos?.[main];
}

interface Segment {
  repo: string;
  branch: string;
  day: string;
  messages: TranscriptMessage[];
}

/**
 * Messages grouped by work repo, the branch Claude Code recorded at the time and the local day,
 * in order of first appearance. Each group is one raw file with its own budget.
 */
function groupSegments(
  messages: TranscriptMessage[],
  workOf: (cwd: string | undefined) => string | null,
  branchOf: (repo: string) => string,
  fallbackTs: string,
): Map<string, Segment> {
  const groups = new Map<string, Segment>();
  let lastTs = fallbackTs;
  for (const m of messages) {
    const repo = workOf(m.cwd);
    if (!repo) continue;
    lastTs = m.ts ?? lastTs;
    const branch = m.branch && m.branch !== 'HEAD' ? m.branch : branchOf(repo);
    const day = localDate(new Date(lastTs));
    const key = `${repo}\0${branch}\0${day}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { repo, branch, day, messages: [] }));
    g.messages.push(m);
  }
  return groups;
}
