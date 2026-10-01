/**
 * Everything that leaves the machine goes through here: confirmed standups and text-less events.
 * Each item is written to the local queue first, then sent; failures stay queued and are retried
 * by `flush` on the next session start. Without a member_token (not joined yet) items just wait.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_API_BASE, NET } from './config.js';
import { writeFileAtomic } from './fsutil.js';
import { log } from './log.js';
import { paths } from './paths.js';

export type EventType = 'shown' | 'sent' | 'edited' | 'blocker' | 'snoozed' | 'skipped' | 'no_work';

export interface ReportItem {
  ticket: string | null;
  branch: string | null;
  done: string;
  why: string | null;
  next: string | null;
}

export interface Report {
  id: string;
  date: string;
  period: { from: string; to: string };
  items: ReportItem[];
  blockers: string[];
  text: string;
  prompt_version: string;
}

type QueueItem = { kind: 'report'; body: Report } | { kind: 'event'; body: { type: EventType; ts: string } };

/** auth.json: written at join. Never logged or copied. */
export interface Auth {
  member_token: string;
  member_id: string;
  /** Server the invite came from, e.g. https://standupagent.co/api. */
  api_base: string;
}

export function readAuth(): Partial<Auth> {
  try {
    return JSON.parse(readFileSync(paths.auth(), 'utf8')) as Partial<Auth>;
  } catch {
    return {};
  }
}

export function memberToken(): string | null {
  const t = readAuth().member_token;
  return typeof t === 'string' && t !== '' ? t : null;
}

/** STANDUP_AGENT_API_URL (tests, staging) → the server we joined → the default. */
export function apiBaseUrl(): string {
  return process.env.STANDUP_AGENT_API_URL ?? readAuth().api_base ?? DEFAULT_API_BASE;
}

/** Queue a report; returns its queue file. The report id makes a retry idempotent on the server. */
export function enqueueReport(report: Report): string {
  return enqueue({ kind: 'report', body: report });
}

export function enqueueEvent(type: EventType, now = new Date()): string {
  return enqueue({ kind: 'event', body: { type, ts: now.toISOString() } });
}

let seq = 0;

function enqueue(item: QueueItem): string {
  // Sortable name: send in the order things happened (the counter orders items made in the same ms).
  const file = join(paths.queue(), `${Date.now().toString().padStart(15, '0')}-${String(seq++).padStart(6, '0')}-${item.kind}-${randomUUID()}.json`);
  writeFileAtomic(file, JSON.stringify(item));
  return file;
}

export interface FlushResult {
  sent: number;
  left: number;
  /** Why sending stopped early, if it did. */
  stopped?: 'no_token' | 'network' | 'auth';
}

/** Send queued items in order. Stops at the first network/auth failure; a 4xx other than 401 drops the item. */
export async function flush(now = Date.now()): Promise<FlushResult> {
  const files = queued();
  const res: FlushResult = { sent: 0, left: files.length };
  if (files.length === 0) return res;
  const token = memberToken();
  if (!token) return { ...res, stopped: 'no_token' };

  for (const file of files) {
    let item: QueueItem;
    try {
      if (now - statSync(file).mtimeMs > NET.queueMaxAgeDays * 86_400_000) {
        rmSync(file, { force: true });
        res.left--;
        log('info', 'queue: dropped stale item');
        continue;
      }
      item = JSON.parse(readFileSync(file, 'utf8')) as QueueItem;
    } catch {
      rmSync(file, { force: true });
      res.left--;
      continue;
    }
    const status = await post(item.kind === 'report' ? '/reports' : '/events', item.body, token);
    if (status === null) return { ...res, stopped: 'network' };
    if (status === 401) return { ...res, stopped: 'auth' };
    if (status >= 500) return { ...res, stopped: 'network' };
    // 2xx, or a 4xx the server will never accept: either way this item is done.
    if (status >= 400) log('error', 'queue: item rejected', { kind: item.kind, status });
    rmSync(file, { force: true });
    res.left--;
    if (status < 400) res.sent++;
  }
  return res;
}

function queued(): string[] {
  try {
    return readdirSync(paths.queue())
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort()
      .map((f) => join(paths.queue(), f));
  } catch {
    return [];
  }
}

/** HTTP status, or null when the server couldn't be reached. */
async function post(path: string, body: unknown, token: string): Promise<number | null> {
  try {
    const r = await fetch(apiBaseUrl() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NET.timeoutMs),
    });
    return r.status;
  } catch {
    return null;
  }
}

/** GET with the member token; parsed JSON or null. */
export async function getJSON<T>(path: string): Promise<T | null> {
  const token = memberToken();
  if (!token) return null;
  try {
    const r = await fetch(apiBaseUrl() + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(NET.timeoutMs) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
