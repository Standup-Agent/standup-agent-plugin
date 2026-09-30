import type { HookInput } from '../hookio.js';

/** Hook output understood by Claude Code; printed as JSON to stdout. */
export interface SessionStartOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'SessionStart'; additionalContext: string };
}

/**
 * Task 1: re-capture transcripts missed after a kill -9.
 * Task 2: decide whether to show today's standup.
 */
export function sessionStart(_input: HookInput): SessionStartOutput | null {
  return null;
}
