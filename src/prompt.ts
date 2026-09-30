import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJSON } from './api.js';
import { NET } from './config.js';
import { writeFileAtomic } from './fsutil.js';
import { paths } from './paths.js';

export interface Prompt {
  version: string;
  text: string;
}

/**
 * Standup synthesis prompt: `GET /prompts/standup`, cached for a day; the copy shipped with the
 * plugin when the server is unreachable or we haven't joined yet.
 */
export async function standupPrompt(pluginRoot: string, now = Date.now()): Promise<Prompt> {
  const cached = readCache();
  if (cached && now - cached.fetched_at < NET.promptCacheHours * 3_600_000) return cached;
  const fresh = await getJSON<Prompt>('/prompts/standup');
  if (fresh && typeof fresh.version === 'string' && typeof fresh.text === 'string') {
    writeFileAtomic(paths.promptCache(), JSON.stringify({ ...fresh, fetched_at: now }));
    return fresh;
  }
  return cached ?? fallback(pluginRoot);
}

export function fallback(pluginRoot: string): Prompt {
  const raw = readFileSync(join(pluginRoot, 'prompts', 'standup.fallback.md'), 'utf8');
  const m = /^<!--\s*version:\s*(\S+)\s*-->\s*\n/.exec(raw);
  return { version: m?.[1] ?? 'fallback', text: m ? raw.slice(m[0].length) : raw };
}

function readCache(): (Prompt & { fetched_at: number }) | null {
  try {
    const c = JSON.parse(readFileSync(paths.promptCache(), 'utf8')) as Prompt & { fetched_at: number };
    return typeof c.text === 'string' && typeof c.version === 'string' && typeof c.fetched_at === 'number' ? c : null;
  } catch {
    return null;
  }
}
