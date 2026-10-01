import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/capture/git.js';
import { projectDirName } from '../src/hooks/session-start.js';
import { commit, git, makeRepo, rawFile, tmp, tx, writeTranscript } from './helpers.js';

// The real hooks, bundled the same way as plugin/dist/cli.js, run as child processes.
let cli: string;
beforeAll(() => {
  cli = join(tmp(), 'cli.js');
  buildSync({
    entryPoints: [join(__dirname, '..', 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: cli,
    logLevel: 'silent',
  });
});

const T = (m: number) => `2026-09-30T10:${String(m).padStart(2, '0')}:00.000Z`;

/** Waits for a session's raw file on a branch; returns its path or ''. */
async function waitForRaw(root: string, branch: string, sid: string, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = rawFile(root, branch, sid);
    if (f) return f;
    await new Promise((r) => setTimeout(r, 50));
  }
  return '';
}

function setup() {
  const data = tmp();
  const repo = makeRepo('feature/PAY-42-webhooks');
  commit(repo, 'a.ts', 'PAY-42: start', T(5));
  const root = repoRoot(repo)!;
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify({ repos: { [root]: 'work' } }));
  const projects = join(tmp(), 'projects');
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  const run = (cmd: string, input: object) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cli, cmd], { input: JSON.stringify(input), env, encoding: 'utf8' });
    return { ...r, ms: Date.now() - t0 };
  };
  const transcriptFor = (sid: string) =>
    writeTranscript(join(projects, projectDirName(root), `${sid}.jsonl`), [tx.prompt('do PAY-42', T(1)), tx.assistant([tx.text('done')], T(2))], {
      cwd: root,
      sessionId: sid,
      gitBranch: 'feature/PAY-42-webhooks',
    });
  return { data, root, projects, run, transcriptFor, repo };
}

describe('hooks end to end', () => {
  it('SessionEnd returns at once and the detached worker writes the capture', async () => {
    const s = setup();
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
    const path = s.transcriptFor(sid);
    const r = s.run('session-end', { session_id: sid, transcript_path: path, cwd: s.root, reason: 'prompt_input_exit', hook_event_name: 'SessionEnd' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(1000); // SessionEnd budget is ~1.5 s
    process.env.CLAUDE_PLUGIN_DATA = s.data;
    const file = await waitForRaw(s.root, 'feature/PAY-42-webhooks', sid);
    expect(file).not.toBe('');
    expect(JSON.parse(readFileSync(file, 'utf8')).messages).toHaveLength(2);
  });

  it('SessionStart recovers a session whose SessionEnd never came (kill -9)', async () => {
    const s = setup();
    const killed = 'bbbbbbbb-0000-0000-0000-000000000002';
    s.transcriptFor(killed);
    const current = 'cccccccc-0000-0000-0000-000000000003';
    const r = s.run('session-start', {
      session_id: current,
      transcript_path: join(s.projects, projectDirName(s.root), `${current}.jsonl`),
      cwd: s.root,
      source: 'startup',
      hook_event_name: 'SessionStart',
    });
    expect(r.status).toBe(0);
    // The hook may also announce the standup (the repo has fresh commits); whatever it prints is hook JSON.
    if (r.stdout !== '') expect(JSON.parse(r.stdout)).toBeTypeOf('object');
    process.env.CLAUDE_PLUGIN_DATA = s.data;
    const file = await waitForRaw(s.root, 'feature/PAY-42-webhooks', killed);
    expect(file).not.toBe('');
    expect(JSON.parse(readFileSync(file, 'utf8')).reason).toBe('recover');

    // Captured now: the next SessionStart does not pick it up again.
    const again = s.run('session-start', { session_id: 'dddddddd', transcript_path: join(s.projects, 'x', 'dddddddd.jsonl') });
    expect(again.status).toBe(0);
    expect(readFileSync(join(s.data, 'log', 'plugin.log'), 'utf8').match(/recovering missed sessions/g)).toHaveLength(1);
  });

  it('bad stdin still exits 0 and logs', () => {
    const s = setup();
    for (const cmd of ['session-start', 'session-end']) {
      const r = spawnSync(process.execPath, [cli, cmd], { input: 'garbage', env: { ...process.env, CLAUDE_PLUGIN_DATA: s.data } });
      expect(r.status).toBe(0);
    }
    expect(readFileSync(join(s.data, 'log', 'plugin.log'), 'utf8')).toContain('command failed');
  });

  it('a personal repo leaves no trace in the store', async () => {
    const s = setup();
    writeFileSync(join(s.data, 'state.json'), JSON.stringify({ repos: { [s.root]: 'personal' } }));
    const sid = 'eeeeeeee-0000-0000-0000-000000000005';
    const path = s.transcriptFor(sid);
    s.run('session-end', { session_id: sid, transcript_path: path, cwd: s.root, reason: 'other' });
    const log = join(s.data, 'log', 'plugin.log');
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(existsSync(log) && readFileSync(log, 'utf8').includes('not marked as work'))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readFileSync(log, 'utf8')).toContain('not marked as work');
    expect(existsSync(join(s.data, 'digests'))).toBe(false);
    git(s.repo, ['status']); // repo untouched and usable
  });
});
