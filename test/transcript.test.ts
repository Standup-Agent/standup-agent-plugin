import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cutBytes, readTranscript, readTranscriptCwd } from '../src/capture/transcript.js';
import { tmp, tx, writeTranscript } from './helpers.js';

const FIXTURES = join(__dirname, 'fixtures', 'transcripts');
const OPTS = { maxBytes: 64 * 1024, maxBytesPerMessage: 8 * 1024 };

let data: string;
beforeEach(() => {
  data = tmp();
  process.env.CLAUDE_PLUGIN_DATA = data;
});

const logText = () => {
  try {
    return readFileSync(join(data, 'log', 'plugin.log'), 'utf8');
  } catch {
    return '';
  }
};

describe('readTranscript on real (sanitized) transcripts', () => {
  // Fixture text is replaced by "<key:length>". A slash command's wrapper and its stdout are plain
  // user strings too (the "<content:130>" / "<content:122>" lines), so in fixtures they can't be
  // told from a prompt by content; the synthetic tests below cover that filter.
  const expected: Record<string, string[]> = {
    'cc-2.1.251.jsonl': ['user:<content:130>', 'user:<content:73>'],
    'cc-2.1.265.jsonl': ['user:<content:48>', 'assistant:<text:87>'],
    'cc-2.1.274.jsonl': [
      'user:<content:33>',
      'user:<content:130>',
      'user:<content:122>',
      'user:<content:33>',
      'assistant:<text:94>',
    ],
    'cc-2.1.285.jsonl': ['user:<content:14>', 'assistant:<text:404>'],
  };

  it('covers every fixture', () => {
    expect(readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [file, texts] of Object.entries(expected)) {
    it(`${file}: only user prompts and Claude's text replies`, async () => {
      const t = await readTranscript(join(FIXTURES, file), OPTS);
      expect(t.messages.map((m) => `${m.role}:${m.text}`)).toEqual(texts);
      expect(t.cwd).toBe('/work/acme/billing-api');
      expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.version).toBe(file.slice(3, -6));
      expect(t.messages.every((m) => m.branch === 'feature/PAY-42-webhooks')).toBe(true);
      expect(t.messages.every((m) => typeof m.ts === 'string')).toBe(true);
      expect(Date.parse(t.firstTs!)).toBeLessThanOrEqual(Date.parse(t.lastTs!));
      // Nothing from thinking, tool_use input, tool_result, attachments, isMeta skill bodies:
      const all = t.messages.map((m) => m.text).join('\n');
      // (message texts are keyed "content"/"text"; thinking, tool inputs, stdout etc. have other keys)
      expect(all).not.toMatch(/<(?!content:|text:)[A-Za-z_]+:\d+>/);
      expect(all).not.toMatch(/<text:(12513|14080|3958)>/); // isMeta turnCompanion blocks
      expect(logText()).not.toContain('unrecognized');
    });
  }

  it('reads the first cwd cheaply', async () => {
    expect(await readTranscriptCwd(join(FIXTURES, 'cc-2.1.285.jsonl'))).toBe('/work/acme/billing-api');
  });

  it('the firstTs is the earliest entry even when lines are out of order', async () => {
    const t = await readTranscript(join(FIXTURES, 'cc-2.1.251.jsonl'), OPTS);
    expect(t.firstTs).toBe('2026-09-01T11:01:13.154Z');
    expect(t.lastTs).toBe('2026-09-01T11:01:50.492Z');
  });
});

describe('readTranscript filters', () => {
  const T = '2026-09-30T10:00:00.000Z';
  const read = async (entries: (Record<string, unknown> | string)[]) =>
    readTranscript(writeTranscript(join(tmp(), 's.jsonl'), entries, { cwd: '/w', gitBranch: 'main' }), OPTS);
  const texts = async (entries: (Record<string, unknown> | string)[]) =>
    (await read(entries)).messages.map((m) => `${m.role}:${m.text}`);

  it('takes typed prompts and text blocks, drops thinking and tool_use', async () => {
    expect(
      await texts([
        tx.prompt('add webhook retries', T),
        tx.assistant([{ type: 'thinking', thinking: 'secret reasoning', signature: 'x' }], T),
        tx.assistant([tx.text('I will use exponential backoff because the provider rate-limits.')], T),
        tx.assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/w/a.ts', new_string: 'code' } }], T),
        tx.assistant([{ type: 'redacted_thinking', data: 'xxx' }], T),
      ]),
    ).toEqual(['user:add webhook retries', 'assistant:I will use exponential backoff because the provider rate-limits.']);
  });

  it('drops tool results, command output and diffs', async () => {
    expect(
      await texts([
        tx.userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'diff --git a/x b/x\n+secret' }], T, {
          toolUseResult: { stdout: 'x' },
        }),
        tx.userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_2', content: [tx.text('file contents')] }], T),
        tx.prompt('<bash-input>git diff</bash-input>', T),
        tx.prompt('<bash-stdout>diff --git a/x b/x</bash-stdout><bash-stderr></bash-stderr>', T),
        tx.prompt('<local-command-stdout>Set model to opus</local-command-stdout>', T),
        tx.prompt('<local-command-caveat>Caveat: The messages below were generated by the user</local-command-caveat>', T),
        tx.prompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', T),
        tx.prompt('<task-notification>background task done</task-notification>', T),
        tx.userBlocks([tx.text('[Request interrupted by user]')], T, { interruptedMessageId: 'msg_1' }),
        tx.userBlocks([tx.text('[Request interrupted by user for tool use]')], T),
      ]),
    ).toEqual([]);
  });

  it('keeps the arguments of a slash command', async () => {
    expect(
      await texts([
        tx.prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>focus on retries</command-args>', T),
      ]),
    ).toEqual(['user:/review focus on retries']);
  });

  it('drops meta, sidechain, compact summary, synthetic and API-error entries', async () => {
    expect(
      await texts([
        tx.prompt('skill body injected', T, { isMeta: true }),
        tx.prompt('subagent prompt', T, { isSidechain: true }),
        tx.assistant([tx.text('subagent reply')], T, { isSidechain: true }),
        tx.prompt('This session is being continued from a previous conversation...', T, { isCompactSummary: true }),
        tx.prompt('only in transcript', T, { isVisibleInTranscriptOnly: true }),
        tx.assistant([tx.text('No response requested.')], T, { message: { model: '<synthetic>', role: 'assistant', content: [tx.text('No response requested.')] } }),
        tx.assistant([tx.text('API Error: 529 overloaded')], T, { isApiErrorMessage: true }),
        { type: 'attachment', attachment: { type: 'selected_lines_in_ide', content: 'const password = 1' }, timestamp: T },
        { type: 'system', subtype: 'local_command', content: '<local-command-stdout>x</local-command-stdout>', timestamp: T },
      ]),
    ).toEqual([]);
  });

  it('strips injected reminder blocks and image blocks from a prompt', async () => {
    expect(
      await texts([
        tx.userBlocks(
          [
            tx.text('fix this <system-reminder>The user opened file x.ts</system-reminder>please'),
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
            tx.text('<ide_selection>const x = 1</ide_selection>'),
          ],
          T,
        ),
      ]),
    ).toEqual(['user:fix this please']);
  });

  it('skips broken and unknown lines, logs only their type names', async () => {
    const t = await read([
      '{not json',
      '"just a string"',
      { type: 'brand-new-entry', payload: 'user text that must not be logged' },
      { type: 'Weird Type With Spaces and text', x: 1 },
      tx.prompt('still works', T),
    ]);
    expect(t.messages.map((m) => m.text)).toEqual(['still works']);
    const log = logText();
    expect(log).toContain('unrecognized');
    expect(log).toContain('"badLines":2');
    expect(log).toContain('"brand-new-entry":1');
    expect(log).toContain('"other":1');
    expect(log).not.toContain('must not be logged');
    expect(log).not.toContain('Spaces');
  });

  it('tracks the branch per message', async () => {
    const t = await read([
      tx.prompt('one', T, { gitBranch: 'feature/A-1' }),
      tx.assistant([tx.text('two')], T, { gitBranch: 'feature/B-2' }),
    ]);
    expect(t.messages.map((m) => m.branch)).toEqual(['feature/A-1', 'feature/B-2']);
  });

  it('applies the transform (secret filter) before storing', async () => {
    const t = await readTranscript(
      writeTranscript(join(tmp(), 's.jsonl'), [tx.prompt('password=hunter2', T)]),
      { ...OPTS, transform: (s) => s.replace('hunter2', '***') },
    );
    expect(t.messages[0]!.text).toBe('password=***');
  });
});

