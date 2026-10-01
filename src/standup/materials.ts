/**
 * Materials for the synthesis subagent: raw captures since last_checkin plus the author's commits
 * made outside Claude Code sessions, rendered as compact text and split into parts that fit the
 * Bash tool output limit (the subagent reads them through `standup prepare [--part N]`; reading a
 * file from the plugin data dir would trigger a permission prompt).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CAPTURE, DEFAULTS } from '../config.js';
import { paths } from '../paths.js';
import { fitTurns } from '../capture/budget.js';
import { cutBytes } from '../capture/transcript.js';
import { readDigest, repoKey, type RawCapture } from '../store.js';

/**
 * Bash tool output above ~30 KB is saved to a file instead of shown (seen live on Cyrillic text at
 * 33 KB / 25k chars), and the subagent then wanders off with cat/sed. Budget parts in UTF-8 bytes.
 */
export const PART_BYTES = 24_000;

export interface Materials {
  from: string;
  to: string;
  captures: RawCapture[];
  outside: OutsideCommit[];
}

export interface OutsideCommit {
  repo: string;
  repoPath: string;
  branch: string;
  sha: string;
  ts: string;
  message: string;
}

/** Raw capture files whose session ended after `fromMs` (store sets mtime = end of session). Stat only. */
export function rawFilesSince(fromMs: number): string[] {
  const out: string[] = [];
  for (const repo of dirs(paths.digests())) {
    for (const branch of dirs(join(paths.digests(), repo))) {
      const raw = join(paths.digests(), repo, branch, 'raw');
      for (const f of files(raw)) {
        if (!f.endsWith('.json')) continue;
        try {
          if (statSync(join(raw, f)).mtimeMs > fromMs) out.push(join(raw, f));
        } catch {
          // expired meanwhile
        }
      }
    }
  }
  return out;
}

export function loadCaptures(fromMs: number): RawCapture[] {
  const caps: RawCapture[] = [];
  for (const f of rawFilesSince(fromMs)) {
    try {
      caps.push(JSON.parse(readFileSync(f, 'utf8')) as RawCapture);
    } catch {
      // half-written or corrupt: skip
    }
  }
  return caps.sort((a, b) => a.period.from.localeCompare(b.period.from));
}

/**
 * The author's commits in work repos since `from` that no capture already holds: work done
 * outside Claude Code (card 1, «Доработки» section). `limitPerRepo` 1 makes it a cheap «any work?» check.
 */
