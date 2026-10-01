/**
 * THE ONLY module that knows the Claude Code transcript format (JSONL, undocumented).
 * Verified on Claude Code 2.1.251–2.1.285 (see test/fixtures/transcripts).
 *
 * Takes only what the user typed and the text Claude wrote back. Everything else — thinking,
 * tool calls and their results, command output, diffs, attachments (IDE selection, reminders),
 * sidechains (subagents) — is skipped. Compaction summaries are kept apart (Claude Code's own
 * summary of the context so far). Unknown lines are counted, logged by type name only and skipped;
 * the parser never throws on content.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { log } from '../log.js';
import { fitTurns } from './budget.js';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp of the transcript entry, if present. */
  ts?: string;
  /** Git branch Claude Code recorded for this entry. */
  branch?: string;
  /** Working directory of this entry (the session can `cd` between repos). */
  cwd?: string;
}

/** Claude Code's compaction summary: an LLM summary of the conversation up to that point. */
export interface CompactSummary {
  text: string;
  ts?: string;
  branch?: string;
  cwd?: string;
}

export interface Transcript {
  sessionId?: string;
  /** Last `cwd` seen in the transcript. */
  cwd?: string;
  /** Claude Code version from the last entry that has one. */
  version?: string;
  /** First and last timestamp of any entry: the session period. */
  firstTs?: string;
  lastTs?: string;
  messages: TranscriptMessage[];
  /**
   * Compaction summaries written while every entry so far was in an accepted directory: a summary
   * made after the session visited a rejected one may retell its content.
   */
  compactSummaries: CompactSummary[];
  /** Entries left out because their directory was not accepted. */
  rejected: number;
  /** Messages dropped to fit the size budget. */
  dropped: number;
  /** Messages cut to the per-message cap. */
  cut: number;
}

export interface ReadOptions {
  /** Total budget for message texts, bytes (UTF-8). Omit to keep everything (the caller budgets). */
  maxBytes?: number;
  /** Per-message cap, bytes. */
  maxBytesPerMessage: number;
  /** Cap for one compaction summary, bytes. Omit to skip summaries. */
  maxBytesPerSummary?: number;
  /** Applied to each text before it is measured and cut (the secret filter). */
  transform?: (text: string) => string;
  /**
   * Whether entries in this directory may be read. A rejected entry's text is never transformed
   * or kept. Entries without a `cwd` inherit the previous one, then `defaultCwd`.
   */
  accept?: (cwd: string | undefined) => boolean;
  defaultCwd?: string;
}

/** Entry types we know and deliberately ignore. Anything else is counted as unknown. */
const IGNORED_TYPES = new Set([
  'system', 'attachment', 'summary', 'mode', 'permission-mode', 'file-history-snapshot', 'last-prompt',
  'ai-title', 'custom-title', 'atis-latch', 'bridge-session', 'cost-state', 'progress', 'queue-operation',
  'tag', 'agent-name', 'pr-link', 'file-history-delta',
]);

/** User "messages" that are really command plumbing, output or interruptions. */
const USER_NOISE = [
  '<command-name>', '<command-message>', '<command-args>', '<local-command-stdout>', '<local-command-stderr>',
  '<local-command-caveat>', '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<task-notification>',
  '<user-prompt-submit-hook>', '[Request interrupted',
];

/** Wrapped blocks Claude Code injects into user text (reminders, IDE context). */
const INJECTED_BLOCKS = /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g;

const TRUNCATED = '…[truncated]';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Reads only the first `cwd` of a transcript: cheap check before a full parse. */
export async function readTranscriptCwd(path: string): Promise<string | undefined> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = str((JSON.parse(line) as Json).cwd);
        if (cwd) return cwd;
      } catch {
        // keep looking
      }
    }
  } finally {
    rl.close();
  }
  return undefined;
}

