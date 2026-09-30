/**
 * Name and email suggested at join. From ~/.claude.json only `oauthAccount.displayName` and
 * `emailAddress` are read — the file holds tokens, so it is never logged or copied. Fallback: git.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Identity {
  name: string | null;
  email: string | null;
  source: 'claude' | 'git' | 'none';
}

export function suggestIdentity(): Identity {
  const file = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
  try {
    const acc = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: { displayName?: unknown; emailAddress?: unknown } }).oauthAccount;
    const name = typeof acc?.displayName === 'string' ? acc.displayName : null;
    const email = typeof acc?.emailAddress === 'string' ? acc.emailAddress : null;
    if (name || email) return { name, email, source: 'claude' };
  } catch {
    // no file or not JSON
  }
  const git = (key: string) => {
    try {
      return execFileSync('git', ['config', '--global', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
    } catch {
      return null;
    }
  };
  const name = git('user.name');
  const email = git('user.email');
  return { name, email, source: name || email ? 'git' : 'none' };
}
