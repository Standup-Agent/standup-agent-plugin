import { runCapture, type CaptureJob } from './capture/worker.js';
import { reposCommand } from './commands/repos.js';
import { parseHookInput, readStdin } from './hookio.js';
import { sessionEnd } from './hooks/session-end.js';
import { sessionStart } from './hooks/session-start.js';
import { log } from './log.js';

/**
 * Single entry point: `node dist/cli.js <command>`.
 * Hooks always exit 0 — a broken standup must never break the user's session.
 */
export async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  const cliPath = process.argv[1] ?? __filename;
  try {
    switch (command) {
      case 'session-start': {
        const out = sessionStart(parseHookInput(await readStdin()), cliPath);
        if (out) process.stdout.write(JSON.stringify(out));
        return 0;
      }
      case 'session-end':
        sessionEnd(parseHookInput(await readStdin()), cliPath);
        return 0;
      case 'capture':
        await runCapture(JSON.parse(arg ?? '{}') as CaptureJob | CaptureJob[]);
        return 0;
      case 'repos': {
        // Run by Claude, not a hook: a non-zero code tells it the call went wrong.
        const { code, out } = await reposCommand(argv.slice(1), cliPath);
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return code;
      }
      default:
        log('error', 'unknown command', { command });
        return 0;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('error', 'command failed', { command, error });
    if (command === 'repos') {
      process.stdout.write(JSON.stringify({ error }) + '\n');
      return 1;
    }
    return 0;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
