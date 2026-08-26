// Extracts the agent CLI's in-terminal spinner line from raw PTY output, so
// the dashboard can mirror it live, e.g.
//   "· Undulating… (34s · ↓ 46 tokens · esc to interrupt)"
// Shapes vary by Claude Code version, so the match is tolerant: a capitalized
// verb ending in an ellipsis, then "(elapsed · optional segments)".
import { stripAnsi } from './describe';

const SPINNER_RE = /([A-Z][A-Za-z]+(?:…|\.\.\.))\s*\(((?:\d+m\s*)?\d+s(?:\s*·[^)]*)?)\)/;

// Returns the most recent spinner line in the chunk as display text (the
// "esc to interrupt" hint trimmed), or null when the chunk holds none.
export function parseSpinner(chunk: string): string | null {
  const segments = stripAnsi(chunk).split(/[\r\n]+/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = SPINNER_RE.exec(segments[i]);
    if (!m) continue;
    const inner = m[2].replace(/\s*·\s*esc to interrupt\s*$/i, '').trim();
    return `${m[1]} (${inner})`;
  }
  return null;
}
