import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tmp(prefix = 'sa-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A throwaway git repo with a fixed identity and no global config. */
export function makeRepo(branch = 'main'): string {
  const dir = tmp('sa-repo-');
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
}

/** Commit a file with a fixed date (both author and committer). */
export function commit(
  repo: string,
  file: string,
  message: string,
  date: string,
  author?: { name: string; email: string },
): string {
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${message}\n${Math.random()}\n`);
  git(repo, ['add', file]);
  const env: Record<string, string> = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  if (author) Object.assign(env, { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email });
  git(repo, ['commit', '-q', '-m', message], env);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

type Entry = Record<string, unknown>;

/** Transcript line builders that mimic Claude Code 2.1.28x structure. */
export const tx = {
  prompt: (text: string, ts: string, extra: Entry = {}): Entry => ({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: ts,
    promptSource: 'typed',
    origin: { kind: 'human' },
    ...extra,
  }),
  userBlocks: (content: unknown[], ts: string, extra: Entry = {}): Entry => ({
    type: 'user',
    message: { role: 'user', content },
    timestamp: ts,
    ...extra,
  }),
  assistant: (content: unknown[], ts: string, extra: Entry = {}): Entry => ({
    type: 'assistant',
    message: { model: 'claude-opus-5-5', role: 'assistant', type: 'message', content },
    timestamp: ts,
    ...extra,
  }),
  text: (text: string) => ({ type: 'text', text }),
};

/** Write a transcript; every entry gets cwd/sessionId/gitBranch/version unless it sets its own. */
export function writeTranscript(
  path: string,
  entries: (Entry | string)[],
  common: { cwd?: string; sessionId?: string; gitBranch?: string } = {},
): string {
  mkdirSync(dirname(path), { recursive: true });
  const lines = entries.map((e) =>
    typeof e === 'string' ? e : JSON.stringify({ version: '2.1.285', ...common, ...e }),
  );
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
