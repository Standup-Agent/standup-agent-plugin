/**
 * Developer notes for the next standup (card 2a): calls, reviews, decisions, "start with X
 * tomorrow" — work that code and sessions don't show. Kept in notes.jsonl, no LLM on write, never
 * sent on their own: they reach the manager only inside a standup the developer confirms.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentBranch, findTickets } from '../capture/git.js';
import { writeFileAtomic } from '../fsutil.js';
import { dataDir } from '../paths.js';
import { repoOf } from '../repos.js';
import { redactSecrets } from '../secrets.js';
import { isWorkRepo, readState } from '../state.js';

export interface Note {
  id: string;
  text: string;
  /** When it was written (ISO). */
  ts: string;
  /** Set only when the note was written in a work repo: personal repos stay out even locally. */
  repo?: string;
  repo_path?: string;
  branch?: string;
  ticket?: string;
}

/** A note is a line or two, not a document. */
export const NOTE_MAX_CHARS = 2000;

const notesFile = () => join(dataDir(), 'notes.jsonl');

export function readNotes(): Note[] {
  let raw: string;
  try {
    raw = readFileSync(notesFile(), 'utf8');
  } catch {
    return [];
  }
  const out: Note[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const n = JSON.parse(line) as Note;
      if (typeof n.id === 'string' && typeof n.text === 'string') out.push(n);
    } catch {
      // a broken line is skipped, the rest stays
    }
  }
  return out;
}

function writeNotes(notes: Note[]): void {
  writeFileAtomic(notesFile(), notes.map((n) => JSON.stringify(n) + '\n').join(''));
}

/**
 * Save a note. Secrets are filtered before it is written. In a work repo the current branch and
 * the ticket (from the text, else from the branch) are attached; elsewhere only the text is kept.
 */
export function addNote(text: string, cwd: string, now = new Date()): { note: Note; redacted: number } | string {
  const trimmed = text.trim();
  if (!trimmed) return 'The note is empty.';
  if (trimmed.length > NOTE_MAX_CHARS) return `The note is too long (${trimmed.length} characters, at most ${NOTE_MAX_CHARS}): keep it to a line or two.`;
  const { text: clean, found } = redactSecrets(trimmed);
  const note: Note = { id: randomUUID(), text: clean, ts: now.toISOString() };
  const repo = repoOf(cwd);
  let branch: string | null = null;
  if (repo && isWorkRepo(repo.path, readState())) {
    branch = currentBranch(cwd);
    note.repo = repo.name;
    note.repo_path = repo.path;
    if (branch) note.branch = branch;
  }
  const ticket = findTickets(clean)[0] ?? (branch ? findTickets(branch)[0] : undefined);
  if (ticket) note.ticket = ticket;
  writeNotes([...readNotes(), note]);
  return { note, redacted: Object.values(found).reduce((a, b) => a + b, 0) };
}

/** Remove notes by id or by their 1-based number in `readNotes()`; returns how many were removed. */
export function removeNotes(refs: string[]): number {
  const notes = readNotes();
  const drop = new Set<string>();
  for (const ref of refs) {
    const n = /^\d+$/.test(ref) ? notes[Number(ref) - 1] : notes.find((x) => x.id === ref);
    if (n) drop.add(n.id);
  }
  if (drop.size > 0) writeNotes(notes.filter((n) => !drop.has(n.id)));
  return drop.size;
}
