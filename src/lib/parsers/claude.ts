import type { AgentEvent, ParsedLine, SourceKind } from '../types';

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b?.text ?? b?.content ?? ''))
      .filter(Boolean)
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
  }
  return '';
}

export function parseClaudeLine(line: string): ParsedLine {
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
  const events: AgentEvent[] = [];
  let meta: ParsedLine['meta'];

  if (d.sessionId && d.cwd) {
    const source: SourceKind = d.entrypoint === 'claude-desktop' ? 'desktop' : 'terminal';
    meta = { sessionId: d.sessionId, cwd: d.cwd, source };
  }

  const content = d.message?.content;
  if (d.type === 'user' && content) {
    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          events.push({ kind: 'tool_result', ts, output: asText(b.content), isError: !!b.is_error });
        }
      }
    } else {
      const text = asText(content);
      if (text) events.push({ kind: 'user_message', ts, text });
    }
  } else if (d.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && b.text) events.push({ kind: 'assistant_message', ts, text: b.text });
      else if (b?.type === 'thinking' && b.thinking) events.push({ kind: 'thinking', ts, text: b.thinking });
      else if (b?.type === 'tool_use') events.push({ kind: 'tool_call', ts, name: b.name ?? '?', input: JSON.stringify(b.input ?? {}) });
    }
  }
  return meta ? { events, meta } : { events };
}
