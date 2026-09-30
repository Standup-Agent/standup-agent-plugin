import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CAPTURE } from '../config.js';

export const TICKET_RE = /[A-Z][A-Z0-9]+-\d+/g;

export interface Commit {
  sha: string;
  /** Author date, ISO. */
  ts: string;
  /** Full message (subject + body), trimmed. */
  message: string;
  files: string[];
}

export interface BranchActivity {
  branch: string;
  commits: Commit[];
  /** Files touched by those commits plus uncommitted changes (when the branch is checked out). */
  files: string[];
  tickets: string[];
}

/** Run git; null on any failure (no repo, no git binary, timeout). */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CAPTURE.gitTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Don't take index.lock for `status`: the user's own git must never wait on us.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
}

/** Absolute top level of the work tree containing `cwd`, or null for a non-git directory. */
export function repoRoot(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || null;
}

/**
 * For a linked worktree, the top level of the main work tree (repo marking is per repo, and task 3
 * marks the main checkout). Null when `root` is itself the main work tree or it can't be told.
 */
export function mainWorktreeRoot(root: string): string | null {
  const common = git(root, ['rev-parse', '--git-common-dir'])?.trim();
  if (!common) return null;
  const abs = isAbsolute(common) ? common : resolve(root, common);
  const main = dirname(abs);
  return main === root ? null : main;
}

/** URLs of all remotes (`remote.<name>.url`), origin first. */
export function gitConfigRemotes(root: string): string[] {
  const out = git(root, ['config', '--get-regexp', '^remote\\..*\\.url$']) ?? '';
  const pairs = out
    .split('\n')
    .map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1]!, url: m[2]! }));
  pairs.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
  return pairs.map((p) => p.url);
}

/** Currently checked-out branch; null when detached. */
export function currentBranch(cwd: string): string | null {
  return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() || null;
}

export function findTickets(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(TICKET_RE)) seen.add(m[0]);
  return [...seen];
}

const REC = '\x1e';
const SEP = '\x1f';
const END = '\x1d';

/**
 * Commits made on `branch` during [from, to] (commit date), without merges. Filtered to the local
 * git user's email when it is set: after `git pull` the branch also carries teammates' commits.
 */
export function branchActivity(root: string, branch: string, from: Date, to: Date): BranchActivity {
  const ref = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]) ? `refs/heads/${branch}` : null;
  const commits: Commit[] = [];
  if (ref) {
    const email = git(root, ['config', 'user.email'])?.trim();
    const args = [
      'log', ref, '--no-merges', `--since=${from.toISOString()}`, `--until=${to.toISOString()}`,
      `--max-count=${CAPTURE.maxCommitsPerBranch}`, `--format=${REC}%H${SEP}%aI${SEP}%B${END}`, '--name-only',
    ];
    if (email) args.push(`--author=<${email}>`, '--regexp-ignore-case', '--fixed-strings');
    const out = git(root, args) ?? '';
    for (const rec of out.split(REC)) {
      if (!rec.trim()) continue;
      const [head, filesPart = ''] = rec.split(END);
      const [sha, ts, message = ''] = (head ?? '').split(SEP);
      if (!sha || !ts) continue;
      commits.push({
        sha,
        ts,
        message: message.trim(),
        files: filesPart.split('\n').map((f) => f.trim()).filter(Boolean),
      });
    }
  }

  const files = new Set<string>();
  for (const c of commits) for (const f of c.files) files.add(f);
  if (currentBranch(root) === branch) for (const f of uncommittedFiles(root)) files.add(f);

  return {
    branch,
    commits,
    files: [...files].slice(0, CAPTURE.maxFilesPerBranch),
    tickets: findTickets(branch, ...commits.map((c) => c.message)),
  };
}

/** Paths with staged, unstaged or untracked changes. */
export function uncommittedFiles(root: string): string[] {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!out) return [];
  const files: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    files.push(p.slice(3));
    // Renames/copies carry the source path as the next NUL-separated field.
    if (p[0] === 'R' || p[0] === 'C') i++;
  }
  return files;
}
