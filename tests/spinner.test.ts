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
});
