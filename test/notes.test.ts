import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flush } from '../src/api.js';
import { leave, privacyUrl } from '../src/commands/team.js';
import { standupCheck } from '../src/hooks/session-start.js';
import { standupCommand } from '../src/standup/commands.js';
import { readNotes } from '../src/standup/notes.js';
import { localDate } from '../src/standup/schedule.js';
import { readState } from '../src/state.js';
import { git, makeRepo, tmp } from './helpers.js';

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
    return readdirSync(join(data, 'queue')).sort().map((f) => JSON.parse(readFileSync(join(data, 'queue', f), 'utf8')));
  } catch {
    return [];
  }
};
/** A work repo on a ticket branch; the real path, as `git rev-parse --show-toplevel` prints it. */
const workRepo = () => {
  const repo = realpathSync(makeRepo());
  git(repo, ['checkout', '-q', '-b', 'feature/PAY-42']);
  return repo;
};
const cmd = (args: string[], now: Date, cwd = tmp()) => standupCommand(args, ROOT, now, cwd);
const sendJson = JSON.stringify({ text: 'PAY-42: webhooks', items: [{ ticket: 'PAY-42', branch: 'feature/PAY-42', done: 'webhooks', why: null, next: null }], blockers: [] });

describe('notes (card 2a)', () => {
  it('a note in a work repo gets the branch and ticket; secrets are masked before it is written', async () => {
    const repo = workRepo();
    state({ repos: { [repo]: 'work' } });
    const r = await cmd(['note', 'add', 'call with design: banner moves to Friday, password=hunter2hunter2'], at(9), repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('(PAY-42)');
    expect(r.out).toContain('1 secret(s) were masked');
    const [n] = readNotes();
    expect(n).toMatchObject({ repo_path: repo, branch: 'feature/PAY-42', ticket: 'PAY-42' });
    expect(n!.text).not.toContain('hunter2');
    expect(readFileSync(join(data, 'notes.jsonl'), 'utf8')).not.toContain('hunter2');
  });

  it('a note outside work repos keeps only the text: personal repos stay out even locally', async () => {
    const repo = workRepo();
    state({ repos: { [repo]: 'personal' } });
    await cmd(['note', 'add', 'reviewed PR for OPS-7'], at(9), repo);
    const [n] = readNotes();
    expect(n).toMatchObject({ text: 'reviewed PR for OPS-7', ticket: 'OPS-7' });
    expect(n!.repo).toBeUndefined();
    expect(n!.branch).toBeUndefined();
    expect(readFileSync(join(data, 'notes.jsonl'), 'utf8')).not.toContain(repo);
  });

  it('list and rm by number; empty and huge notes are refused', async () => {
    await cmd(['note', 'add', 'one'], at(9));
    await cmd(['note', 'add', 'two'], at(9));
    await cmd(['note', 'add', 'three'], at(9));
    expect(JSON.parse((await cmd(['note', 'list'], at(9))).out).notes.map((n: { n: number; text: string }) => `${n.n}:${n.text}`)).toEqual(['1:one', '2:two', '3:three']);
    expect((await cmd(['note', 'rm', '1', '3'], at(9))).out).toContain('Deleted: 2');
    expect(readNotes().map((n) => n.text)).toEqual(['two']);
    expect((await cmd(['note', 'rm', '9'], at(9))).code).toBe(1);
    expect((await cmd(['note', 'add', '  '], at(9))).code).toBe(1);
    expect((await cmd(['note', 'add', 'x'.repeat(2001)], at(9))).code).toBe(1);
  });

  it('a note alone is work: the standup is announced', async () => {
    const repo = workRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(9))).toBeNull();
    await cmd(['note', 'add', 'call with the client about refunds'], at(9, 29), repo);
    expect(standupCheck({ session_id: 's', source: 'startup' }, at(10))?.systemMessage).toBe('📋 Your standup is ready');
  });

  it('notes go into the materials; sending clears them, a note written while it was shown stays', async () => {
    const repo = workRepo();
    state({ repos: { [repo]: 'work' }, last_checkin: at(8, 29).toISOString() });
    await cmd(['note', 'add', 'call with design: banner moves to Friday'], at(18, 29), repo);
    await cmd(['note', 'add', 'tomorrow start with the refund flow'], at(19, 29));
    const p = await cmd(['prepare'], at(9));
    expect(p.out).toMatch(/branch: feature\/PAY-42 · ticket: PAY-42[\s\S]*developer_notes:\n- \S+ \[PAY-42\] call with design: banner moves to Friday/);
    expect(p.out).toContain('## developer_notes without a branch\n- ');
    expect(p.out).toContain('tomorrow start with the refund flow');
    expect(p.out).not.toContain('No work found');

    await cmd(['note', 'add', 'written while the standup was shown'], at(9, 30));
    await cmd(['send', sendJson], at(9, 30));
    expect(readNotes().map((n) => n.text)).toEqual(['written while the standup was shown']);
  });

  it('«Not now» keeps the notes', async () => {
    state({ last_checkin: at(8, 29).toISOString() });
    await cmd(['note', 'add', 'keep me'], at(8));
    await cmd(['prepare'], at(9));
    await cmd(['snooze'], at(9));
    expect(readNotes()).toHaveLength(1);
  });
});

