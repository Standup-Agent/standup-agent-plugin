import { homedir } from 'node:os';
import { join } from 'node:path';

/** Plugin data dir. Survives plugin updates, wiped on uninstall. */
export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'plugins', 'data', 'standup-agent-dev');
}

/** Claude Code config dir (`CLAUDE_CONFIG_DIR` moves it). Transcripts live in its `projects/`. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export const paths = {
  state: () => join(dataDir(), 'state.json'),
  auth: () => join(dataDir(), 'auth.json'),
  digests: () => join(dataDir(), 'digests'),
  queue: () => join(dataDir(), 'queue'),
  promptCache: () => join(dataDir(), 'prompt-cache.json'),
  logDir: () => join(dataDir(), 'log'),
  claudeProjects: () => join(claudeDir(), 'projects'),
};
