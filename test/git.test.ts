import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchActivity, currentBranch, findTickets, mainWorktreeRoot, repoRoot, uncommittedFiles } from '../src/capture/git.js';
import { commit, git, makeRepo, tmp } from './helpers.js';

const D = (h: number, m = 0) => `2026-09-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const at = (h: number, m = 0) => new Date(D(h, m));

describe('repoRoot / currentBranch', () => {
  it('finds the top level from a subdirectory', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(repoRoot(join(repo, 'src', 'deep'))).toBe(realpathSync(repo));
  });

  it('returns null outside git and for a missing dir', () => {
    expect(repoRoot(tmp())).toBeNull();
    expect(repoRoot('/definitely/not/here')).toBeNull();
  });

  it('reports the branch, null when detached', () => {
    const repo = makeRepo('feature/PAY-42-webhooks');
    commit(repo, 'a.txt', 'init', D(9));
    expect(currentBranch(repo)).toBe('feature/PAY-42-webhooks');
    git(repo, ['checkout', '-q', '--detach']);
    expect(currentBranch(repo)).toBeNull();
  });

  it('maps a linked worktree to the main checkout', () => {
    const repo = makeRepo();
    commit(repo, 'a.txt', 'init', D(9));
    const wt = join(tmp(), 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
    expect(mainWorktreeRoot(realpathSync(wt))).toBe(realpathSync(repo));
    expect(mainWorktreeRoot(realpathSync(repo))).toBeNull();
  });
});

describe('findTickets', () => {
  it('finds unique ids in order', () => {
    expect(findTickets('feature/PAY-42-webhooks', 'PAY-42: retries', 'fix CORE2-7 and PAY-43')).toEqual(['PAY-42', 'CORE2-7', 'PAY-43']);
  });
  it('ignores lowercase, one-letter keys and non-ids', () => {
    expect(findTickets('fix/pay-42', 'A-1 X- bump to v2-3')).toEqual([]);
  });
  it('follows the spec regex literally: UTF-8 looks like a ticket (filtered later by synthesis)', () => {
    expect(findTickets('switch to UTF-8')).toEqual(['UTF-8']);
  });
});

describe('branchActivity', () => {
  it('takes the author\'s commits on the branch within the period', () => {
    const repo = makeRepo('main');
    commit(repo, 'README.md', 'init', D(8));
    git(repo, ['checkout', '-q', '-b', 'feature/PAY-42-webhooks']);
    commit(repo, 'old.ts', 'before the session', D(9));
    const c1 = commit(repo, 'src/webhooks.ts', 'PAY-42: add webhook handler\n\nRetries with backoff.', D(10, 15));
    commit(repo, 'src/teammate.ts', 'teammate change', D(10, 30), { name: 'Bob', email: 'bob@example.com' });
    const c2 = commit(repo, 'test/webhooks.test.ts', 'tests for CORE-7 too', D(11));
    commit(repo, 'late.ts', 'after the session', D(13));

    const a = branchActivity(repo, 'feature/PAY-42-webhooks', at(10), at(12));
    expect(a.commits.map((c) => c.sha)).toEqual([c2, c1]);
    expect(a.commits[1]!.message).toBe('PAY-42: add webhook handler\n\nRetries with backoff.');
    expect(a.commits[1]!.files).toEqual(['src/webhooks.ts']);
    expect(a.files.sort()).toEqual(['src/webhooks.ts', 'test/webhooks.test.ts']);
    expect(a.tickets).toEqual(['PAY-42', 'CORE-7']);
  });

  it('skips merge commits', () => {
    const repo = makeRepo('main');
    commit(repo, 'a.txt', 'init', D(8));
    git(repo, ['checkout', '-q', '-b', 'feat']);
    commit(repo, 'b.txt', 'feat work', D(10));
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'c.txt', 'main work', D(10, 5));
    git(repo, ['checkout', '-q', 'feat']);
    git(repo, ['merge', '-q', '--no-edit', 'main'], { GIT_AUTHOR_DATE: D(10, 10), GIT_COMMITTER_DATE: D(10, 10) });
    expect(branchActivity(repo, 'feat', at(9), at(12)).commits.map((c) => c.message)).toEqual(['main work', 'feat work']);
  });

  it('adds uncommitted and untracked files only for the checked-out branch', () => {
    const repo = makeRepo('main');
    commit(repo, 'a.txt', 'init', D(8));
    writeFileSync(join(repo, 'a.txt'), 'changed');
    writeFileSync(join(repo, 'new file.ts'), 'x');
    git(repo, ['branch', 'other']);
    expect(branchActivity(repo, 'main', at(9), at(12)).files.sort()).toEqual(['a.txt', 'new file.ts']);
    expect(branchActivity(repo, 'other', at(9), at(12)).files).toEqual([]);
  });

  it('reports renames by their new path', () => {
    const repo = makeRepo('main');
    commit(repo, 'old.ts', 'init', D(8));
    git(repo, ['mv', 'old.ts', 'new.ts']);
    expect(uncommittedFiles(repo)).toEqual(['new.ts']);
  });

  it('ticket from the branch even without commits; unknown branch is empty', () => {
    const repo = makeRepo('main');
    commit(repo, 'a.txt', 'init', D(8));
    expect(branchActivity(repo, 'feature/OPS-9-gone', at(9), at(12))).toEqual({
      branch: 'feature/OPS-9-gone',
      commits: [],
      files: [],
      tickets: ['OPS-9'],
    });
  });

  it('does not treat regex characters in the email as a pattern', () => {
    const repo = makeRepo('main');
    git(repo, ['config', 'user.email', 'dev+ci@example.com']);
    commit(repo, 'a.txt', 'mine', D(10), { name: 'Dev', email: 'dev+ci@example.com' });
    commit(repo, 'b.txt', 'not mine', D(10, 5), { name: 'X', email: 'devci@example.com' });
    expect(branchActivity(repo, 'main', at(9), at(12)).commits.map((c) => c.message)).toEqual(['mine']);
  });
});
