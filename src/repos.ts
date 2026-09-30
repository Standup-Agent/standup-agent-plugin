/**
 * Work/personal repo marking (task 3).
 *
 * A repo is identified by its main checkout's top level (`git rev-parse --show-toplevel`; a linked
 * worktree counts as its main checkout) — the same key task 1 checks before capturing.
 * A repo whose remote belongs to one of the team's work orgs is marked `work` without a question.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gitConfigRemotes, mainWorktreeRoot, repoRoot } from './capture/git.js';
import { readTranscriptCwd } from './capture/transcript.js';
import type { RepoKind, State } from './state.js';

export interface Repo {
  /** Main checkout top level: the key in state.repos. */
  path: string;
  name: string;
  /** Normalized remotes, `host/owner/name`. */
  remotes: string[];
}

export interface RepoCandidate extends Repo {
  /** Newest transcript mtime among sessions in this repo, ISO. */
  lastActivity: string;
}

/**
 * `git@github.com:Acme/api.git`, `https://user:tok@github.com/Acme/api`, `ssh://git@host:22/a/b.git`
 * → `github.com/acme/api`. Local paths and unparseable URLs → null.
 */
export function normalizeRemote(url: string): string | null {
  let u = url.trim();
  if (u === '') return null;
  // scp-like syntax: [user@]host:path (no scheme, colon before the first slash)
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    if (!scp) return null;
    u = `ssh://${scp[1]}/${scp[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol === 'file:' || !parsed.hostname) return null;
  const path = parsed.pathname.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
  if (path === '') return null;
  return `${parsed.hostname}/${path}`.toLowerCase();
}

/** `https://GitHub.com/Acme/`, `git@github.com:Acme`, `github.com/Acme` → `github.com/acme`. */
export function normalizeOrg(org: string): string {
  const o = org.trim();
  return normalizeRemote(o) ?? o.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/** A remote belongs to an org when the org is a path prefix of it: `github.com/acme` ⊂ `github.com/acme/api`. */
export function matchesWorkOrg(remotes: string[], workOrgs: string[]): boolean {
  const orgs = workOrgs.map(normalizeOrg).filter((o) => o.includes('/'));
  return remotes.some((r) => orgs.some((o) => r === o || r.startsWith(`${o}/`)));
}

/** The repo a directory belongs to, or null when it isn't in a git work tree (or no longer exists). */
export function repoOf(cwd: string): Repo | null {
  if (!existsSync(cwd)) return null;
  const root = repoRoot(cwd);
  if (!root) return null;
  const path = mainWorktreeRoot(root) ?? root;
  const remotes = [...new Set(gitConfigRemotes(path).map(normalizeRemote).filter((r): r is string => r !== null))];
  return { path, name: basename(path), remotes };
}

/**
 * Git repos the user worked in with Claude Code during the last `days` days, newest first.
 * One transcript per project dir is enough: its name comes from the session's start cwd.
 */
export async function scanRepos(projectsDir: string, days: number, now = Date.now()): Promise<RepoCandidate[]> {
  const floor = now - days * 86_400_000;
  const byPath = new Map<string, RepoCandidate>();
  for (const dir of safeReaddir(projectsDir)) {
    const newest = newestTranscript(join(projectsDir, dir), floor);
    if (!newest) continue;
    const cwd = await readTranscriptCwd(newest.path);
    if (!cwd) continue;
    const repo = repoOf(cwd);
    if (!repo) continue;
    const lastActivity = new Date(newest.mtime).toISOString();
    const seen = byPath.get(repo.path);
    if (!seen || seen.lastActivity < lastActivity) byPath.set(repo.path, { ...repo, lastActivity });
  }
  return [...byPath.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export interface Classified {
  /** Already marked earlier. */
  marked: (RepoCandidate & { kind: RepoKind })[];
  /** Unmarked, remote in a work org: to be marked work without asking. */
  autoWork: RepoCandidate[];
  /** Unmarked, not recognizable: ask the user. */
  ask: RepoCandidate[];
}

export function classify(candidates: RepoCandidate[], state: State): Classified {
  const out: Classified = { marked: [], autoWork: [], ask: [] };
  const orgs = state.team?.work_orgs ?? [];
  for (const c of candidates) {
    const kind = state.repos?.[c.path];
    if (kind) out.marked.push({ ...c, kind });
    else if (matchesWorkOrg(c.remotes, orgs)) out.autoWork.push(c);
    else out.ask.push(c);
  }
  return out;
}

function newestTranscript(dir: string, floor: number): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const path = join(dir, f);
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime >= floor && (!best || mtime > best.mtime)) best = { path, mtime };
    } catch {
      // vanished
    }
  }
  return best;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
