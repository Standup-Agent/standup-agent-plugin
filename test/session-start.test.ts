import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findMissedSessions, projectDirName, sessionStart } from '../src/hooks/session-start.js';
import { tmp } from './helpers.js';

let data: string;
let projects: string;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const H = 3_600_000;

beforeEach(() => {
  data = tmp();
  projects = join(tmp(), 'projects');
  process.env.CLAUDE_PLUGIN_DATA = data;
});

const state = (s: unknown) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify(s));
};
const transcript = (projectPath: string, sid: string, mtime: number, sub = '') => {
  const dir = join(projects, projectDirName(projectPath), sub);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, '{}\n');
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
};
const input = (sid = 'current') => ({ session_id: sid, transcript_path: join(projects, '-x', `${sid}.jsonl`), source: 'startup' });

describe('projectDirName', () => {
  it('matches Claude Code naming', () => {
    expect(projectDirName('/work/acme/billing-api')).toBe('-work-acme-billing-api');
    expect(projectDirName('/Users/dev/my.repo_x')).toBe('-Users-dev-my-repo-x');
  });
});

describe('findMissedSessions', () => {
  it('does nothing without work repos', () => {
    state({ repos: { '/w/blog': 'personal' } });
    transcript('/w/blog', 'a', NOW - H);
    expect(findMissedSessions(input(), NOW)).toEqual([]);
  });

  it('finds uncaptured and changed-since-capture transcripts of work repos only', () => {
    state({
      repos: { '/w/api': 'work', '/w/blog': 'personal' },
      captures: { done: NOW - 2 * H, changed: NOW - 3 * H },
    });
    const missed = transcript('/w/api', 'missed', NOW - 1 * H);
    transcript('/w/api', 'done', NOW - 2 * H);
    const changed = transcript('/w/api', 'changed', NOW - 1.5 * H);
    const sub = transcript('/w/api/services/web', 'sub', NOW - 0.5 * H);
    transcript('/w/api', 'current', NOW);
    transcript('/w/api', 'ancient', NOW - 30 * 24 * H);
    transcript('/w/blog', 'personal', NOW - H);
    transcript('/w/other', 'other', NOW - H);
    transcript('/w/api', 'agent-1', NOW - H, join('missed', 'subagents'));

    const jobs = findMissedSessions(input('current'), NOW);
    expect(jobs).toEqual([
      { session_id: 'sub', transcript_path: sub, reason: 'recover' },
      { session_id: 'missed', transcript_path: missed, reason: 'recover' },
      { session_id: 'changed', transcript_path: changed, reason: 'recover' },
    ]);
  });

  it('caps the number of sessions per run, newest first', () => {
    state({ repos: { '/w/api': 'work' } });
    for (let i = 0; i < 60; i++) transcript('/w/api', `s${i}`, NOW - (i + 1) * 60_000);
    const jobs = findMissedSessions(input(), NOW);
    expect(jobs).toHaveLength(50);
    expect(jobs[0]!.session_id).toBe('s0');
  });

  it('falls back to CLAUDE_CONFIG_DIR/projects without a transcript path', () => {
    const cfg = tmp();
    projects = join(cfg, 'projects');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      state({ repos: { '/w/api': 'work' } });
      transcript('/w/api', 'a', NOW - H);
      expect(findMissedSessions({ session_id: 'x' }, NOW).map((j) => j.session_id)).toEqual(['a']);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('missing projects dir and broken state are fine', () => {
    state({ repos: { '/w/api': 'work' } });
    expect(findMissedSessions({ session_id: 'x', transcript_path: '/nope/p/x.jsonl' }, NOW)).toEqual([]);
    writeFileSync(join(data, 'state.json'), '{broken');
    expect(findMissedSessions(input(), NOW)).toEqual([]);
  });
});

describe('sessionStart', () => {
  it('returns null and never throws', () => {
    state({ repos: { '/w/api': 'work' } });
    expect(sessionStart(input(), '/nonexistent/cli.js')).toBeNull();
  });
});
