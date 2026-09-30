/** Fields common to every hook payload that we rely on. */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionEnd: clear | resume | logout | prompt_input_exit | other */
  reason?: string;
  /** SessionStart: startup | resume | clear | compact | fork */
  source?: string;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseHookInput(raw: string): HookInput {
  const data = JSON.parse(raw) as Partial<HookInput>;
  if (typeof data.session_id !== 'string') throw new Error('hook input without session_id');
  return data as HookInput;
}
