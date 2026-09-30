import { log } from '../log.js';

export interface CaptureJob {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  reason?: string;
}

/** Runs detached after SessionEnd. Task 1: transcript + git → local digest store. */
export async function runCapture(job: CaptureJob): Promise<void> {
  log('info', 'capture: not implemented yet', { session: job.session_id.slice(0, 8), reason: job.reason });
}
