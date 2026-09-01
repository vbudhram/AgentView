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

// Leading "cd /abs/path && " and env assignments (S=/long/path node x) spend
// the whole visible line on boilerplate; the command after them matters.
function stripCmdBoilerplate(cmd: string): string {
  let c = cmd.trimStart();
  for (;;) {
    const env = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/.exec(c);
    if (env) { c = c.slice(env[0].length); continue; }
    const cd = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/.exec(c);
    if (cd) { c = c.slice(cd[0].length); continue; }
    return c;
  }
}

// Absolute paths eat the visible chars; the basename carries the meaning.
export function shortenPaths(s: string): string {
  return s.replace(/(?:^|(?<=[\s('"`=:]))\/(?:[\w.@+-]+\/)+([\w.@+-]+\/?)/g, '$1');
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

// Tool input as a plain JSON object; null for arrays, scalars, or non-JSON
// (codex arguments are not always JSON).
function asJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return null;
}

// Expanded tool input: "key: value" lines instead of raw JSON; long values cut.
export function prettyToolInput(input: string): string {
  const obj = asJsonObject(input);
  if (!obj) return input;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    const one = (val ?? '').replace(/\r/g, '');
    lines.push(`${k}: ${one.length > 400 ? `${one.slice(0, 400)}…` : one}`);
  }
  return lines.join('\n') || input;
}

// e.g. "Bash: npm test", "Edit: store.ts", "Agent: Critic round 2", never raw JSON.
export function describeToolCall(name: string, input: string): string {
  const n = shortToolName(name);
  const obj = asJsonObject(input);
  if (!obj) {
    const t = input.trim();
    return t && !t.startsWith('{') ? `${n}: ${excerpt(t, 60)}` : n;
  }
  // Bash: the human-written description beats the raw command line.
  if (typeof obj.command === 'string') {
    if (typeof obj.description === 'string' && obj.description.trim()) {
      return `${n}: ${excerpt(obj.description, 60)}`;
    }
    return `${n}: ${excerpt(stripCmdBoilerplate(obj.command), 60)}`;
  }
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

// Harness-injected wrappers arrive as user-role messages but are not the
// owner's words. Detect them so the UI renders a system note, not "YOU".
const SYSTEM_NOTE_TAGS = new Set([
  'task-notification',
  'system-reminder',
  'system-warning',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
]);

export interface SystemNote { tag: string; summary: string }

export function classifySystemNote(text: string): SystemNote | null {
  const t = text.trim();
  if (t.startsWith('Caveat:')) return { tag: 'caveat', summary: noteSummary(t) };
  const m = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/.exec(t);
  if (!m) return null;
  const tag = m[1];
  // Known harness tags always classify. Unknown hyphenated tags classify only
  // when the whole message is wrapped by them; plain HTML tags never do.
  const wrapped = new RegExp(`</${tag}>\\s*$`).test(t);
  if (!SYSTEM_NOTE_TAGS.has(tag) && !(tag.includes('-') && wrapped)) return null;
  return { tag, summary: noteSummary(t) };
}

function noteSummary(t: string): string {
  const sm = /<summary>([\s\S]*?)<\/summary>/.exec(t);
  const src = sm ? sm[1] : t;
  return excerpt(src.replace(/<[^>\n]{1,120}>/g, ' '), 120);
}

// One-line result summary: shape first ("14 lines"), then a first line with
// absolute paths reduced to basenames, never a run of path characters.
export function describeToolResult(output: string, isError = false): string {
  const t = stripAnsi(output).trim();
  if (!t) return '(empty)';
  const lines = t.split('\n');
  const first = excerpt(shortenPaths(lines[0]), 70);
  const prefix = isError ? 'error · ' : '';
  if (lines.length > 1) return `${prefix}${lines.length} lines · ${first}`;
  if (t.length > 200) return `${prefix}${(t.length / 1024).toFixed(1)}KB · ${first}`;
  return `${prefix}${first}`;
}
