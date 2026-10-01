import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueEvent, flush } from '../src/api.js';
import { standupCheck } from '../src/hooks/session-start.js';
import { standupCommand, buildReport } from '../src/standup/commands.js';
import { devLanguage, outsideCommits, render, type Materials } from '../src/standup/materials.js';
import { gate, localDate, periodFrom } from '../src/standup/schedule.js';
import { readState } from '../src/state.js';
import { readDigest, repoKey, writeRaw, type RawCapture } from '../src/store.js';
import { commit, makeRepo, tmp } from './helpers.js';

const ROOT = join(__dirname, '..', 'plugin');
let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});
const state = (s: unknown) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify(s));
};
const at = (h: number, day = 30) => new Date(2026, 8, day, h, 0, 0); // local time
const queue = () => {
  try {
    return readdirSync(join(data, 'queue')).map((f) => JSON.parse(readFileSync(join(data, 'queue', f), 'utf8')));
  } catch {
    return [];
  }
};
const capture = (repo: string, branch: string, to: Date, extra: Partial<RawCapture> = {}): RawCapture => {
  const c: RawCapture = {
    schema: 1, session_id: `s-${Math.random()}`, repo: { path: repo, name: 'api' }, branch, captured_at: to.toISOString(),
    period: { from: new Date(to.getTime() - 3_600_000).toISOString(), to: to.toISOString() }, messages: [{ role: 'user', text: 'fix PAY-42' }, { role: 'assistant', text: 'done' }],
    truncated: { dropped: 0, cut: 0 }, commits: [], files: ['a.ts'], tickets: ['PAY-42'], redacted: {}, ...extra,
  };
  writeRaw(c, to);
  return c;
};

describe('gate', () => {
  it('waits until 6:00 local', () => expect(gate({}, at(5))).toBe('early'));
  it('shows once a day after send/skip', () => {
    expect(gate({ standup: { done_date: localDate(at(9)) } }, at(15))).toBe('done_today');
    expect(gate({ standup: { done_date: localDate(at(9, 29)) } }, at(9))).toBe('ok');
  });
  it('respects snooze and another terminal showing it', () => {
    expect(gate({ standup: { snooze_until: at(11).toISOString() } }, at(10))).toBe('snoozed');
    expect(gate({ standup: { snooze_until: at(11).toISOString() } }, at(12))).toBe('ok');
    expect(gate({ standup: { showing_until: at(10).toISOString() } }, at(9))).toBe('showing');
  });
  it('period starts at last_checkin, or 3 days back before the first standup', () => {
    expect(periodFrom({ last_checkin: '2026-09-29T08:00:00.000Z' }, at(9)).toISOString()).toBe('2026-09-29T08:00:00.000Z');
    expect(periodFrom({}, at(9)).getTime()).toBe(at(9).getTime() - 3 * 86_400_000);
  });
});

describe('standupCheck (SessionStart)', () => {
  it('announces the standup when there is work since last_checkin', () => {
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    capture(repo, 'feature/PAY-42', at(18, 29));
    const out = standupCheck({ session_id: 's', source: 'startup' }, at(9));
    expect(out?.systemMessage).toBe('📋 Стендап готов');
    expect(out?.hookSpecificOutput?.additionalContext).toContain('standup-agent:standup');
  });

  it('counts commits made outside Claude Code as work', () => {
    const repo = makeRepo();
    commit(repo, 'x.ts', 'PAY-7 manual fix', at(18, 29).toISOString());
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(9))).not.toBeNull();
  });

  it('no work → no standup and one no_work event per day', () => {
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8).toISOString() });
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(9))).toBeNull();
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(10))).toBeNull();
    expect(queue().map((q) => q.body.type)).toEqual(['no_work']);
  });

  it('stays silent without work repos, before 6:00 and on compaction', () => {
    state({});
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(9))).toBeNull();
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' } });
    capture(repo, 'main', at(4));
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(5))).toBeNull();
    expect(standupCheck({ session_id: 's', source: 'compact' }, at(9))).toBeNull();
    expect(queue()).toEqual([]);
  });
});

