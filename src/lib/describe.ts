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

// A leading "cd /abs/path && " spends the whole line on the path; the command
// after it is the part that matters.
function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '');
}

// Terminal escape sequences (colors, cursor moves, OSC titles) are noise in a
// browser. One shared strip keeps every display path consistent.
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[@-Z\\^_]/g, '');
}

// One-line plain text for feed rows: XML-ish tags and inline markdown out.
export function plainText(s: string): string {
  return stripAnsi(s)
    .replace(/<\/?[a-zA-Z][^>\n]{0,80}>/g, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Expanded tool input: "key: value" lines instead of raw JSON; long values cut.
export function prettyToolInput(input: string): string {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
  } catch { /* not JSON: show as-is */ }
  if (!obj) return input;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    const one = (val ?? '').replace(/\r/g, '');
    lines.push(`${k}: ${one.length > 400 ? `${one.slice(0, 400)}…` : one}`);
  }
  return lines.join('\n') || input;
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
  if (typeof obj.command === 'string') return `${n}: ${excerpt(stripCdPrefix(obj.command), 60)}`;
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
