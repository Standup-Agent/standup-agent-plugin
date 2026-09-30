import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Write via a temp file in the same dir + rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Synchronous sleep for short lock waits in hooks/workers (no event loop needed). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