export function outsideCommits(repos: string[], from: Date, known: Set<string>, limitPerRepo: number = CAPTURE.maxCommitsPerBranch): OutsideCommit[] {
  const out: OutsideCommit[] = [];
  for (const repo of repos) {
    const email = git(repo, ['config', 'user.email'])?.trim();
    if (!email) continue;
    const log = git(repo, [
      'log', '--branches', '--no-merges', '--source', `--since=${from.toISOString()}`, `--author=<${email}>`,
      '--regexp-ignore-case', '--fixed-strings', `--max-count=${limitPerRepo + known.size}`, '--format=%H%x1f%S%x1f%aI%x1f%s%x1e',
    ]);
    let n = 0;
    for (const rec of (log ?? '').split('\x1e')) {
      const [sha, ref, ts, subject] = rec.trim().split('\x1f');
      if (!sha || !ts || known.has(sha)) continue;
      out.push({ repo: basename(repo), repoPath: repo, branch: (ref ?? '').replace(/^refs\/heads\//, ''), sha, ts, message: subject ?? '' });
      if (++n >= limitPerRepo) break;
    }
  }
  return out;
}

export function collect(from: Date, to: Date, workRepos: string[]): Materials {
  const captures = loadCaptures(from.getTime());
  const known = new Set(captures.flatMap((c) => c.commits.map((k) => k.sha)));
  return { from: from.toISOString(), to: to.toISOString(), captures, outside: outsideCommits(workRepos, from, known) };
}

/** The language the developer writes in, for the prompt's dev_language: by letters in their messages. */
export function devLanguage(captures: RawCapture[]): string {
  let cyr = 0;
  let lat = 0;
  for (const c of captures)
    for (const m of c.messages)
      if (m.role === 'user') {
        cyr += (m.text.match(/[А-Яа-яЁё]/g) ?? []).length;
        lat += (m.text.match(/[A-Za-z]/g) ?? []).length;
      }
  return cyr > lat * 0.5 ? 'Russian' : 'English';
}

/**
 * Render to text in the shape the standup prompt describes (period, dev_language, per repo/branch
 * existing_digest + raw entries, commits_outside_sessions) and split into parts of at most PART_BYTES.
 * Every branch carries its repo_id: the synthesis subagent saves digests under it.
 */
export function render(m: Materials, prompt: { version: string; text: string }, maxChars: number = DEFAULTS.synthMaxChars): string[] {
  const head = [`# Prompt (prompt_version: ${prompt.version})`, prompt.text.trim(), '', '# Input', `period: {from: ${m.from}, to: ${m.to}}`, `dev_language: ${devLanguage(m.captures)}`, ''];
  const body: string[] = [];
  // Over the limit, each capture gets a share proportional to its size: a long day keeps more.
  const sizeOf = (c: RawCapture) => c.messages.reduce((n, x) => n + x.text.length, 0) + (c.compact_summaries ?? []).reduce((n, x) => n + x.text.length, 0);
  const total = m.captures.reduce((n, c) => n + sizeOf(c), 0);
  const budgetOf = (c: RawCapture) => (total <= maxChars ? Infinity : Math.max(2_000, Math.floor((maxChars * sizeOf(c)) / total)));

  // Branches with new entries: from captures and from commits made outside sessions.
  type Branch = { repo: string; repoId: string; branch: string; caps: RawCapture[]; outside: OutsideCommit[] };
  const branches = new Map<string, Branch>();
  const get = (repo: string, repoPath: string, branch: string) => {
    const repoId = repoKey(repoPath);
    const k = `${repoId}\0${branch}`;
    let b = branches.get(k);
    if (!b) branches.set(k, (b = { repo, repoId, branch, caps: [], outside: [] }));
    return b;
  };
  for (const c of m.captures) get(c.repo.name, c.repo.path, c.branch).caps.push(c);
  for (const k of m.outside) get(k.repo, k.repoPath, k.branch || 'HEAD').outside.push(k);

  for (const b of branches.values()) {
    const tickets = [...new Set(b.caps.flatMap((c) => c.tickets))];
    body.push(`## repo: ${b.repo} · repo_id: ${b.repoId} · branch: ${b.branch}${tickets.length ? ` · ticket: ${tickets.join(', ')}` : ''}`);
    const digest = readDigest(b.repoId, b.branch).trim();
    body.push('existing_digest:', digest || '(empty)', '', 'raw entries:');
    // Two sessions on the same branch and day can both hold a commit.
    const commits = [...new Map(b.caps.flatMap((c) => c.commits).map((k) => [k.sha, k])).values()].sort((x, y) => x.ts.localeCompare(y.ts));
    if (commits.length) {
      body.push('commits:');
      for (const k of commits) body.push(`- ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message.split('\n')[0]}`);
    }
    const files = [...new Set(b.caps.flatMap((c) => c.files))];
    if (files.length) body.push(`changed files: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ` (+${files.length - 30})` : ''}`);
    for (const c of b.caps) {
      body.push(`session ${c.period.from.slice(0, 16)} — ${c.period.to.slice(11, 16)}:`);
      body.push(...sessionLines(c, budgetOf(c)));
    }
    if (b.outside.length) {
      body.push('commits_outside_sessions:');
      for (const k of b.outside) body.push(`- ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message}`);
    }
    body.push('');
  }
  if (body.length === 0) body.push('No work found since the last standup.');
  return split([...head, ...body]);
}

const OMITTED = '… (part of the conversation omitted)';
const CUT = '…[cut]';
const CHARS = { size: (t: string) => t.length, cut: (t: string, max: number) => t.slice(0, Math.max(0, max - CUT.length)) + CUT };
/** Smallest per-message cap in characters when a capture is squeezed. */
const MIN_CAP_CHARS = 150;
/** A compaction summary takes at most this share of a capture's budget. */
const SUMMARY_SHARE = 0.3;

/**
 * Every developer prompt and Claude's result of every turn, thinned evenly to fit (capture/budget.ts);
 * Claude Code's compaction summaries come first: they cover what the thinned middle lost.
 */
function sessionLines(c: RawCapture, budget: number): string[] {
  const out: string[] = [];
  let room = budget;
  for (const s of c.compact_summaries ?? []) {
    const text = room === Infinity ? s.text : CHARS.size(s.text) > budget * SUMMARY_SHARE ? CHARS.cut(s.text, Math.floor(budget * SUMMARY_SHARE)) : s.text;
    out.push(`(Claude Code's summary of the conversation so far${s.ts ? `, ${s.ts.slice(0, 16)}` : ''}): ${text.replace(/\n{3,}/g, '\n\n')}`);
    room -= text.length;
  }
  const msgs = c.messages.map((m) => ({ ...m, text: m.text.replace(/\n{3,}/g, '\n\n') }));
  const fitted = fitTurns(msgs, room === Infinity ? Infinity : Math.max(room, MIN_CAP_CHARS * 4), CHARS, MIN_CAP_CHARS);
  const at = new Map(fitted.indices.map((i, k) => [i, fitted.kept[k]!]));
  msgs.forEach((_, i) => {
    const m = at.get(i);
    if (m) out.push(`${m.role === 'user' ? '> developer' : '< claude'}: ${m.text}`);
    else if (out[out.length - 1] !== OMITTED) out.push(OMITTED);
  });
  return out;
}

function split(lines: string[]): string[] {
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (let l of lines) {
    let size = Buffer.byteLength(l, 'utf8');
    if (size > PART_BYTES) {
      l = cutBytes(l, PART_BYTES - 40).text;
      size = Buffer.byteLength(l, 'utf8');
    }
    if (curBytes + size + 1 > PART_BYTES) {
      parts.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += l + '\n';
    curBytes += size + 1;
  }
  if (cur) parts.push(cur);
  return parts;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: CAPTURE.gitTimeoutMs,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
}

const dirs = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};
const files = (d: string) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
