import { existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isWorkRepo, readState, recordCapture, updateState, workRepos } from '../src/state.js';
import { tmp } from './helpers.js';

let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});
const writeState = (s: unknown) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), typeof s === 'string' ? s : JSON.stringify(s));
};

describe('state', () => {
  it('missing or corrupt state.json reads as empty', () => {
    expect(readState()).toEqual({});
    writeState('{oops');
    expect(readState()).toEqual({});
    writeState('[1,2]');
    expect(readState()).toEqual({});
  });

  it('isWorkRepo: only explicitly work repos', () => {
    writeState({ repos: { '/w/api': 'work', '/w/blog': 'personal' } });
    expect(isWorkRepo('/w/api')).toBe(true);
    expect(isWorkRepo('/w/blog')).toBe(false);
    expect(isWorkRepo('/w/unmarked')).toBe(false);
    expect(isWorkRepo('/w/api/')).toBe(false);
    expect(workRepos()).toEqual(['/w/api']);
  });

  it('isWorkRepo is false for a garbage marking', () => {
    writeState({ repos: { '/w/api': 'WORK' } });
    expect(isWorkRepo('/w/api')).toBe(false);
  });

  it('updateState keeps fields owned by other tasks and leaves no lock behind', () => {
    writeState({ repos: { '/w/api': 'work' }, last_checkin: '2026-09-29', member: { name: 'x' } });
    updateState((s) => {
      s.last_capture_at = 'now';
    });
    expect(readState()).toEqual({ repos: { '/w/api': 'work' }, last_checkin: '2026-09-29', member: { name: 'x' }, last_capture_at: 'now' });
    expect(existsSync(join(data, 'state.json.lock'))).toBe(false);
  });

  it('updateState breaks a stale lock', () => {
    writeState({});
    const lock = join(data, 'state.json.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const t0 = Date.now();
    updateState((s) => {
      s.x = 1;
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(readState().x).toBe(1);
  });

  it('recordCapture stores the transcript mtime and prunes old entries', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    writeState({ captures: { ancient: now.getTime() - 30 * 86_400_000, recent: now.getTime() - 86_400_000 } });
    recordCapture('s1', now.getTime() - 1000, now);
    const s = readState();
    expect(s.captures).toEqual({ recent: now.getTime() - 86_400_000, s1: now.getTime() - 1000 });
    expect(s.last_capture_at).toBe('2026-09-30T12:00:00.000Z');
    expect(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).captures.s1).toBe(now.getTime() - 1000);
  });
});
