import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { parseHookInput } from '../src/hookio.js';

describe('cli', () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'sa-'));
    process.env.CLAUDE_PLUGIN_DATA = data;
  });

  it('exits 0 and logs on an unknown command', async () => {
    expect(await main(['nope'])).toBe(0);
    expect(readFileSync(join(data, 'log', 'plugin.log'), 'utf8')).toContain('unknown command');
  });

  it('exits 0 when the capture job is broken', async () => {
    expect(await main(['capture', '{not json'])).toBe(0);
    expect(readFileSync(join(data, 'log', 'plugin.log'), 'utf8')).toContain('command failed');
  });
});

describe('parseHookInput', () => {
  it('rejects input without session_id', () => {
    expect(() => parseHookInput('{"cwd":"/x"}')).toThrow();
  });
});
