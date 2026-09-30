import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/capture/git.js';
import { runCapture } from '../src/capture/worker.js';
import { readState, type RepoKind } from '../src/state.js';
import { rawPath, type RawCapture } from '../src/store.js';
import { commit, git, makeRepo, tmp, tx, writeTranscript } from './helpers.js';

const GHP = ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('');
const SID = '11111111-2222-3333-4444-555555555555';
const T = (h: number, m = 0) => `2026-09-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});

const mark = (repos: Record<string, RepoKind>) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify({ repos, last_checkin: 'keep-me' }));
};
const logText = () => (existsSync(join(data, 'log', 'plugin.log')) ? readFileSync(join(data, 'log', 'plugin.log'), 'utf8') : '');
const storeFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)));
  };
  walk(join(data, 'digests'));
  return out;
};
const readRaw = (repo: string, branch: string, sid = SID): RawCapture => JSON.parse(readFileSync(rawPath(repo, branch, sid), 'utf8'));

/** A work session: repo on feature/PAY-42-webhooks with commits and a transcript. */
function session(opts: { branch?: string; cwd?: (repo: string) => string } = {}) {
  const branch = opts.branch ?? 'feature/PAY-42-webhooks';
  const repo = makeRepo('main');
  commit(repo, 'README.md', 'init', T(8));
  git(repo, ['checkout', '-q', '-b', branch]);
  commit(repo, 'src/webhooks.ts', 'PAY-42: webhook handler', T(10, 20));
  const root = repoRoot(repo)!;
  const cwd = opts.cwd ? opts.cwd(root) : root;
  const transcript = writeTranscript(
    join(tmp(), 'projects', 'p', `${SID}.jsonl`),
    [
      tx.prompt(`add webhook retries, token is ${GHP}`, T(10)),
      tx.assistant([{ type: 'thinking', thinking: 'private thoughts' }], T(10, 1)),
      tx.assistant([tx.text('Done: exponential backoff, because the provider rate-limits. Next: DLQ.')], T(10, 30)),
      tx.userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'password=hunter2 diff output' }], T(10, 31)),
    ],
    { cwd, sessionId: SID, gitBranch: branch },
  );
  return { repo: root, transcript, branch, cwd };
}

describe('capture worker', () => {
  it('captures a work repo session: texts, git, tickets; secrets removed', async () => {
    const s = session();
    mark({ [s.repo]: 'work' });
    await runCapture({ session_id: SID, transcript_path: s.transcript, cwd: s.cwd, reason: 'prompt_input_exit' });

    const raw = readRaw(s.repo, s.branch);
    expect(raw.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:add webhook retries, token is [REDACTED:github_token]',
      'assistant:Done: exponential backoff, because the provider rate-limits. Next: DLQ.',
    ]);
    expect(raw.repo).toEqual({ path: s.repo, name: raw.repo.name });
    expect(raw.branch).toBe('feature/PAY-42-webhooks');
    expect(raw.period).toEqual({ from: T(10), to: T(10, 30) });
    expect(raw.commits.map((c) => c.message)).toEqual(['PAY-42: webhook handler']);
    expect(raw.files).toEqual(['src/webhooks.ts']);
    expect(raw.tickets).toEqual(['PAY-42']);
    expect(raw.redacted).toEqual({ github_token: 1 });
    expect(raw.reason).toBe('prompt_input_exit');

    const file = JSON.stringify(storeFiles().map((f) => readFileSync(f, 'utf8')));
    expect(file).not.toContain(GHP);
    expect(file).not.toContain('private thoughts');
    expect(file).not.toContain('hunter2');

    const state = readState();
    expect(state.last_checkin).toBe('keep-me');
    expect(state.captures?.[SID]).toBe(statSync(s.transcript).mtimeMs);
    expect(state.last_capture_at).toBeTruthy();
  });

  it('logs counts only: no texts, no tokens, no emails', async () => {
    const s = session();
    mark({ [s.repo]: 'work' });
    await runCapture({ session_id: SID, transcript_path: s.transcript, cwd: s.cwd });
    const log = logText();
    expect(log).toContain('capture: done');
    for (const bad of [GHP, 'webhook retries', 'backoff', 'dev@example.com', s.transcript]) expect(log).not.toContain(bad);
  });

  it.each([['personal' as const], ['unmarked' as const]])('%s repo: nothing is written, even locally', async (kind) => {
    const s = session();
    mark(kind === 'personal' ? { [s.repo]: 'personal' } : { '/some/other': 'work' });
    await runCapture({ session_id: SID, transcript_path: s.transcript, cwd: s.cwd });
    expect(storeFiles()).toEqual([]);
    expect(logText()).toContain('not marked as work');
    // remembered, so recovery won't pick it up again
    expect(readState().captures?.[SID]).toBeDefined();
  });

  it('non-git directory is skipped', async () => {
    const dir = tmp();
    mark({ [dir]: 'work' });
    const t = writeTranscript(join(tmp(), `${SID}.jsonl`), [tx.prompt('hello', T(10))], { cwd: dir });
    await runCapture({ session_id: SID, transcript_path: t, cwd: dir });
    expect(storeFiles()).toEqual([]);
    expect(logText()).toContain('not a git repo');
  });

  it('a session started in a subdirectory is stored under the repo', async () => {
    const s = session({ cwd: (r) => join(r, 'src') });
    mkdirSync(s.cwd, { recursive: true });
    mark({ [s.repo]: 'work' });
    await runCapture({ session_id: SID, transcript_path: s.transcript, cwd: s.cwd });
    expect(readRaw(s.repo, s.branch).messages).toHaveLength(2);
  });

  it('a linked worktree of a work repo is captured under the main repo', async () => {
    const s = session();
    const wt = join(tmp(), 'wt');
    git(s.repo, ['worktree', 'add', '-q', '-b', 'feature/PAY-43-wt', wt]);
    const wtRoot = repoRoot(wt)!;
    mark({ [s.repo]: 'work' });
    const t = writeTranscript(join(tmp(), `${SID}.jsonl`), [tx.prompt('in the worktree', T(10))], {
      cwd: wtRoot,
      gitBranch: 'feature/PAY-43-wt',
    });
    await runCapture({ session_id: SID, transcript_path: t, cwd: wtRoot });
    expect(readRaw(s.repo, 'feature/PAY-43-wt').messages[0]!.text).toBe('in the worktree');
  });

  it('recovery job without cwd reads it from the transcript', async () => {
    const s = session();
    mark({ [s.repo]: 'work' });
    await runCapture([{ session_id: SID, transcript_path: s.transcript, reason: 'recover' }]);
    expect(readRaw(s.repo, s.branch).reason).toBe('recover');
  });

  it('splits a session that switched branches', async () => {
    const s = session();
    git(s.repo, ['checkout', '-q', '-b', 'fix/OPS-7']);
    mark({ [s.repo]: 'work' });
    const t = writeTranscript(join(tmp(), `${SID}.jsonl`), [
      tx.prompt('first', T(10), { gitBranch: s.branch }),
      tx.prompt('second', T(11), { gitBranch: 'fix/OPS-7' }),
    ], { cwd: s.repo });
    await runCapture({ session_id: SID, transcript_path: t, cwd: s.repo });
    expect(readRaw(s.repo, s.branch).messages.map((m) => m.text)).toEqual(['first']);
    const other = readRaw(s.repo, 'fix/OPS-7');
    expect(other.messages.map((m) => m.text)).toEqual(['second']);
    expect(other.tickets).toEqual(['OPS-7']);
  });

  it('secrets in commit messages are removed too', async () => {
    const s = session();
    commit(s.repo, 'x.ts', `rotate key, old was ${GHP}`, T(10, 25));
    mark({ [s.repo]: 'work' });
    await runCapture({ session_id: SID, transcript_path: s.transcript, cwd: s.cwd });
    const raw = readRaw(s.repo, s.branch);
    expect(raw.commits[0]!.message).toBe('rotate key, old was [REDACTED:github_token]');
    expect(raw.redacted.github_token).toBe(2);
  });

  it('an empty session with no commits writes nothing', async () => {
    const s = session();
    mark({ [s.repo]: 'work' });
    const t = writeTranscript(join(tmp(), `${SID}.jsonl`), [{ type: 'mode', mode: 'normal' }], { cwd: s.repo });
    await runCapture({ session_id: SID, transcript_path: t, cwd: s.repo });
    expect(storeFiles()).toEqual([]);
  });

  it('one broken job does not stop the others; nothing throws', async () => {
    const s = session();
    mark({ [s.repo]: 'work' });
    await expect(
      runCapture([
        { session_id: 'missing', transcript_path: '/nope/x.jsonl' },
        { session_id: 'no-path' },
        { session_id: 42 as unknown as string, transcript_path: s.transcript },
        { session_id: SID, transcript_path: s.transcript, cwd: s.cwd },
      ]),
    ).resolves.toBeUndefined();
    expect(existsSync(rawPath(s.repo, s.branch, SID))).toBe(true);
    expect(logText()).toContain('transcript missing');
  });
});
