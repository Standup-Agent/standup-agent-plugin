import { mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDirName } from '../src/capture/discover.js';
import { reposCommand } from '../src/commands/repos.js';
import { newRepoCheck, sq } from '../src/hooks/session-start.js';
import { classify, matchesWorkOrg, normalizeOrg, normalizeRemote, repoOf, scanRepos } from '../src/repos.js';
import { readState } from '../src/state.js';
import { git, makeRepo, tmp, tx, writeTranscript } from './helpers.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const DAY = 86_400_000;
let data: string;
let cfg: string;
let projects: string;

beforeEach(() => {
  data = tmp();
  cfg = tmp('sa-cfg-');
  projects = join(cfg, 'projects');
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

const state = (s: unknown) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify(s));
};

/** A repo with an origin remote; returns its real top level (tmpdir is a symlink on macOS). */
const repo = (remote?: string) => {
  const dir = makeRepo();
  if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  return realpathSync(dir);
};

/** A transcript whose first cwd is `cwd`, modified `ageDays` ago. */
const session = (cwd: string, sid: string, ageDays = 0) => {
  const file = writeTranscript(join(projects, projectDirName(cwd), `${sid}.jsonl`), [tx.prompt('hi', '2026-09-30T10:00:00Z')], { cwd, sessionId: sid });
  const t = new Date(NOW - ageDays * DAY);
  utimesSync(file, t, t);
  return file;
};

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:Acme/api.git', 'github.com/acme/api'],
    ['https://github.com/Acme/api.git', 'github.com/acme/api'],
    ['https://user:tok@github.com/Acme/api', 'github.com/acme/api'],
    ['ssh://git@gitlab.example.com:2222/group/sub/app.git', 'gitlab.example.com/group/sub/app'],
    ['git+ssh://git@github.com/acme/api.git/', 'github.com/acme/api'],
  ])('%s → %s', (url, want) => expect(normalizeRemote(url)).toBe(want));

  it.each(['/srv/git/api.git', '../api', 'file:///srv/git/api.git', ''])('%s is not a hosted remote', (url) => {
    expect(normalizeRemote(url)).toBeNull();
  });
});

describe('matchesWorkOrg', () => {
  it('matches an org as a path prefix, in any spelling', () => {
    expect(matchesWorkOrg(['github.com/acme/api'], ['https://GitHub.com/Acme/'])).toBe(true);
    expect(matchesWorkOrg(['gitlab.example.com/group/sub/app'], ['gitlab.example.com/group'])).toBe(true);
  });

  it('does not match a longer org name or a bare host', () => {
    expect(matchesWorkOrg(['github.com/acme-labs/api'], ['github.com/acme'])).toBe(false);
    expect(matchesWorkOrg(['github.com/acme/api'], ['github.com'])).toBe(false);
    expect(matchesWorkOrg([], ['github.com/acme'])).toBe(false);
  });

  it('normalizes org input like remotes', () => {
    expect(normalizeOrg('git@github.com:Acme')).toBe('github.com/acme');
    expect(normalizeOrg('github.com/Acme/')).toBe('github.com/acme');
    expect(matchesWorkOrg(['github.com/acme/api'], ['git@github.com:Acme'])).toBe(true);
    expect(normalizeOrg(' https://github.com/Simplewallethq/ ')).toBe('github.com/simplewallethq');
  });
});

