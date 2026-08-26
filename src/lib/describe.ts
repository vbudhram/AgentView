// Human-readable one-liners for tool calls, shared by the store and the UI.

function excerpt(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// "mcp__plugin_foo__get_observations" -> "get_observations"
export function shortToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const last = name.split('__').pop();
  return last || name;
}

// e.g. "Bash: npm test", "Edit: store.ts", "Agent: Critic round 2" — never raw JSON.
export function describeToolCall(name: string, input: string): string {
  const n = shortToolName(name);
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
  } catch { /* codex arguments are not always JSON */ }
  if (!obj) {
    const t = input.trim();
    return t && !t.startsWith('{') ? `${n}: ${excerpt(t, 60)}` : n;
  }
  if (typeof obj.command === 'string') return `${n}: ${excerpt(obj.command, 60)}`;
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = obj[k];
    if (typeof v === 'string') return `${n}: ${v.split('/').pop()}`;
  }
  for (const k of ['description', 'prompt', 'query', 'pattern', 'url', 'title']) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return `${n}: ${excerpt(v, 60)}`;
  }
  return n;
}