describe('standup commands', () => {
  it('prepare → send: report period from prepare, last_checkin moves, day is done', async () => {
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    capture(repo, 'feature/PAY-42', at(18, 29));
    const p = await standupCommand(['prepare'], ROOT, at(9));
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/## repo: api · repo_id: \S+-[0-9a-f]{8} · branch: feature\/PAY-42 · ticket: PAY-42/);
    expect(p.out).toContain('prompt_version: standup-v1');
    expect(p.out).toContain('existing_digest:\n(empty)');
    expect(p.out).toContain('dev_language: English');
    expect(readState().standup?.showing_until).toBeDefined();

    const json = JSON.stringify({ text: 'PAY-42 — webhooks\n  Сделано: verify', items: [{ ticket: 'PAY-42', branch: 'feature/PAY-42', done: 'verify', why: null, next: 'tests' }], blockers: [] });
    const s = await standupCommand(['send', json], ROOT, at(9, 30));
    expect(s.out).toContain('вступишь в команду'); // no token yet
    const st = readState();
    expect(st.last_checkin).toBe(at(9).toISOString());
    expect(st.standup).toEqual({ done_date: localDate(at(9, 30)) });
    const report = queue().find((q) => q.kind === 'report')!.body;
    expect(report).toMatchObject({ date: localDate(at(9, 30)), period: { from: at(8, 29).toISOString(), to: at(9).toISOString() }, prompt_version: 'standup-v1', blockers: [] });
    expect(queue().filter((q) => q.kind === 'event').map((q) => q.body.type)).toEqual(['shown', 'sent']);
  });

  it('send rejects broken input without touching state', async () => {
    state({ last_checkin: 'x' });
    expect((await standupCommand(['send', 'not json'], ROOT, at(9))).code).toBe(1);
    expect((await standupCommand(['send', '{"text":"t","items":[{"ticket":"A-1"}]}'], ROOT, at(9))).code).toBe(1);
    expect(readState()).toEqual({ last_checkin: 'x' });
    expect(queue()).toEqual([]);
  });

  it('first «Не сейчас» snoozes 2 h, second skips the day without moving last_checkin', async () => {
    state({ last_checkin: at(8, 29).toISOString() });
    expect((await standupCommand(['snooze'], ROOT, at(9))).out).toContain('2 ч');
    expect(readState().standup?.snooze_until).toBe(at(11).toISOString());
    expect((await standupCommand(['snooze'], ROOT, at(11, 30))).out).toContain('Пропускаем');
    expect(readState().standup).toEqual({ done_date: localDate(at(11)) });
    expect(readState().last_checkin).toBe(at(8, 29).toISOString());
    expect(queue().map((q) => q.body.type)).toEqual(['snoozed', 'skipped']);
  });

  it('snooze count resets the next day', async () => {
    state({ standup: { snooze_date: localDate(at(9, 29)), snoozes: 1 } });
    expect((await standupCommand(['snooze'], ROOT, at(9))).out).toContain('2 ч');
  });

  it('prepare splits big materials into parts that fit the Bash output limit', async () => {
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    for (let i = 0; i < 6; i++) capture(repo, `b${i}`, at(10 + i, 29), { messages: [{ role: 'user', text: 'задача ' + 'ж'.repeat(20_000) }, { role: 'assistant', text: 'итог' }] });
    const p1 = await standupCommand(['prepare'], ROOT, at(9));
    const m = /\[Часть 1 из (\d+)/.exec(p1.out);
    expect(Number(m?.[1])).toBeGreaterThan(1);
    const n = Number(m![1]);
    // Cyrillic is 2 bytes a char: the limit that matters is bytes (30 KB), with room for the part header.
    expect(Buffer.byteLength(p1.out as string, 'utf8')).toBeLessThanOrEqual(24_200);
    for (let i = 2; i <= n; i++) {
      const pi = await standupCommand(['prepare', '--part', String(i)], ROOT, at(9));
      expect(pi.code).toBe(0);
      expect(Buffer.byteLength(pi.out as string, 'utf8')).toBeLessThanOrEqual(24_200);
    }
    expect((await standupCommand(['prepare', '--part', String(n + 1)], ROOT, at(9))).code).toBe(1);
  });
});

describe('materials', () => {
  it('keeps the first user message and the end of a long session', () => {
    const m: Materials = {
      from: 'a', to: 'b', outside: [],
      captures: [{
        schema: 1, session_id: 's', repo: { path: '/r', name: 'api' }, branch: 'main', captured_at: 'x', period: { from: '2026-09-30T08:00', to: '2026-09-30T09:00' },
        messages: [{ role: 'user', text: 'ЗАДАЧА' }, ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant' as const, text: `шаг ${i} ` + 'y'.repeat(200) })), { role: 'assistant', text: 'ИТОГ' }],
        truncated: { dropped: 0, cut: 0 }, commits: [], files: [], tickets: [], redacted: {},
      }],
    };
    const out = render(m, { version: 'v', text: 'p' }, 3_000).join('');
    expect(out).toContain('> developer: ЗАДАЧА');
    expect(out).toContain('< claude: ИТОГ');
    expect(out).toContain('… (part of the conversation omitted)');
    expect(out).not.toContain('шаг 0 ');
  });

  it('finds the author’s commits not already captured', () => {
    const repo = makeRepo();
    const known = commit(repo, 'a.ts', 'PAY-1 in session', at(10, 29).toISOString());
    commit(repo, 'b.ts', 'PAY-2 manual', at(11, 29).toISOString());
    commit(repo, 'c.ts', 'teammate', at(12, 29).toISOString(), { name: 'Bob', email: 'bob@example.com' });
    const got = outsideCommits([repo], at(8, 29), new Set([known]));
    expect(got.map((c) => c.message)).toEqual(['PAY-2 manual']);
    expect(got[0]!.branch).toBe('main');
  });
});

describe('branch digests (prompt step A)', () => {
  it('save-digests stores under repo_id and the next prepare shows them as existing_digest', async () => {
    const repo = makeRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    capture(repo, 'feature/PAY-42', at(18, 29));
    const id = repoKey(repo);
    const digests = JSON.stringify([{ repo: id, branch: 'feature/PAY-42', digest: 'Goal: webhooks\nDone: verify' }, { repo: '../etc', branch: 'x', digest: 'nope' }]);
    const r = await standupCommand(['save-digests', digests], ROOT, at(9));
    expect(r.out).toContain('Сохранено дайджестов: 1');
    expect(r.out).toContain('пропущено');
    expect(readDigest(id, 'feature/PAY-42')).toBe('Goal: webhooks\nDone: verify\n');
    const p = await standupCommand(['prepare'], ROOT, at(9));
    expect(p.out).toContain('existing_digest:\nGoal: webhooks\nDone: verify');
  });

  it('rejects input that is not an array', async () => {
    expect((await standupCommand(['save-digests', '{"repo":"x"}'], ROOT, at(9))).code).toBe(1);
    expect((await standupCommand(['save-digests', 'oops'], ROOT, at(9))).code).toBe(1);
  });

  it('commits outside sessions get their own branch block with a repo_id', () => {
    const out = render({ from: 'a', to: 'b', captures: [], outside: [{ repo: 'api', repoPath: '/w/api', branch: 'main', sha: 'abcdef1234', ts: '2026-09-30T10:00', message: 'PAY-7 manual fix' }] }, { version: 'v', text: 'p' }).join('');
    expect(out).toContain(`## repo: api · repo_id: ${repoKey('/w/api')} · branch: main`);
    expect(out).toContain('commits_outside_sessions:\n- 2026-09-30T10:00 abcdef1 PAY-7 manual fix');
  });
});

describe('devLanguage', () => {
  const cap = (text: string) => ({ messages: [{ role: 'user', text }, { role: 'assistant', text: 'english reply here' }] }) as unknown as RawCapture;
  it('follows what the developer types, not Claude', () => {
    expect(devLanguage([cap('почини вебхуки в PAY-42')])).toBe('Russian');
    expect(devLanguage([cap('fix the webhook retries')])).toBe('English');
    expect(devLanguage([])).toBe('English');
  });
});

describe('buildReport', () => {
  const pending = { from: 'f', to: 't', prompt_version: 'v1' };
  it('normalizes items and drops empty blockers', () => {
    const r = buildReport({ text: ' t ', items: [{ done: 'x', ticket: '', why: 'w' }], blockers: ['', 'нет доступа'] }, pending, at(9));
    expect(r).toMatchObject({ text: 't', items: [{ ticket: null, branch: null, done: 'x', why: 'w', next: null }], blockers: ['нет доступа'], period: { from: 'f', to: 't' } });
  });
});

describe('queue flush', () => {
  let server: Server;
  let hits: { url: string; auth?: string; body: unknown }[];
  let status: number;
  beforeEach(async () => {
    hits = [];
    status = 201;
    server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(b || 'null') });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.STANDUP_AGENT_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server.close();
    delete process.env.STANDUP_AGENT_API_URL;
  });

  it('waits without a token, then sends in order with the bearer token', async () => {
    enqueueEvent('shown', at(9));
    enqueueEvent('sent', at(9, 30));
    expect(await flush()).toMatchObject({ sent: 0, left: 2, stopped: 'no_token' });
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ member_token: 'tok' }));
    expect(await flush()).toMatchObject({ sent: 2, left: 0 });
    expect(hits.map((h) => [h.url, h.auth, (h.body as { type: string }).type])).toEqual([
      ['/events', 'Bearer tok', 'shown'],
      ['/events', 'Bearer tok', 'sent'],
    ]);
  });

  it('keeps items on 5xx and 401, drops them on other 4xx', async () => {
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ member_token: 'tok' }));
    enqueueEvent('shown');
    status = 503;
    expect(await flush()).toMatchObject({ left: 1, stopped: 'network' });
    status = 401;
    expect(await flush()).toMatchObject({ left: 1, stopped: 'auth' });
    status = 400;
    expect(await flush()).toMatchObject({ sent: 0, left: 0 });
  });

  it('drops items older than two weeks', async () => {
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ member_token: 'tok' }));
    const f = enqueueEvent('shown');
    const old = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(f, old, old);
    expect(await flush()).toMatchObject({ sent: 0, left: 0 });
    expect(hits).toEqual([]);
  });
});