describe('repoOf', () => {
  it('maps a subdirectory to the repo top level with its remotes, origin first', () => {
    const r = repo('git@github.com:acme/api.git');
    git(r, ['remote', 'add', 'upstream', 'https://github.com/other/api']);
    mkdirSync(join(r, 'src', 'deep'), { recursive: true });
    expect(repoOf(join(r, 'src', 'deep'))).toEqual({ path: r, name: r.split('/').pop(), remotes: ['github.com/acme/api', 'github.com/other/api'] });
  });

  it('maps a linked worktree to its main checkout', () => {
    const r = repo();
    git(r, ['commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = join(tmp(), 'wt');
    git(r, ['worktree', 'add', '-q', wt, '-b', 'feature/x']);
    expect(repoOf(wt)?.path).toBe(r);
  });

  it('returns null outside git and for a vanished directory', () => {
    expect(repoOf(tmp())).toBeNull();
    expect(repoOf('/nonexistent/for/sure')).toBeNull();
  });
});

describe('scanRepos + classify', () => {
  it('finds git repos active within the window, once each, newest first', async () => {
    const api = repo('git@github.com:acme/api.git');
    const blog = repo('https://github.com/me/blog');
    const old = repo('git@github.com:acme/old.git');
    session(api, 's1', 5);
    session(api, 's2', 1);
    mkdirSync(join(api, 'pkg'), { recursive: true });
    session(join(api, 'pkg'), 's3', 2); // subdirectory: same repo
    session(blog, 's4', 3);
    session(old, 's5', 40); // outside 30 days
    session(tmp(), 's6', 1); // not a git dir

    const found = await scanRepos(projects, 30, NOW);
    expect(found.map((r) => r.path)).toEqual([api, blog]);
    expect(found[0]!.lastActivity).toBe(new Date(NOW - 1 * DAY).toISOString());

    const c = classify(found, { team: { work_orgs: ['github.com/acme'] }, repos: {} });
    expect(c.autoWork.map((r) => r.path)).toEqual([api]);
    expect(c.ask.map((r) => r.path)).toEqual([blog]);
  });

  it('keeps already marked repos out of the question', async () => {
    const blog = repo('https://github.com/me/blog');
    session(blog, 's1', 1);
    const c = classify(await scanRepos(projects, 30, NOW), { repos: { [blog]: 'personal' } });
    expect(c.marked).toMatchObject([{ path: blog, kind: 'personal' }]);
    expect(c.ask).toEqual([]);
  });
});

describe('repos command', () => {
  it('scan marks org repos as work and returns the rest to ask about', async () => {
    const api = repo('git@github.com:acme/api.git');
    const blog = repo('https://github.com/me/blog');
    session(api, 's1', 1);
    session(blog, 's2', 1);
    state({ team: { name: 'Backend', work_orgs: ['github.com/acme'] } });

    const { code, out } = await reposCommand(['scan'], '/nonexistent/cli.js', NOW);
    expect(code).toBe(0);
    expect(out).toMatchObject({ team: 'Backend', auto_marked_work: [{ path: api, remote: 'github.com/acme/api' }], ask: [{ path: blog }] });
    expect(readState().repos).toEqual({ [api]: 'work' });
  });

  it('set stores a subdirectory under its repo and backfills only new work repos, ignoring skip marks', async () => {
    const api = repo();
    const blog = repo();
    mkdirSync(join(api, 'src'));
    session(api, 'recent', 1);
    session(api, 'older', 5); // outside the 3-day backfill
    // The worker recorded the recent session as skipped while the repo was unmarked.
    state({ captures: { recent: NOW } });

    const { code, out } = await reposCommand(['set', `${join(api, 'src')}=work`, `${blog}=personal`], '/nonexistent/cli.js', NOW);
    expect(code).toBe(0);
    expect(out).toEqual({ updated: { [api]: 'work', [blog]: 'personal' }, backfill_sessions: 1 });
    expect(readState().repos).toEqual({ [api]: 'work', [blog]: 'personal' });

    const again = await reposCommand(['set', `${api}=work`], '/nonexistent/cli.js', NOW);
    expect(again.out).toMatchObject({ backfill_sessions: 0 });
  });

  it('rejects relative paths and unknown kinds without changing state', async () => {
    state({ repos: {} });
    expect((await reposCommand(['set', 'api=work'], 'x')).code).toBe(1);
    expect((await reposCommand(['set', '/abs/api=secret'], 'x')).code).toBe(1);
    expect((await reposCommand(['bogus'], 'x')).code).toBe(1);
    expect(readState().repos).toEqual({});
  });

  it('list prints the marking', async () => {
    state({ team: { name: 'Backend' }, repos: { '/w/api': 'work', '/w/blog': 'personal' } });
    expect((await reposCommand(['list'], 'x')).out).toEqual({
      team: 'Backend',
      repos: [{ path: '/w/api', kind: 'work' }, { path: '/w/blog', kind: 'personal' }],
    });
  });
});

describe('newRepoCheck (SessionStart)', () => {
  const input = (cwd: string) => ({ session_id: 's', cwd });

  it('does nothing before joining a team', () => {
    const r = repo('git@github.com:acme/api.git');
    state({});
    expect(newRepoCheck(input(r), '/p/cli.js')).toBeNull();
    expect(readState().repos).toBeUndefined();
  });

  it('marks an org repo as work silently, with a one-line notice', () => {
    const r = repo('git@github.com:acme/api.git');
    state({ team: { work_orgs: ['github.com/acme'] } });
    expect(newRepoCheck(input(r), '/p/cli.js')?.systemMessage).toContain('включён в стендап');
    expect(readState().repos).toEqual({ [r]: 'work' });
  });

  it('asks about an unknown repo exactly once, answering through the skill', () => {
    const r = repo('https://github.com/me/blog');
    state({ team: { name: 'Backend', work_orgs: ['github.com/acme'] } });
    const out = newRepoCheck(input(join(r)), '/p/cli.js');
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('AskUserQuestion');
    expect(ctx).toContain('«Backend»');
    expect(ctx).toContain(`skill «standup-agent:standup», args «repos set '${r}=work'»`);
    expect(ctx).toContain(`args «repos set '${r}=personal'»`);
    expect(readState().repos_asked?.[r]).toBeDefined();
    expect(newRepoCheck(input(r), '/p/cli.js')).toBeNull();
  });

  it('skips marked repos and non-git dirs', () => {
    const r = repo();
    state({ team: {}, repos: { [r]: 'personal' } });
    expect(newRepoCheck(input(r), '/p/cli.js')).toBeNull();
    expect(newRepoCheck(input(tmp()), '/p/cli.js')).toBeNull();
  });

  it('quotes paths with spaces and quotes for the shell', () => {
    expect(sq("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

describe('state file stays readable JSON', () => {
  it('after set and ask', async () => {
    const r = repo();
    state({ team: {} });
    newRepoCheck({ session_id: 's', cwd: r }, 'x');
    await reposCommand(['set', `${r}=work`], 'x', NOW);
    expect(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))).toMatchObject({ repos: { [r]: 'work' } });
  });
});