export async function readTranscript(path: string, opts: ReadOptions): Promise<Transcript> {
  const out: Transcript = { messages: [], compactSummaries: [], rejected: 0, dropped: 0, cut: 0 };
  const unknown: Record<string, number> = {};
  let badLines = 0;
  let branch: string | undefined;
  let cwd = opts.defaultCwd;
  let tainted = false;
  // Hard cap on raw text per message before transform: bounds regex work on a huge paste.
  const hardCap = Math.max(opts.maxBytes ?? 0, opts.maxBytesPerMessage, opts.maxBytesPerSummary ?? 0);

  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isObj(entry)) {
      badLines++;
      continue;
    }

    const ts = str(entry.timestamp);
    const tms = ts ? Date.parse(ts) : NaN;
    if (ts && !Number.isNaN(tms)) {
      // Entries are not strictly ordered by time (e.g. a command line written after its caveat).
      if (out.firstTs === undefined || tms < Date.parse(out.firstTs)) out.firstTs = ts;
      if (out.lastTs === undefined || tms > Date.parse(out.lastTs)) out.lastTs = ts;
    }
    out.sessionId ??= str(entry.sessionId);
    out.cwd = str(entry.cwd) ?? out.cwd;
    out.version = str(entry.version) ?? out.version;
    branch = str(entry.gitBranch) ?? branch;
    cwd = str(entry.cwd) ?? cwd;
    if (opts.accept && !opts.accept(cwd)) {
      out.rejected++;
      tainted = true;
      continue;
    }

    const type = str(entry.type) ?? '';
    if (type === 'user' && entry.isCompactSummary && !entry.isSidechain) {
      if (opts.maxBytesPerSummary && !tainted) {
        const raw = contentTexts(entry).join('\n');
        let text = cutBytes(raw, hardCap).text.trim();
        if (opts.transform) text = opts.transform(text);
        text = cutBytes(text, opts.maxBytesPerSummary).text;
        if (text) out.compactSummaries.push({ text, ...(ts && { ts }), ...(branch && { branch }), ...(cwd && { cwd }) });
      }
      continue;
    }
    let texts: string[];
    if (type === 'user') texts = userTexts(entry);
    else if (type === 'assistant') texts = assistantTexts(entry);
    else {
      if (!IGNORED_TYPES.has(type)) {
        const key = /^[a-z][a-z0-9_-]{0,39}$/.test(type) ? type : 'other';
        unknown[key] = (unknown[key] ?? 0) + 1;
      }
      continue;
    }

    for (const raw of texts) {
      let text = cutBytes(raw, hardCap).text.trim();
      if (opts.transform) text = opts.transform(text);
      const cut = cutBytes(text, opts.maxBytesPerMessage);
      if (cut.cut) out.cut++;
      if (cut.text === '') continue;
      const msg: TranscriptMessage = { role: type as 'user' | 'assistant', text: cut.text };
      if (ts) msg.ts = ts;
      if (branch) msg.branch = branch;
      if (cwd) msg.cwd = cwd;
      out.messages.push(msg);
    }
  }

  if (opts.maxBytes !== undefined) {
    const fitted = fitTurns(out.messages, opts.maxBytes, BYTES, MIN_CAP_BYTES);
    out.messages = fitted.kept;
    out.dropped += fitted.dropped;
    out.cut += fitted.cut;
  }
  if (badLines > 0 || Object.keys(unknown).length > 0) {
    log('info', 'transcript: skipped unrecognized entries', { badLines, unknownTypes: unknown, version: out.version });
  }
  return out;
}

function userTexts(e: Json): string[] {
  if (e.isMeta || e.isSidechain || e.isCompactSummary || e.isVisibleInTranscriptOnly) return [];
  // "[Request interrupted by user]" marker.
  if (e.interruptedMessageId) return [];
  const msg = e.message;
  if (!isObj(msg)) return [];
  const content = msg.content;
  let parts: string[];
  if (typeof content === 'string') parts = [content];
  else if (Array.isArray(content)) {
    // Only top-level text blocks: tool_result (command output, file contents, diffs) and images are skipped.
    parts = content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Json).text as string);
  } else return [];
  return parts.map(cleanUserText).filter((t): t is string => t !== undefined);
}

function cleanUserText(text: string): string | undefined {
  const t = text.trimStart();
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return slashCommand(t);
  if (USER_NOISE.some((p) => t.startsWith(p))) return undefined;
  const cleaned = text.replace(INJECTED_BLOCKS, '').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** `/review fix the webhook retry` is what the user asked; a bare `/clear` or `/model` is noise. */
function slashCommand(t: string): string | undefined {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)?.[1];
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
  if (!name || !args) return undefined;
  return `${name.startsWith('/') ? name : `/${name}`} ${args}`;
}

function assistantTexts(e: Json): string[] {
  if (e.isSidechain || e.isApiErrorMessage || e.isMeta) return [];
  const msg = e.message;
  if (!isObj(msg) || msg.model === '<synthetic>') return [];
  const content = msg.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  // text only: thinking, redacted_thinking, tool_use, server tool blocks are skipped.
  return content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Json).text as string);
}

/** Cut to at most `max` UTF-8 bytes on a character boundary. */
export function cutBytes(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= max) return { text, cut: false };
  const room = Math.max(0, max - Buffer.byteLength(TRUNCATED, 'utf8'));
  const head = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '');
  return { text: head + TRUNCATED, cut: true };
}

/** Smallest per-message cap when a budget squeezes a conversation. */
export const MIN_CAP_BYTES = 200;

export const BYTES = {
  size: (t: string) => Buffer.byteLength(t, 'utf8'),
  cut: (t: string, max: number) => cutBytes(t, max).text,
};

function contentTexts(e: Json): string[] {
  const msg = e.message;
  if (!isObj(msg)) return [];
  if (typeof msg.content === 'string') return [msg.content];
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Json).text as string);
}
