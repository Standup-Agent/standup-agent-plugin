/**
 * When to show the standup (card 2): not sent or skipped today, not snoozed, not being shown in
 * another terminal, local time ≥ 6:00, and there is work since last_checkin.
 */
import { DEFAULTS } from '../config.js';
import type { State } from '../state.js';

/** Developer's local calendar date, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start of the next standup: the last sent one, or a few days back before the first one. */
export function periodFrom(state: State, now: Date): Date {
  const last = state.last_checkin ? new Date(state.last_checkin) : null;
  return last && !Number.isNaN(last.getTime()) ? last : new Date(now.getTime() - DEFAULTS.joinBackfillDays * 86_400_000);
}

export type Gate = 'ok' | 'early' | 'done_today' | 'snoozed' | 'showing';

/** Everything except «is there work» — that one costs file stats and maybe git. */
export function gate(state: State, now: Date): Gate {
  const s = state.standup ?? {};
  if (now.getHours() < DEFAULTS.showNotBeforeHour) return 'early';
  if (s.done_date === localDate(now)) return 'done_today';
  if (s.showing_until && Date.parse(s.showing_until) > now.getTime()) return 'showing';
  if (s.snooze_until && Date.parse(s.snooze_until) > now.getTime()) return 'snoozed';
  return 'ok';
}
