import { spawn } from 'node:child_process';
import type { HookInput } from '../hookio.js';

/**
 * SessionEnd gets ~1.5 s and a `timeout` in hooks.json does not extend it (checked 30.09.2026).
 * So the hook only hands the work to a detached worker and returns at once.
 */
export function sessionEnd(input: HookInput, cliPath: string): void {
  const job = JSON.stringify({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    reason: input.reason,
  });
  spawn(process.execPath, [cliPath, 'capture', job], { detached: true, stdio: 'ignore' }).unref();
}
