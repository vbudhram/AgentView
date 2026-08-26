import type { AgentEvent, ParsedLine } from '../types';

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => b?.text ?? '').filter(Boolean).join('\n');
}

export function parseCodexLine(line: string): ParsedLine {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (d === null || typeof d !== 'object') {
    return { events: [] };
  }
  const ts: string = d.timestamp ?? new Date(0).toISOString();
  const p = d.payload ?? {};
  const events: AgentEvent[] = [];

  if (d.type === 'session_meta') {
    return { events, meta: { sessionId: p.session_id ?? p.id, cwd: p.cwd, source: 'codex' } };
  }
  if (d.type === 'event_msg') {
    if (p.type === 'task_started') events.push({ kind: 'turn_status', ts, status: 'started' });
    else if (p.type === 'task_complete') events.push({ kind: 'turn_status', ts, status: 'completed' });
    else if (p.type === 'turn_aborted') events.push({ kind: 'turn_status', ts, status: 'interrupted' });
  } else if (d.type === 'response_item') {
    if (p.type === 'message') {
      const text = textOf(p.content);
      if (text && p.role === 'user') events.push({ kind: 'user_message', ts, text });
      else if (text && p.role === 'assistant') events.push({ kind: 'assistant_message', ts, text });
    } else if (p.type === 'reasoning') {
      const text = textOf(p.summary ?? p.content);
      if (text) events.push({ kind: 'thinking', ts, text });
    } else if (p.type === 'function_call') {
      events.push({ kind: 'tool_call', ts, name: p.name ?? '?', input: String(p.arguments ?? '') });
    } else if (p.type === 'function_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      events.push({ kind: 'tool_result', ts, output: out, isError: false });
    }
  }
  return { events };
}