describe('readTranscript size limit', () => {
  const T = (i: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, i)).toISOString();

  it('cuts a huge message to the per-message cap on a character boundary', async () => {
    const huge = 'я'.repeat(10_000); // 2 bytes per char
    const t = await readTranscript(writeTranscript(join(tmp(), 's.jsonl'), [tx.prompt(huge, T(0))]), {
      maxBytes: 64 * 1024,
      maxBytesPerMessage: 1001,
    });
    const text = t.messages[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1001);
    expect(text.endsWith('…[truncated]')).toBe(true);
    expect(text).not.toContain('�');
    expect(t.cut).toBe(1);
  });

  it('keeps the first prompt and the latest messages within the budget', async () => {
    const entries = [tx.prompt('TASK: implement webhooks', T(0))];
    for (let i = 1; i <= 50; i++) entries.push(tx.assistant([tx.text(`step ${i} `.padEnd(100, '.'))], T(i)));
    const t = await readTranscript(writeTranscript(join(tmp(), 's.jsonl'), entries), {
      maxBytes: 1000,
      maxBytesPerMessage: 500,
    });
    const total = t.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0);
    expect(total).toBeLessThanOrEqual(1000);
    expect(t.messages[0]!.text).toBe('TASK: implement webhooks');
    expect(t.messages[t.messages.length - 1]!.text).toMatch(/^step 50 /);
    expect(t.dropped).toBe(51 - t.messages.length);
    expect(t.dropped).toBeGreaterThan(0);
    // chronological order is preserved
    const ts = t.messages.map((m) => m.ts!);
    expect([...ts].sort()).toEqual(ts);
  });

  it('the default budget holds on every fixture', async () => {
    for (const f of readdirSync(FIXTURES)) {
      const t = await readTranscript(join(FIXTURES, f), { maxBytes: 100, maxBytesPerMessage: 50 });
      expect(t.messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0)).toBeLessThanOrEqual(100);
    }
  });
});

describe('cutBytes', () => {
  it('leaves short text alone', () => {
    expect(cutBytes('abc', 10)).toEqual({ text: 'abc', cut: false });
  });
  it('never splits a surrogate pair', () => {
    const out = cutBytes('😀'.repeat(20), 20);
    expect(out.cut).toBe(true);
    expect(out.text).not.toContain('�');
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(20);
  });
});
