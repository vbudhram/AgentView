import { describe, it, expect } from 'vitest';
import { SpinnerScreen, matchSpinner } from '../src/lib/spinner';

const draw = (...chunks: (string | Buffer)[]): SpinnerScreen => {
  const s = new SpinnerScreen();
  for (const c of chunks) s.write(c);
  return s;
};

describe('matchSpinner', () => {
  it('extracts a plain spinner line and trims the esc hint', () => {
    expect(matchSpinner('· Undulating… (34s · ↓ 46 tokens · esc to interrupt)'))
      .toBe('Undulating… (34s · ↓ 46 tokens)');
  });

  it('handles minute-form elapsed and token counts', () => {
    expect(matchSpinner('* Reticulating… (1m 12s · ↑ 2.3k tokens · esc to interrupt)'))
      .toBe('Reticulating… (1m 12s · ↑ 2.3k tokens)');
  });

  it('keeps a spinner without a token segment intact', () => {
    expect(matchSpinner('✶ Simmering… (7s)')).toBe('Simmering… (7s)');
  });

  it('returns null for codex-style status lines without an ellipsis verb', () => {
    expect(matchSpinner('▌ Working (2s)')).toBeNull();
  });

  it('does not false-positive on ordinary prose parentheses', () => {
    expect(matchSpinner('Done. The fix took a while (about 30 seconds of work).')).toBeNull();
    expect(matchSpinner('What next? (see notes)')).toBeNull();
  });
});

// Fidelity of the mirror snapshot: the grid must place characters at the
// same columns a real terminal does, or cursor-addressed repaints interleave
// old and new frames into garbled text (e.g. "lfcalhost" for "localhost").
describe('SpinnerScreen fidelity', () => {
  const line = (s: SpinnerScreen, i: number) => s.snapshot().lines[i];

  it('wide emoji occupy two cells, so repaints land at true columns', () => {
    // Reproduced from a live claude session: "✨ Get 2x more use" is painted,
    // then a repaint addresses a word at its absolute column. A real
    // terminal puts "Get" at column 4 (1-based) because ✨ is width 2.
    const s = new SpinnerScreen(90, 30);
    s.write('✨ Get 2x more use');
    s.write('\u001b[4GGot');
    expect(line(s, 0)).toBe('✨ Got 2x more use');
  });

  it('CJK characters occupy two cells', () => {
    const s = new SpinnerScreen(90, 30);
    s.write('漢字 ok');
    s.write('\u001b[6Gno'); // 1-based col 6 = after 漢字 (4 cells) + space
    expect(line(s, 0)).toBe('漢字 no');
  });

  it('text wraps at the last column instead of vanishing', () => {
    const s = new SpinnerScreen(10, 5);
    s.write('abcdefghijKLM');
    expect(line(s, 0)).toBe('abcdefghij');
    expect(line(s, 1)).toBe('KLM');
  });

  it('defers the wrap: a CR after a full row stays on that row', () => {
    const s = new SpinnerScreen(10, 5);
    s.write('abcdefghij\rX');
    expect(line(s, 0)).toBe('Xbcdefghij');
    // no second row was opened: the wrap stayed deferred
    expect(line(s, 1) ?? '').toBe('');
  });

  it('a wide char that does not fit the row end wraps whole', () => {
    const s = new SpinnerScreen(5, 5);
    s.write('abcd漢');
    expect(line(s, 0)).toBe('abcd');
    expect(line(s, 1)).toBe('漢');
  });

  it('tab advances to the next 8-column stop', () => {
    const s = new SpinnerScreen(40, 5);
    s.write('ab\tc');
    expect(line(s, 0)).toBe('ab      c');
  });

  it('zero-width marks (variation selectors, ZWJ) take no cell', () => {
    const s = new SpinnerScreen(40, 5);
    s.write('a\uFE0F\u200db');
    s.write('\u001b[2GX');
    expect(line(s, 0)).toBe('aX');
  });

  it('save/restore cursor (ESC 7 / ESC 8) round-trips the position', () => {
    const s = new SpinnerScreen(40, 5);
    s.write('\u001b[3;5Habc\u001b7\u001b[1;1Htop\u001b8DEF');
    expect(line(s, 0)).toBe('top');
    expect(line(s, 2)).toBe('    abcDEF');
  });
});

