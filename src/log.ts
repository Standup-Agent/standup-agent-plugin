import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

/** Append-only local log. Never write transcript text, tokens or emails here. */
export function log(level: 'info' | 'error', msg: string, extra?: Record<string, unknown>): void {
  try {
    mkdirSync(paths.logDir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
    appendFileSync(join(paths.logDir(), 'plugin.log'), line + '\n');
  } catch {
    // Logging must never break a hook.
  }
}
