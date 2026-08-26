// Mirrors the agent CLI's in-terminal spinner line, e.g.
//   "· Undulating… (34s · ↓ 46 tokens · esc to interrupt)"
// The CLI repaints with cell-level cursor addressing (only changed digits are
// written), so a plain line parser freezes. SpinnerScreen is a minimal VT
// screen model: it applies cursor moves and erases to a character grid, and
// the spinner is read back from the grid rows. Shapes vary by CLI version, so
// the match is tolerant: a capitalized verb ending in an ellipsis, then
// "(elapsed · optional segments)".
import { StringDecoder } from 'node:string_decoder';

const SPINNER_RE = /([A-Z][A-Za-z]+(?:…|\.\.\.))\s*\(((?:\d+m\s*)?\d+s(?:\s*·[^)]*)?)\)/;

// Returns the spinner display text in a line (the "esc to interrupt" hint
// trimmed), or null when the line holds none.
export function matchSpinner(line: string): string | null {
  const m = SPINNER_RE.exec(line);
  if (!m) return null;
  const inner = m[2].replace(/\s*·\s*esc to interrupt\s*$/i, '').trim();
  return `${m[1]} (${inner})`;
}

const ROWS = 60;
const COLS = 500;
const PENDING_MAX = 4096;

const TOKEN = /\u001b\[([0-9;?]*)([a-zA-Z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\^_]|[\r\n\b]|[^\u001b\r\n\b]+|\u001b/g;

// True when the escape sequence starting at i is still missing its terminator.
function incompleteFrom(s: string, i: number): boolean {
  if (i === s.length - 1) return true;
  const rest = s.slice(i);
  if (s[i + 1] === '[') return !/^\u001b\[[0-9;?]*[a-zA-Z]/.test(rest);
  if (s[i + 1] === ']') return !/^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.test(rest);
  return false;
}

export class SpinnerScreen {
  private rows: (string[] | undefined)[] = [];
  private r = 0;
  private c = 0;
  private pending = '';
  private decoder = new StringDecoder('utf8');

  write(data: Buffer | string): void {
    this.feed(typeof data === 'string' ? data : this.decoder.write(data));
  }

  reset(): void {
    this.rows = [];
    this.r = 0;
    this.c = 0;
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
  }

  // The most recent spinner on screen: the CLI paints it near the viewport
  // bottom, so the deepest matching row wins over stale remnants above it.
  spinner(): string | null {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (!row) continue;
      const text = matchSpinner(Array.from(row, (ch) => ch ?? ' ').join(''));
      if (text) return text;
    }
    return null;
  }

  private feed(chunk: string): void {
    let s = this.pending + chunk;
    // hold back a trailing escape sequence that a chunk boundary split
    const esc = s.lastIndexOf('\u001b');
    if (esc >= 0 && incompleteFrom(s, esc) && s.length - esc <= PENDING_MAX) {
      this.pending = s.slice(esc);
      s = s.slice(0, esc);
    } else {
      this.pending = '';
    }
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN.exec(s))) {
      if (m[2] !== undefined) this.csi(m[1], m[2]);
      else if (m[0] === '\r') this.c = 0;
      else if (m[0] === '\n') this.r = Math.min(ROWS - 1, this.r + 1);
      else if (m[0] === '\b') this.c = Math.max(0, this.c - 1);
      else if (m[0][0] !== '\u001b') this.text(m[0]);
    }
  }

  private csi(params: string, final: string): void {
    const p = params.replace('?', '').split(';').map((x) => parseInt(x, 10));
    const n = Number.isFinite(p[0]) && p[0] > 0 ? p[0] : 1;
    switch (final) {
      case 'H': case 'f': {
        const col = Number.isFinite(p[1]) && p[1] > 0 ? p[1] : 1;
        this.r = Math.min(n - 1, ROWS - 1);
        this.c = Math.min(col - 1, COLS - 1);
        break;
      }
      case 'G': this.c = Math.min(n - 1, COLS - 1); break;
      case 'd': this.r = Math.min(n - 1, ROWS - 1); break;
      case 'A': this.r = Math.max(0, this.r - n); break;
      case 'B': this.r = Math.min(ROWS - 1, this.r + n); break;
      case 'C': this.c = Math.min(COLS - 1, this.c + n); break;
      case 'D': this.c = Math.max(0, this.c - n); break;
      case 'K': {
        const row = this.rows[this.r];
        if (!row) break;
        const mode = Number.isFinite(p[0]) ? p[0] : 0;
        if (mode === 0) row.length = Math.min(row.length, this.c);
        else if (mode === 1) { for (let i = 0; i <= this.c && i < row.length; i++) row[i] = ' '; }
        else this.rows[this.r] = undefined;
        break;
      }
      case 'J': {
        const mode = Number.isFinite(p[0]) ? p[0] : 0;
        if (mode >= 2) this.rows = [];
        else if (mode === 1) { for (let i = 0; i < this.r; i++) this.rows[i] = undefined; }
        else {
          this.rows.length = Math.min(this.rows.length, this.r + 1);
          const row = this.rows[this.r];
          if (row) row.length = Math.min(row.length, this.c);
        }
        break;
      }
      // colors, modes, cursor visibility: no effect on the grid
    }
  }

  private text(t: string): void {
    const row = this.rows[this.r] ?? (this.rows[this.r] = []);
    for (const ch of t) {
      if (this.c >= COLS) break;
      row[this.c++] = ch;
    }
  }
}
