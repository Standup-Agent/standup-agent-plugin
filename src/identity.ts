/**
 * Name and email suggested at join, from git config (`user.name`, `user.email`). The developer
 * confirms or corrects them before joining; when git has none, Claude asks.
 */
import { execFileSync } from 'node:child_process';

export interface Identity {
  name: string | null;
  email: string | null;
  source: 'git' | 'none';
}

export function suggestIdentity(): Identity {
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