describe('SpinnerScreen', () => {
  it('reads an ANSI-wrapped spinner line off the screen', () => {
    const raw = '\u001b[38;5;174m✢\u001b[39m \u001b[1mThinking…\u001b[22m \u001b[2m(3s · esc to interrupt)\u001b[22m';
    expect(draw(raw).spinner()).toBe('Thinking… (3s)');
  });

  it('applies CR rewrites: the latest frame wins', () => {
    const s = draw('· Pondering… (1s · esc to interrupt)\r· Pondering… (2s · esc to interrupt)');
    expect(s.spinner()).toBe('Pondering… (2s)');
  });

  it('assembles a line from chunks split mid-text', () => {
    const s = draw('· Undula');
    expect(s.spinner()).toBeNull();
    s.write('ting… (34s · ↓ 46 tokens · esc to interrupt)');
    expect(s.spinner()).toBe('Undulating… (34s · ↓ 46 tokens)');
  });

  it('holds back an escape sequence split across chunks', () => {
    const s = draw('\u001b[3');
    s.write('8;5;174m✢ Musing… (4s · esc to interrupt)');
    expect(s.spinner()).toBe('Musing… (4s)');
  });

  it('decodes multibyte characters split across buffers', () => {
    const line = Buffer.from('· Musing… (4s)');
    const cut = line.indexOf(Buffer.from('…')) + 1; // mid-ellipsis
    const s = draw(line.subarray(0, cut), line.subarray(cut));
    expect(s.spinner()).toBe('Musing… (4s)');
  });

  it('applies cell-level cursor-addressed repaints (the seconds digit ticks)', () => {
    const line = '✻ Gusting… (14s · ↓ 729 tokens)';
    const s = draw(`\u001b[15;1H${line}`);
    expect(s.spinner()).toBe('Gusting… (14s · ↓ 729 tokens)');
    // the CLI rewrites only the changed digit at its column (1-based)
    const col = line.indexOf('4') + 1;
    s.write(`\u001b[H\u001b[14B\u001b[${col}G5`);
    expect(s.spinner()).toBe('Gusting… (15s · ↓ 729 tokens)');
  });

  it('clears the spinner when the line is erased', () => {
    const s = draw('✻ Gusting… (14s · ↓ 729 tokens)');
    expect(s.spinner()).not.toBeNull();
    s.write('\r\u001b[K✻ Brewed for 14s · done 3:24 PM');
    expect(s.spinner()).toBeNull();
  });

  it('reset drops everything, including pending partial escapes', () => {
    const s = draw('✻ Gusting… (14s)', '\u001b[3');
    s.reset();
    expect(s.spinner()).toBeNull();
    s.write('✶ Simmering… (7s)');
    expect(s.spinner()).toBe('Simmering… (7s)');
  });

  it('prefers the deepest matching row over stale remnants above it', () => {
    const s = draw('\u001b[5;1H· Musing… (4s · esc to interrupt)');
    s.write('\u001b[20;1H· Musing… (9s · esc to interrupt)');
    expect(s.spinner()).toBe('Musing… (9s)');
  });

  it('scrolls at the bottom row instead of overwriting it', () => {
    const s = new SpinnerScreen(80, 3);
    s.write('one\r\ntwo\r\nthree\r\nfour');
    const snap = s.snapshot();
    expect(snap.lines).toEqual(['two', 'three', 'four']);
    expect(snap.row).toBe(2);
    expect(snap.col).toBe(4);
  });

  it('snapshot reports plain text rows and the cursor position', () => {
    const s = new SpinnerScreen(80, 24);
    s.write('\u001b[1;1Hhello\u001b[3;5H\u001b[32mworld\u001b[0m');
    const snap = s.snapshot();
    expect(snap.lines[0]).toBe('hello');
    expect(snap.lines[2]).toBe('    world');
    expect(snap.row).toBe(2);
    expect(snap.col).toBe(9);
  });

  it('does not leak non-CSI escape sequences into the grid', () => {
    const s = new SpinnerScreen(80, 24);
    // charset designation, keypad mode, and a private CSI must all vanish
    s.write('\u001b(B\u001b=\u001b[>0q\u001b[cok');
    const snap = s.snapshot();
    expect(snap.lines[0]).toBe('ok');
  });

  it('resize keeps the bottom rows and clamps the cursor', () => {
    const s = new SpinnerScreen(80, 5);
    s.write('a\r\nb\r\nc\r\nd\r\ne');
    s.resize(40, 3);
    const snap = s.snapshot();
    expect(snap.lines).toEqual(['c', 'd', 'e']);
    expect(snap.row).toBe(2);
  });
});
