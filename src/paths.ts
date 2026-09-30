import { homedir } from 'node:os';
import { join } from 'node:path';

/** Plugin data dir. Survives plugin updates, wiped on uninstall. */
export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'plugins', 'data', 'standup-agent-dev');
}

export const paths = {
  state: () => join(dataDir(), 'state.json'),
  auth: () => join(dataDir(), 'auth.json'),
  digests: () => join(dataDir(), 'digests'),
  queue: () => join(dataDir(), 'queue'),
  logDir: () => join(dataDir(), 'log'),
};