describe('addendum to a sent standup (card 2a)', () => {
  it('status says whether today is sent; an addendum before sending is refused', async () => {
    state({ last_checkin: at(8, 29).toISOString() });
    expect(JSON.parse((await cmd(['status'], at(9))).out)).toEqual({ joined: false, sent_today: false, notes: 0 });
    expect((await cmd(['addendum', '{"text":"x"}'], at(9))).code).toBe(1);
    await cmd(['prepare'], at(9));
    await cmd(['send', sendJson], at(9));
    expect(JSON.parse((await cmd(['status'], at(10))).out).sent_today).toBe(true);
    // The next day it can't be added to any more.
    expect(JSON.parse((await cmd(['status'], at(10, 31))).out).sent_today).toBe(false);
    // A skipped day is not a sent one.
    state({ standup: { done_date: localDate(at(9)) } });
    expect(JSON.parse((await cmd(['status'], at(10))).out).sent_today).toBe(false);
  });

  it('queues the addendum for today’s report after it, with the amended event', async () => {
    state({ last_checkin: at(8, 29).toISOString() });
    await cmd(['prepare'], at(9));
    await cmd(['send', sendJson], at(9));
    const reportId = readState().standup!.sent_report_id!;
    const r = await cmd(['addendum', JSON.stringify({ text: 'design call: banner moves to Friday', ticket: 'PAY-42' })], at(15));
    expect(r.code).toBe(0);
    const items = queue();
    const add = items.find((q) => q.kind === 'addendum');
    expect(add).toMatchObject({ report_id: reportId, body: { text: 'design call: banner moves to Friday', ticket: 'PAY-42' } });
    expect(add.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(items.filter((q) => q.kind === 'event').map((q) => q.body.type)).toEqual(['shown', 'sent', 'amended']);
    expect(items.findIndex((q) => q.kind === 'report')).toBeLessThan(items.findIndex((q) => q.kind === 'addendum'));
    expect((await cmd(['addendum', 'not json'], at(15))).code).toBe(1);
  });

  describe('delivery', () => {
    let server: Server;
    const hits: string[] = [];
    beforeEach(async () => {
      hits.length = 0;
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          hits.push(`${req.method} ${req.url}`);
          res.statusCode = req.url?.endsWith('/addendum') || req.url === '/reports' ? 201 : 204;
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

    it('posts the report, then the addendum to /reports/<id>/addendum', async () => {
      state({ last_checkin: at(8, 29).toISOString() });
      await cmd(['prepare'], at(9));
      await cmd(['send', sendJson], at(9));
      const id = readState().standup!.sent_report_id!;
      await cmd(['addendum', '{"text":"later"}'], at(15));
      writeFileSync(join(data, 'auth.json'), JSON.stringify({ member_token: 't', member_id: 'm', api_base: 'unused' }));
      expect((await flush(at(15).getTime())).left).toBe(0);
      expect(hits).toEqual(['POST /events', 'POST /reports', 'POST /events', `POST /reports/${id}/addendum`, 'POST /events']);
    });
  });
});

describe('privacy (card 4b)', () => {
  it('join-info points to the privacy policy on the invite host', () => {
    expect(privacyUrl('https://standupagent.co/api')).toBe('https://standupagent.co/privacy');
    expect(privacyUrl('http://localhost:8080/api/')).toBe('http://localhost:8080/privacy');
  });

  it('leave deletes the notes', async () => {
    await cmd(['note', 'add', 'x'], at(9));
    await leave();
    expect(readNotes()).toEqual([]);
  });
});
