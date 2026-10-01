import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fitTurns, type BudgetMessage } from '../src/capture/budget.js';
import { runCapture } from '../src/capture/worker.js';
import { BYTES } from '../src/capture/transcript.js';
import { reposCommand } from '../src/commands/repos.js';
import { DEFAULTS } from '../src/config.js';
import { newRepoCheck } from '../src/hooks/session-start.js';
import { render, type Materials } from '../src/standup/materials.js';
import { readState, type State } from '../src/state.js';
import { rawPath, type RawCapture } from '../src/store.js';
import { commit, makeRepo, rawFile, rawFiles, tmp, tx, writeTranscript } from './helpers.js';

const SID = '99999999-2222-3333-4444-555555555555';
const T = (h: number, m = 0, day = 30) => `2026-09-${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});

const state = (s: State) => {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), JSON.stringify(s));
};
const storeText = (): string => {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(readFileSync(join(d, e.name), 'utf8')));
  };
  walk(join(data, 'digests'));
  return out.join('\n');
};
const read = (f: string): RawCapture => JSON.parse(readFileSync(f, 'utf8'));
const repo = () => {
  const r = realpathSync(makeRepo('main'));
  commit(r, 'README.md', 'init', T(8));
  return r;
};

describe('a session that moves between repos', () => {
  it('keeps each work repo apart, drops personal and unmarked ones, remembers the unmarked', async () => {
    const work = repo();
    const work2 = repo();
    const unmarked = repo();
    const personal = repo();
    commit(work2, 'mail.ts', 'Mail through SendGrid', T(11, 10));
    state({ repos: { [work]: 'work', [work2]: 'work', [personal]: 'personal' } });

    const t = writeTranscript(
      join(tmp(), 'projects', 'p', `${SID}.jsonl`),
      [
        tx.prompt('task in the docs repo', T(10), { cwd: work }),
        tx.assistant([tx.text('docs updated')], T(10, 5), { cwd: work }),
        tx.prompt('now switch the mail provider', T(11), { cwd: work2 }),
        tx.assistant([tx.text('mail goes through SendGrid')], T(11, 20), { cwd: work2 }),
        tx.prompt('PERSONAL-SECRET-PLAN', T(12), { cwd: personal }),
        tx.assistant([tx.text('personal reply')], T(12, 1), { cwd: personal }),
        tx.prompt('UNMARKED-TEXT', T(13), { cwd: unmarked }),
        tx.assistant([tx.text('unmarked reply')], T(13, 1), { cwd: unmarked }),
      ],
      { sessionId: SID, gitBranch: 'main' },
    );
    // SessionEnd sees the last cwd: an unmarked repo. The work parts must still be captured.
    await runCapture({ session_id: SID, transcript_path: t, cwd: unmarked, reason: 'prompt_input_exit' });

    expect(read(rawFile(work, 'main', SID)).messages.map((m) => m.text)).toEqual(['task in the docs repo', 'docs updated']);
    const mail = read(rawFile(work2, 'main', SID));
    expect(mail.messages.map((m) => m.text)).toEqual(['now switch the mail provider', 'mail goes through SendGrid']);
    expect(mail.commits.map((c) => c.message)).toEqual(['Mail through SendGrid']);

    const all = storeText();
    expect(all).not.toContain('PERSONAL-SECRET-PLAN');
    expect(all).not.toContain('personal reply');
    expect(all).not.toContain('UNMARKED-TEXT');

    const seen = readState().unmarked_seen ?? {};
    expect(Object.keys(seen)).toEqual([unmarked]);
    expect(seen[unmarked]!.sessions).toEqual({ [SID]: t });
  });

  it('marking a visited repo work captures the sessions that visited it', async () => {
    const work = repo();
    const later = repo();
    const t = writeTranscript(
      join(tmp(), 'projects', 'p', `${SID}.jsonl`),
      [tx.prompt('start', T(10), { cwd: work }), tx.prompt('LATER-WORK', T(11), { cwd: later }), tx.assistant([tx.text('done')], T(11, 1), { cwd: later })],
      { sessionId: SID, gitBranch: 'main' },
    );
    state({ repos: { [work]: 'work' }, captures: {} });
    await runCapture({ session_id: SID, transcript_path: t, cwd: later, reason: 'other' });
    expect(storeText()).not.toContain('LATER-WORK');

    const { out } = await reposCommand(['set', `${later}=work`], '/nonexistent/cli.js', Date.parse(T(12)));
    expect(out).toMatchObject({ backfill_sessions: 1 });
    expect(readState().unmarked_seen?.[later]).toBeUndefined();

    // What the spawned worker does with that job:
    await runCapture({ session_id: SID, transcript_path: t, reason: 'backfill' });
    expect(read(rawFile(later, 'main', SID)).messages.map((m) => m.text)).toEqual(['LATER-WORK', 'done']);
  });

  it('marking a repo personal forgets it was visited and drops its old captures on the next capture', async () => {
    const work = repo();
    const t = writeTranscript(join(tmp(), 'projects', 'p', `${SID}.jsonl`), [tx.prompt('WORK-TEXT', T(10), { cwd: work })], { sessionId: SID, gitBranch: 'main' });
    state({ repos: { [work]: 'work' } });
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    expect(storeText()).toContain('WORK-TEXT');

    await reposCommand(['set', `${work}=personal`], '/nonexistent/cli.js');
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    expect(storeText()).not.toContain('WORK-TEXT');
  });

  it('SessionStart asks about a repo an earlier session cd-ed into', () => {
    const work = repo();
    const visited = repo();
    state({ team: { name: 'Backend', work_orgs: [] }, repos: { [work]: 'work' }, unmarked_seen: { [visited]: { last_seen: T(10), sessions: { s1: '/t/s1.jsonl' } } } });
    const ctx = newRepoCheck({ session_id: 's', cwd: work }, '/p/cli.js')?.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('earlier Claude Code session');
    expect(ctx).toContain(`repos set '${visited}=work'`);
    expect(readState().repos_asked?.[visited]).toBeDefined();
    expect(newRepoCheck({ session_id: 's', cwd: work }, '/p/cli.js')).toBeNull();
  });
});

describe('long sessions', () => {
  it('a session over several days is split into one file per day', async () => {
    const work = repo();
    state({ repos: { [work]: 'work' } });
    const t = writeTranscript(
      join(tmp(), 'projects', 'p', `${SID}.jsonl`),
      [tx.prompt('day one', T(12, 0, 29)), tx.assistant([tx.text('one done')], T(12, 5, 29)), tx.prompt('day two', T(12, 0, 30)), tx.assistant([tx.text('two done')], T(12, 5, 30))],
      { sessionId: SID, gitBranch: 'main', cwd: work },
    );
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    const files = rawFiles(work, 'main', SID);
    expect(files.map((f) => read(f).messages.map((m) => m.text))).toEqual([['day one', 'one done'], ['day two', 'two done']]);
    expect(files.map((f) => read(f).segment)).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('a capture replaces the old single file of the session', async () => {
    const work = repo();
    state({ repos: { [work]: 'work' } });
    const legacy = rawPath(work, 'main', SID);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"old":true}');
    const t = writeTranscript(join(tmp(), 'projects', 'p', `${SID}.jsonl`), [tx.prompt('new', T(10))], { sessionId: SID, gitBranch: 'main', cwd: work });
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    expect(existsSync(legacy)).toBe(false);
    expect(rawFiles(work, 'main', SID)).toHaveLength(1);
  });

  it('every prompt and every turn result survive the budget; the middle is thinned, not dropped', async () => {
    const work = repo();
    state({ repos: { [work]: 'work' } });
    const entries = [];
    for (let i = 0; i < 60; i++) {
      entries.push(tx.prompt(`PROMPT-${i} ` + 'p'.repeat(300), T(9, i % 60)));
      for (let k = 0; k < 4; k++) entries.push(tx.assistant([tx.text(`step ${i}.${k} ` + 'x'.repeat(2000))], T(9, i % 60)));
      entries.push(tx.assistant([tx.text(`RESULT-${i} ` + 'r'.repeat(1500))], T(9, i % 60)));
    }
    const t = writeTranscript(join(tmp(), 'projects', 'p', `${SID}.jsonl`), entries, { sessionId: SID, gitBranch: 'main', cwd: work });
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    const raw = read(rawFile(work, 'main', SID));
    const text = raw.messages.map((m) => m.text).join('\n');
    expect(Buffer.byteLength(raw.messages.map((m) => m.text).join(''))).toBeLessThanOrEqual(DEFAULTS.rawMaxBytesPerSegment);
    for (let i = 0; i < 60; i++) {
      expect(text).toContain(`PROMPT-${i} `);
      expect(text).toContain(`RESULT-${i} `);
    }
    expect(raw.truncated.dropped).toBeGreaterThan(0);
  });

  it('keeps a compaction summary only while the session stayed in work repos', async () => {
    const work = repo();
    const personal = repo();
    state({ repos: { [work]: 'work', [personal]: 'personal' } });
    const summary = (text: string, ts: string) => tx.prompt(text, ts, { isCompactSummary: true, cwd: work });
    const t = writeTranscript(
      join(tmp(), 'projects', 'p', `${SID}.jsonl`),
      [
        tx.prompt('start', T(10), { cwd: work }),
        summary('SUMMARY-CLEAN of the work so far', T(11)),
        tx.prompt('look at my blog', T(12), { cwd: personal }),
        tx.prompt('back to work', T(13), { cwd: work }),
        summary('SUMMARY-TAINTED mentions the blog', T(14)),
      ],
      { sessionId: SID, gitBranch: 'main' },
    );
    await runCapture({ session_id: SID, transcript_path: t, reason: 'other' });
    const raw = read(rawFile(work, 'main', SID));
    expect(raw.compact_summaries?.map((s) => s.text)).toEqual(['SUMMARY-CLEAN of the work so far']);
    expect(storeText()).not.toContain('SUMMARY-TAINTED');
  });
});

describe('fitTurns', () => {
  const msgs = (n: number): BudgetMessage[] =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, text: `Q${i} ` + 'q'.repeat(100) },
      { role: 'assistant' as const, text: `mid${i} ` + 'm'.repeat(1000) },
      { role: 'assistant' as const, text: `A${i} ` + 'a'.repeat(1000) },
    ]).flat();

  it('leaves a conversation that fits untouched', () => {
    const m = msgs(2);
    expect(fitTurns(m, 1e6, BYTES, 200)).toMatchObject({ kept: m, dropped: 0, cut: 0 });
  });

  it('drops intermediate texts before shortening prompts and results', () => {
    const f = fitTurns(msgs(10), 10 * (105 + 1005), BYTES, 200);
    expect(f.kept.filter((x) => x.text.startsWith('mid'))).toHaveLength(0);
    expect(f.kept.filter((x) => x.role === 'user')).toHaveLength(10);
    expect(f.kept.filter((x) => /^A\d/.test(x.text))).toHaveLength(10);
    expect(f.cut).toBe(0);
  });

  it('shortens prompts and results evenly when they alone do not fit', () => {
    const f = fitTurns(msgs(10), 5_000, BYTES, 200);
    expect(f.kept).toHaveLength(20);
    expect(f.kept.reduce((n, x) => n + Buffer.byteLength(x.text), 0)).toBeLessThanOrEqual(5_000);
    expect(f.indices).toEqual(f.kept.map((_, k) => [0, 2][k % 2]! + 3 * Math.floor(k / 2)));
  });
});

describe('materials of a long day', () => {
  it('shows every prompt of a squeezed capture and the compaction summary', () => {
    const messages: RawCapture['messages'] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: 'user', text: `ЗАПРОС-${i}` });
      messages.push({ role: 'assistant', text: 'ход '.repeat(300) });
      messages.push({ role: 'assistant', text: `ИТОГ-${i} ` + 'и'.repeat(400) });
    }
    const m: Materials = {
      from: 'a', to: 'b', outside: [],
      captures: [{
        schema: 1, session_id: 's', repo: { path: '/r', name: 'api' }, branch: 'main', captured_at: 'x', period: { from: '2026-09-30T08:00', to: '2026-09-30T18:00' },
        messages, compact_summaries: [{ ts: '2026-09-30T12:00:00Z', text: 'СВОДКА-КОМПАКЦИИ' }],
        truncated: { dropped: 0, cut: 0 }, commits: [], files: [], tickets: [], redacted: {},
      }],
    };
    const out = render(m, { version: 'v', text: 'p' }, 12_000).join('');
    expect(out).toContain('СВОДКА-КОМПАКЦИИ');
    for (let i = 0; i < 40; i++) {
      expect(out).toContain(`ЗАПРОС-${i}`);
      expect(out).toContain(`ИТОГ-${i}`);
    }
    expect(out).toContain('… (part of the conversation omitted)');
  });
});
