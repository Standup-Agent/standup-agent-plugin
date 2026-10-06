import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiBaseUrl } from '../src/api.js';
import { joinInfo, joinTeam, leave, parseInvite } from '../src/commands/team.js';
import { readState } from '../src/state.js';
import { tmp } from './helpers.js';

describe('parseInvite', () => {
  it.each([
    ['https://standupagent.co/join/K7X2M9QPLA', 'K7X2M9QPLA', 'https://standupagent.co/api'],
    ['standupagent.co/join/k7x2m9qpla.', 'K7X2M9QPLA', 'https://standupagent.co/api'],
    ['https://abc.trycloudflare.com/join/K7X2M9QPLA»', 'K7X2M9QPLA', 'https://abc.trycloudflare.com/api'],
    ['127.0.0.1:8080/join/K7X2M9QPLA', 'K7X2M9QPLA', 'http://127.0.0.1:8080/api'],
    ['K7X2M9QPLA', 'K7X2M9QPLA', 'https://standupagent.co/api'],
  ])('%s', (link, code, apiBase) => expect(parseInvite(link)).toEqual({ code, apiBase }));

  it.each(['https://evil.com/other/K7X2M9QPLA', 'SHORT', 'standupagent.co/join/'])('rejects %s', (link) => expect(parseInvite(link)).toBeNull());
});

describe('join / leave against a server', () => {
  let server: Server;
  let base: string;
  let data: string;
  let deleted = 0;
  beforeEach(async () => {
    data = tmp();
    process.env.CLAUDE_PLUGIN_DATA = data;
    deleted = 0;
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/invites/GOODCODE123') return res.end(JSON.stringify({ team_name: 'Backend' }));
      if (req.url === '/api/join' && req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        return req.on('end', () => {
          const body = JSON.parse(b);
          if (body.code !== 'GOODCODE123') return (res.statusCode = 404), res.end('{}');
          res.end(JSON.stringify({ member_id: 'm1', member_token: 'sam_tok', team_name: 'Backend', work_orgs: ['github.com/acme'] }));
        });
      }
      if (req.url === '/api/me' && req.method === 'DELETE' && req.headers.authorization === 'Bearer sam_tok') {
        deleted++;
        return (res.statusCode = 204), res.end();
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server.close();
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('join-info shows the team and warns about leaving another one', async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'state.json'), JSON.stringify({ team: { name: 'Frontend' } }));
    const r = await joinInfo(`${base}/join/goodcode123`);
    expect(r.out).toMatchObject({ team_name: 'Backend', current_team: 'Frontend', leaves_current_team: true });
    expect((await joinInfo(`${base}/join/BADCODE1234`)).code).toBe(1);
  });

  it('join stores the token and the server from the link; the next team resets per-team state', async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'state.json'), JSON.stringify({ team: { name: 'Frontend' }, repos_asked: { '/r': 'x' }, standup: { done_date: 'd' }, repos: { '/r': 'work' } }));
    const r = await joinTeam(`http://${base}/join/GOODCODE123`, 'Петя', 'petya@acme.io');
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(data, 'auth.json'), 'utf8'))).toEqual({ member_token: 'sam_tok', member_id: 'm1', api_base: `http://${base}/api` });
    expect(apiBaseUrl()).toBe(`http://${base}/api`);
    const s = readState();
    expect(s.team).toMatchObject({ name: 'Backend', work_orgs: ['github.com/acme'] });
    expect(s.repos_asked).toEqual({});
    expect(s.standup).toEqual({});
    expect(s.repos).toEqual({ '/r': 'work' }); // repo marking is the developer's, it stays
    expect((await joinTeam(`http://${base}/join/GOODCODE123`, 'Петя', 'not-an-email')).code).toBe(1);
  });

  it('leave deletes on the server first, then everything local', async () => {
    await joinTeam(`http://${base}/join/GOODCODE123`, 'Петя', 'petya@acme.io');
    const r = await leave();
    expect(r.code).toBe(0);
    expect(deleted).toBe(1);
    expect(existsSync(join(data, 'auth.json'))).toBe(false);
    expect(existsSync(join(data, 'state.json'))).toBe(false);
  });

  it('leave keeps local data when the server is unreachable', async () => {
    await joinTeam(`http://${base}/join/GOODCODE123`, 'Петя', 'petya@acme.io');
    server.close();
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ member_token: 'sam_tok', member_id: 'm1', api_base: 'http://127.0.0.1:1/api' }));
    expect((await leave()).code).toBe(1);
    expect(existsSync(join(data, 'auth.json'))).toBe(true);
  });
});
