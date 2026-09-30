/**
 * `join-info <link>` / `join <link> <name> <email>` / `leave` — run by Claude through Bash from the
 * standup skill. The server comes from the invite link's host, so any deployment works without setup.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { apiBaseUrl, memberToken, type Auth } from '../api.js';
import { DEFAULT_API_BASE, NET } from '../config.js';
import { writeFileAtomic } from '../fsutil.js';
import { suggestIdentity } from '../identity.js';
import { log } from '../log.js';
import { dataDir, paths } from '../paths.js';
import { readState, updateState } from '../state.js';

export interface Invite {
  code: string;
  apiBase: string;
}

/** `https://host/join/CODE`, `host/join/CODE`, or a bare CODE (default server). */
export function parseInvite(link: string): Invite | null {
  const s = link.trim().replace(/[.,;!?»")\]]+$/, '');
  const m = /^(?:(https?):\/\/)?([a-z0-9.-]+(?::\d+)?)\/join\/([A-Za-z0-9]{10,})$/i.exec(s);
  if (m) {
    const scheme = m[1] ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(m[2]!) ? 'http' : 'https');
    return { code: m[3]!.toUpperCase(), apiBase: `${scheme}://${m[2]}/api` };
  }
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return { code: s.toUpperCase(), apiBase: process.env.STANDUP_AGENT_API_URL ?? DEFAULT_API_BASE };
  return null;
}

type Out = { code: number; out: unknown };

async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(NET.timeoutMs) });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, body };
  } catch {
    return null;
  }
}

export async function joinInfo(link: string): Promise<Out> {
  const inv = parseInvite(link);
  if (!inv) return { code: 1, out: { error: 'Не похоже на инвайт-ссылку Standup Agent (…/join/<CODE>).' } };
  const r = await request(`${inv.apiBase}/invites/${inv.code}`);
  if (!r) return { code: 1, out: { error: `Сервер ${inv.apiBase} недоступен. Проверь сеть и попробуй ещё раз.` } };
  if (r.status === 404) return { code: 1, out: { error: 'Ссылка неверная или её отозвали — попроси у менеджера новую.' } };
  if (r.status !== 200) return { code: 1, out: { error: `Сервер ответил ${r.status}.` } };
  const current = readState().team?.name ?? null;
  return {
    code: 0,
    out: {
      team_name: r.body.team_name,
      suggested: suggestIdentity(),
      // MVP: one team per developer; joining another one leaves the current.
      current_team: current,
      leaves_current_team: current !== null && current !== r.body.team_name,
    },
  };
}

export async function joinTeam(link: string, name: string, email: string, now = new Date()): Promise<Out> {
  const inv = parseInvite(link);
  if (!inv) return { code: 1, out: { error: 'Не похоже на инвайт-ссылку Standup Agent.' } };
  if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) return { code: 1, out: { error: 'Нужны имя и email.' } };
  const r = await request(`${inv.apiBase}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: inv.code, display_name: name.trim(), email: email.trim() }),
  });
  if (!r) return { code: 1, out: { error: 'Сервер недоступен. Попробуй ещё раз.' } };
  if (r.status === 404) return { code: 1, out: { error: 'Ссылка неверная или её отозвали — попроси у менеджера новую.' } };
  if (r.status === 429) return { code: 1, out: { error: 'Слишком много попыток — подожди минуту.' } };
  if (r.status !== 200 || typeof r.body.member_token !== 'string') return { code: 1, out: { error: `Сервер ответил ${r.status}.` } };

  const auth: Auth = { member_token: r.body.member_token, member_id: String(r.body.member_id), api_base: inv.apiBase };
  writeFileAtomic(paths.auth(), JSON.stringify(auth));
  const workOrgs = Array.isArray(r.body.work_orgs) ? (r.body.work_orgs as unknown[]).filter((o): o is string => typeof o === 'string') : [];
  updateState((s) => {
    // Another team: its repo questions and today's standup state don't carry over.
    if (s.team?.name && s.team.name !== r.body.team_name) {
      s.repos_asked = {};
      s.standup = {};
    }
    s.team = { name: String(r.body.team_name), work_orgs: workOrgs, joined_at: now.toISOString() };
  });
  log('info', 'team: joined');
  return { code: 0, out: { team_name: r.body.team_name, work_orgs: workOrgs, next: 'Теперь первичная разметка репо: repos scan.' } };
}

/** `/standup leave`: delete this member on the server, then everything local. */
export async function leave(): Promise<Out> {
  const token = memberToken();
  if (token) {
    const r = await request(`${apiBaseUrl()}/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    // 401: already removed by the manager — local cleanup is still right.
    if (!r || (r.status !== 204 && r.status !== 401)) {
      return { code: 1, out: { error: 'Сервер недоступен — данные на сервере не удалены. Попробуй позже, локально ничего не трогал.' } };
    }
  }
  for (const p of [paths.auth(), paths.digests(), paths.queue(), paths.promptCache(), join(dataDir(), 'standup-materials.json'), paths.state()]) {
    rmSync(p, { recursive: true, force: true });
  }
  log('info', 'team: left');
  return { code: 0, out: { left: true, note: 'Ты вышел из команды. Твои стендапы удалены на сервере, локальные материалы и разметка репо — на этом компьютере.' } };
}
