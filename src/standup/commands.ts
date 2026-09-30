/**
 * `standup prepare [--part N] | send '<json>' | snooze | event <type>` — run by Claude through
 * Bash from the standup skill and the synthesis subagent. Output is for Claude to read.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueEvent, enqueueReport, flush, type EventType, type Report, type ReportItem } from '../api.js';
import { DEFAULTS } from '../config.js';
import { writeFileAtomic } from '../fsutil.js';
import { log } from '../log.js';
import { dataDir } from '../paths.js';
import { standupPrompt } from '../prompt.js';
import { readState, updateState, workRepos } from '../state.js';
import { collect, render } from './materials.js';
import { localDate, periodFrom } from './schedule.js';

const H = 3_600_000;
const partsFile = () => join(dataDir(), 'standup-materials.json');

export async function standupCommand(args: string[], pluginRoot: string, now = new Date()): Promise<{ code: number; out: string }> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'prepare':
      return prepare(rest, pluginRoot, now);
    case 'send':
      return send(rest.join(' '), now);
    case 'snooze':
      return snooze(now);
    case 'event': {
      const type = rest[0] as EventType;
      if (!['edited', 'blocker'].includes(type)) return { code: 1, out: 'usage: standup event edited|blocker' };
      enqueueEvent(type, now);
      return { code: 0, out: 'ok' };
    }
    default:
      return { code: 1, out: "usage: standup prepare [--part N] | send '<json>' | snooze | event edited|blocker" };
  }
}

/**
 * Part 1 collects materials since last_checkin, remembers the period, marks the standup as being
 * shown (other terminals wait) and snoozes it until an answer comes; later parts come from the snapshot.
 */
async function prepare(args: string[], pluginRoot: string, now: Date): Promise<{ code: number; out: string }> {
  const partArg = args.indexOf('--part');
  const part = partArg >= 0 ? Number(args[partArg + 1]) : 1;
  if (!Number.isInteger(part) || part < 1) return { code: 1, out: 'usage: standup prepare [--part N]' };

  let parts: string[];
  if (part === 1) {
    const state = readState();
    const from = periodFrom(state, now);
    const prompt = await standupPrompt(pluginRoot, now.getTime());
    parts = render(collect(from, now, workRepos(state)), prompt);
    writeFileAtomic(partsFile(), JSON.stringify(parts));
    updateState((s) => {
      s.standup = {
        ...s.standup,
        pending: { from: from.toISOString(), to: now.toISOString(), prompt_version: prompt.version },
        showing_until: new Date(now.getTime() + DEFAULTS.showLockMinutes * 60_000).toISOString(),
        // No answer (the user went straight to an emergency) = ask again later, like «Не сейчас».
        snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString(),
      };
    });
    enqueueEvent('shown', now);
  } else {
    try {
      parts = JSON.parse(readFileSync(partsFile(), 'utf8')) as string[];
    } catch {
      return { code: 1, out: 'Нет подготовленных материалов: сначала выполни standup prepare без --part.' };
    }
  }
  if (part > parts.length) return { code: 1, out: `Частей всего ${parts.length}.` };
  const header = parts.length > 1 ? `[Часть ${part} из ${parts.length}${part < parts.length ? ` — следующая: standup prepare --part ${part + 1}` : ''}]\n` : '';
  return { code: 0, out: header + parts[part - 1] };
}

interface SendInput {
  text?: unknown;
  items?: unknown;
  blockers?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Validate what Claude passes; the period and prompt version come from `prepare`, not from Claude. */
export function buildReport(input: SendInput, pending: { from: string; to: string; prompt_version: string }, now: Date): Report | string {
  const text = str(input.text);
  if (!text) return 'нужен text — стендап ровно в том виде, в каком его увидел разработчик';
  if (!Array.isArray(input.items)) return 'нужен items: [{ticket, branch, done, why, next}]';
  const items: ReportItem[] = [];
  for (const raw of input.items as unknown[]) {
    const i = (raw ?? {}) as Record<string, unknown>;
    const done = str(i.done);
    if (!done) return 'у каждого элемента items нужно поле done';
    items.push({ ticket: str(i.ticket), branch: str(i.branch), done, why: str(i.why), next: str(i.next) });
  }
  const blockers = Array.isArray(input.blockers) ? input.blockers.map(str).filter((b): b is string => b !== null) : [];
  return { id: randomUUID(), date: localDate(now), period: { from: pending.from, to: pending.to }, items, blockers, text, prompt_version: pending.prompt_version };
}

async function send(json: string, now: Date): Promise<{ code: number; out: string }> {
  let input: SendInput;
  try {
    input = JSON.parse(json) as SendInput;
  } catch {
    return { code: 1, out: 'Аргумент должен быть JSON {text, items, blockers} в одинарных кавычках (апостроф внутри замени на ’).' };
  }
  const state = readState();
  const pending = state.standup?.pending ?? { from: periodFrom(state, now).toISOString(), to: now.toISOString(), prompt_version: 'unknown' };
  const report = buildReport(input, pending, now);
  if (typeof report === 'string') return { code: 1, out: report };

  enqueueReport(report);
  enqueueEvent('sent', now);
  // Confirmed and queued = sent from the developer's side: the next standup starts after this period
  // even if the network is down now; the queue delivers it later.
  updateState((s) => {
    s.last_checkin = report.period.to;
    s.standup = { done_date: localDate(now) };
  });
  const r = await flush(now.getTime());
  log('info', 'standup: sent', { items: report.items.length, blockers: report.blockers.length, delivered: r.left === 0, stopped: r.stopped });
  if (r.left === 0) return { code: 0, out: 'Отправлено менеджеру.' };
  if (r.stopped === 'no_token') return { code: 0, out: 'Сохранено. Уйдёт менеджеру, как только ты вступишь в команду.' };
  return { code: 0, out: 'Сохранено, но сервер сейчас недоступен — отправится автоматически при следующем запуске Claude Code.' };
}

/** First «Не сейчас» today: again in 2 hours. Second: skip the day, last_checkin stays. */
function snooze(now: Date): { code: number; out: string } {
  const today = localDate(now);
  let skipped = false;
  updateState((s) => {
    const st = s.standup ?? {};
    const snoozes = (st.snooze_date === today ? st.snoozes ?? 0 : 0) + 1;
    skipped = snoozes >= 2;
    s.standup = skipped
      ? { done_date: today }
      : { ...st, snooze_date: today, snoozes, snooze_until: new Date(now.getTime() + DEFAULTS.snoozeHours * H).toISOString(), showing_until: undefined, pending: undefined };
  });
  enqueueEvent(skipped ? 'skipped' : 'snoozed', now);
  return skipped
    ? { code: 0, out: 'Пропускаем сегодня. Работа за сегодня войдёт в завтрашний стендап.' }
    : { code: 0, out: `Хорошо, напомню не раньше чем через ${DEFAULTS.snoozeHours} ч.` };
}
