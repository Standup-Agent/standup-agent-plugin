import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { branchKey, cleanupExpired, rawPath, repoKey, writeRaw, type RawCapture } from '../src/store.js';
import { tmp } from './helpers.js';

let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});

const NOW = new Date('2026-09-30T12:00:00Z');
const capture = (over: Partial<RawCapture> = {}): RawCapture => ({
  schema: 1,
  session_id: '55397f84-3193-4c52-a7ce-0ebd8f1be03a',
  repo: { path: '/work/acme/billing-api', name: 'billing-api' },
  branch: 'feature/PAY-42-webhooks',
  captured_at: NOW.toISOString(),
  period: { from: '2026-09-30T10:00:00Z', to: '2026-09-30T11:00:00Z' },
  messages: [{ role: 'user', text: 'hi' }],
  truncated: { dropped: 0, cut: 0 },
  commits: [],
  files: [],
  tickets: ['PAY-42'],
  redacted: {},
  ...over,
});

describe('store keys', () => {
  it('repo dir is readable and unique per path', () => {
    expect(repoKey('/work/acme/billing-api')).toMatch(/^billing-api-[0-9a-f]{8}$/);
    expect(repoKey('/work/acme/billing-api')).not.toBe(repoKey('/other/billing-api'));
    expect(repoKey('/w/my repo!')).toMatch(/^my_repo_-[0-9a-f]{8}$/);
  });

  it('branch dir is a single safe path segment and reversible', () => {
    for (const b of ['feature/PAY-42-webhooks', 'main', 'a/b/c', '..', 'x*y', 'фича/тест']) {
      const k = branchKey(b);
      expect(k).not.toContain('/');
      expect(k).not.toBe('..');
      expect(decodeURIComponent(k)).toBe(b);
    }
  });

  it('raw path layout', () => {
    expect(rawPath('/work/acme/billing-api', 'feature/PAY-42', 'abc')).toBe(
      join(data, 'digests', repoKey('/work/acme/billing-api'), 'feature%2FPAY-42', 'raw', 'abc.json'),
    );
  });
});

describe('writeRaw', () => {
  it('writes JSON atomically with mtime = session end', () => {
    const file = writeRaw(capture(), NOW);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(capture());
    expect(statSync(file).mtime.toISOString()).toBe('2026-09-30T11:00:00.000Z');
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('overwrites the same session on re-capture', () => {
    writeRaw(capture(), NOW);
    const file = writeRaw(capture({ messages: [{ role: 'user', text: 'second' }] }), NOW);
    expect(readdirSync(join(file, '..'))).toEqual(['55397f84-3193-4c52-a7ce-0ebd8f1be03a.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).messages[0].text).toBe('second');
  });

  it('removes raw captures past the TTL on write, and their empty dirs', () => {
    const old = writeRaw(capture({ session_id: 'old', branch: 'gone', period: { from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' } }), new Date('2026-08-01T12:00:00Z'));
    const edge = writeRaw(capture({ session_id: 'edge', period: { from: '2026-09-01T10:00:00Z', to: '2026-09-01T12:00:01Z' } }), NOW);
    expect(existsSync(old)).toBe(false); // 60 days old at NOW
    expect(existsSync(join(old, '..', '..'))).toBe(false); // branch dir removed
    expect(existsSync(edge)).toBe(true); // 29.99 days old
  });

  it('keeps a branch dir that has a synthesized digest', () => {
    const file = writeRaw(capture({ period: { from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' } }), new Date('2026-08-01T12:00:00Z'));
    const branchDir = join(file, '..', '..');
    writeFileSync(join(branchDir, 'digest.md'), '# digest');
    cleanupExpired(NOW);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(branchDir, 'digest.md'))).toBe(true);
  });

  it('cleans up stale temp files from a killed write', () => {
    const dir = join(data, 'digests', 'r', 'b', 'raw');
    mkdirSync(dir, { recursive: true });
    const tmpFile = join(dir, '.x.json.1.2.tmp');
    writeFileSync(tmpFile, '{');
    const t = new Date(NOW.getTime() - 2 * 3_600_000);
    utimesSync(tmpFile, t, t);
    cleanupExpired(NOW);
    expect(existsSync(tmpFile)).toBe(false);
  });

  it('cleanup on a missing store is a no-op', () => {
    expect(cleanupExpired(NOW)).toBe(0);
  });
});
