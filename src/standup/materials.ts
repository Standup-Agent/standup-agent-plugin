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
import type { RawCapture } from '../store.js';

/** Default Bash tool output limit is 30 000 chars; keep a margin for the part header. */
export const PART_CHARS = 25_000;

export interface Materials {
  from: string;
  to: string;
  captures: RawCapture[];
  outside: OutsideCommit[];
}

export interface OutsideCommit {
  repo: string;
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
 * outside Claude Code (card 1, «Доработки»). `limitPerRepo` 1 makes it a cheap «any work?» check.
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
      out.push({ repo: basename(repo), branch: (ref ?? '').replace(/^refs\/heads\//, ''), sha, ts, message: subject ?? '' });
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

/** Render to text and split into parts of at most PART_CHARS on line boundaries. */
export function render(m: Materials, prompt: { version: string; text: string }, maxChars: number = DEFAULTS.synthMaxChars): string[] {
  const head = [
    `# Материалы для стендапа`,
    `Период: ${m.from} — ${m.to} (с последнего отправленного стендапа)`,
    '',
    `## Как писать стендап (prompt_version: ${prompt.version})`,
    prompt.text.trim(),
    '',
  ];
  const body: string[] = [];
  const perSession = Math.max(2_000, Math.floor(maxChars / Math.max(1, m.captures.length)));

  const byRepo = new Map<string, RawCapture[]>();
  for (const c of m.captures) {
    const list = byRepo.get(c.repo.name) ?? [];
    list.push(c);
    byRepo.set(c.repo.name, list);
  }
  for (const [repo, caps] of byRepo) {
    body.push(`## Репо ${repo}`);
    const byBranch = new Map<string, RawCapture[]>();
    for (const c of caps) byBranch.set(c.branch, [...(byBranch.get(c.branch) ?? []), c]);
    for (const [branch, list] of byBranch) {
      const tickets = [...new Set(list.flatMap((c) => c.tickets))];
      body.push(`### Ветка ${branch}${tickets.length ? ` · тикеты: ${tickets.join(', ')}` : ''}`);
      const commits = list.flatMap((c) => c.commits);
      if (commits.length) {
        body.push('Коммиты:');
        for (const k of commits) body.push(`- ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message.split('\n')[0]}`);
      }
      const files = [...new Set(list.flatMap((c) => c.files))];
      if (files.length) body.push(`Файлы: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ` и ещё ${files.length - 30}` : ''}`);
      for (const c of list) {
        body.push(`Сессия ${c.period.from.slice(0, 16)} — ${c.period.to.slice(11, 16)}:`);
        body.push(...sessionLines(c, perSession));
      }
      body.push('');
    }
  }
  if (m.outside.length) {
    body.push('## Коммиты вне сессий Claude Code');
    for (const k of m.outside) body.push(`- ${k.repo} / ${k.branch} ${k.ts.slice(0, 16)} ${k.sha.slice(0, 7)} ${k.message}`);
  }
  if (body.length === 0) body.push('Работы с последнего стендапа не найдено.');
  return split([...head, ...body]);
}

/** First user message (the task) and the latest messages that fit: the middle goes first. */
function sessionLines(c: RawCapture, budget: number): string[] {
  const line = (m: RawCapture['messages'][number]) => `${m.role === 'user' ? '> Разработчик' : '< Claude'}: ${m.text.replace(/\n{3,}/g, '\n\n')}`;
  const lines = c.messages.map(line);
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (total <= budget) return lines;
  const first = c.messages.findIndex((m) => m.role === 'user');
  const keep = new Set<number>(first >= 0 ? [first] : []);
  let used = first >= 0 ? lines[first]!.length : 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    if (used + lines[i]!.length > budget) break;
    keep.add(i);
    used += lines[i]!.length;
  }
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (keep.has(i)) out.push(l);
    else if (out[out.length - 1] !== '… (часть переписки опущена)') out.push('… (часть переписки опущена)');
  });
  return out;
}

function split(lines: string[]): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let l of lines) {
    if (l.length > PART_CHARS) l = l.slice(0, PART_CHARS - 20) + ' …[обрезано]';
    if (cur.length + l.length + 1 > PART_CHARS) {
      parts.push(cur);
      cur = '';
    }
    cur += l + '\n';
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
