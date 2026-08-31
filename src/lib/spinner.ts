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

// The third alternative consumes any other escape sequence (intermediates
// then a final byte), e.g. charset designation ESC ( B, so its bytes never
// leak into the grid as text.
const TOKEN = /\u001b\[([0-9;:<=>?]*)[\x20-\x2f]*([\x40-\x7e])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[\x20-\x2f]*[\x30-\x7e]|[\r\n\b\t]|[^\u001b\r\n\b\t]+|\u001b/g;

// True when the escape sequence starting at i is still missing its terminator.
function incompleteFrom(s: string, i: number): boolean {
  if (i === s.length - 1) return true;
  const rest = s.slice(i);
  if (s[i + 1] === '[') return !/^\u001b\[[0-9;:<=>?]*[\x20-\x2f]*[\x40-\x7e]/.test(rest);
  if (s[i + 1] === ']') return !/^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.test(rest);
  // ESC plus only intermediate bytes so far (e.g. a chunk that ends in "ESC (")
  if (/^\u001b[\x20-\x2f]+$/.test(rest)) return true;
  return false;
}

// Character cell widths must match the real terminal's, or cursor-addressed
// repaints land at wrong columns and interleave old and new frames into
// garbled text (observed live: "more unse" for "more use" after a wide emoji).
// Zero width: combining marks, joiners (ZWJ), variation selectors, BOM.
const ZERO_RE = /[\p{Mn}\p{Me}\u200b-\u200f\u2060\ufe00-\ufe0f\ufeff]/u;
// Double width: default-emoji-presentation chars plus East Asian Wide/Fullwidth.
const WIDE_RE = /[\p{Emoji_Presentation}\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u;
function charWidth(ch: string): 0 | 1 | 2 {
  if (ch < '\u0300') return 1; // fast path: ASCII and Latin-1
  if (ZERO_RE.test(ch)) return 0;
  return WIDE_RE.test(ch) ? 2 : 1;
}

export class SpinnerScreen {
  private rows: (string[] | undefined)[] = [];
  private r = 0;
  private c = 0;
  private pending = '';
  private saved: { r: number; c: number } | null = null;
  private decoder = new StringDecoder('utf8');
  private cols: number;
  private rowMax: number;

  constructor(cols = COLS, rows = ROWS) {
    this.cols = cols;
    this.rowMax = rows;
  }

  // Track the PTY size so absolute addressing and scrolling stay faithful.
  resize(cols: number, rows: number): void {
    this.cols = cols;
    const drop = this.rows.length - rows;
    if (drop > 0) {
      this.rows.splice(0, drop); // keep the bottom rows, the recent content
      this.r = Math.max(0, this.r - drop);
    }
    this.rowMax = rows;
    this.r = Math.min(this.r, rows - 1);
    this.c = Math.min(this.c, cols - 1);
  }

  write(data: Buffer | string): void {
    this.feed(typeof data === 'string' ? data : this.decoder.write(data));
  }

  // The visible screen as plain text rows plus the cursor position.
  snapshot(): { lines: string[]; row: number; col: number } {
    const lines: string[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      lines.push(row ? Array.from(row, (ch) => ch ?? ' ').join('').replace(/\s+$/, '') : '');
    }
    return { lines, row: this.r, col: this.c };
  }

  reset(): void {
    this.rows = [];
    this.r = 0;
    this.c = 0;
    this.saved = null;
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
      else if (m[0] === '\n') this.lineFeed();
      else if (m[0] === '\b') this.c = Math.max(0, this.c - 1);
      else if (m[0] === '\t') this.c = Math.min(Math.floor(this.c / 8) * 8 + 8, this.cols - 1);
      else if (m[0] === '\u001b7') this.saved = { r: this.r, c: this.c };
      else if (m[0] === '\u001b8') this.restoreCursor();
      else if (m[0][0] !== '\u001b') this.text(m[0]);
    }
  }

  private csi(params: string, final: string): void {
    const p = params.replace('?', '').split(';').map((x) => parseInt(x, 10));
    const n = Number.isFinite(p[0]) && p[0] > 0 ? p[0] : 1;
    switch (final) {
      case 'H': case 'f': {
        const col = Number.isFinite(p[1]) && p[1] > 0 ? p[1] : 1;
        this.r = Math.min(n - 1, this.rowMax - 1);
        this.c = Math.min(col - 1, this.cols - 1);
        break;
      }
      case 'G': this.c = Math.min(n - 1, this.cols - 1); break;
      case 'd': this.r = Math.min(n - 1, this.rowMax - 1); break;
      case 'A': this.r = Math.max(0, this.r - n); break;
      case 'B': this.r = Math.min(this.rowMax - 1, this.r + n); break;
      case 'C': this.c = Math.min(this.cols - 1, this.c + n); break;
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

  // Scroll at the bottom row, as the terminal does.
  private lineFeed(): void {
    if (this.r >= this.rowMax - 1) this.rows.shift();
    else this.r++;
  }

  // DECRC restores the position DECSC saved (attributes are not modeled).
  private restoreCursor(): void {
    if (!this.saved) return;
    this.r = Math.min(this.saved.r, this.rowMax - 1);
    this.c = Math.min(this.saved.c, this.cols);
  }

  private text(t: string): void {
    for (const ch of t) {
      const w = charWidth(ch);
      if (w === 0) continue;
      // deferred autowrap: a char that no longer fits opens the next row
      if (this.c + w > this.cols) {
        this.lineFeed();
        this.c = 0;
      }
      const row = this.rows[this.r] ?? (this.rows[this.r] = []);
      row[this.c++] = ch;
      if (w === 2) row[this.c++] = ''; // continuation cell of a wide char
    }
  }
}
