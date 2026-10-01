/**
 * Fitting a conversation into a size budget without losing its middle.
 *
 * A turn is a developer prompt and everything Claude wrote until the next prompt. Priority:
 *   1. every developer prompt (the task and every change of direction);
 *   2. Claude's last text in each turn (usually the result: «done X, because Y»);
 *   3. Claude's intermediate texts, newest first, while room is left.
 * Tiers 1–2 share one per-message cap, lowered until they fit: a long session gets thinner
 * everywhere instead of losing its middle. Used by capture (bytes) and by materials (chars).
 */

export interface BudgetMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface Measure {
  size: (text: string) => number;
  /** Cut to at most `max` units, marking the cut. */
  cut: (text: string, max: number) => string;
}

export interface Fitted<T> {
  kept: T[];
  /** Index in the input of each kept message. */
  indices: number[];
  /** Messages left out entirely. */
  dropped: number;
  /** Messages shortened to the cap. */
  cut: number;
}

export function fitTurns<T extends BudgetMessage>(messages: T[], max: number, m: Measure, minCap: number): Fitted<T> {
  const sizes = messages.map((x) => m.size(x.text));
  if (sizes.reduce((n, s) => n + s, 0) <= max) return { kept: messages, indices: messages.map((_, i) => i), dropped: 0, cut: 0 };

  const essential = messages.map((x, i) => x.role === 'user' || messages[i + 1]?.role !== 'assistant');
  const ess = sizes.filter((_, i) => essential[i]);
  const cost = (cap: number) => ess.reduce((n, s) => n + Math.min(s, cap), 0);

  const keep = new Map<number, number>(); // index → cap
  let used = 0;
  if (cost(minCap) <= max) {
    // Largest cap at which all prompts and turn results fit.
    let lo = minCap;
    let hi = Math.max(minCap, ...ess);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (cost(mid) <= max) lo = mid;
      else hi = mid - 1;
    }
    messages.forEach((_, i) => {
      if (essential[i]) {
        keep.set(i, lo);
        used += Math.min(sizes[i]!, lo);
      }
    });
    for (let i = messages.length - 1; i >= 0; i--) {
      if (keep.has(i)) continue;
      const s = Math.min(sizes[i]!, lo);
      if (used + s > max) continue;
      keep.set(i, lo);
      used += s;
    }
  } else {
    // Even the essentials don't fit at the minimum cap: the first prompt and the newest ones.
    const first = messages.findIndex((x) => x.role === 'user');
    if (first >= 0) {
      keep.set(first, minCap);
      used += Math.min(sizes[first]!, minCap);
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (keep.has(i) || !essential[i]) continue;
      const s = Math.min(sizes[i]!, minCap);
      if (used + s > max) break;
      keep.set(i, minCap);
      used += s;
    }
  }

  const kept: T[] = [];
  const indices: number[] = [];
  let cut = 0;
  messages.forEach((x, i) => {
    const cap = keep.get(i);
    if (cap === undefined) return;
    indices.push(i);
    if (sizes[i]! > cap) {
      kept.push({ ...x, text: m.cut(x.text, cap) });
      cut++;
    } else kept.push(x);
  });
  return { kept, indices, dropped: messages.length - kept.length, cut };
}
