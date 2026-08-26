import { describe, it, expect } from 'vitest';
import { parseSpinner } from '../src/lib/spinner';

describe('parseSpinner', () => {
  it('extracts a plain spinner line and trims the esc hint', () => {
    expect(parseSpinner('· Undulating… (34s · ↓ 46 tokens · esc to interrupt)'))
      .toBe('Undulating… (34s · ↓ 46 tokens)');
  });

  it('extracts an ANSI-wrapped spinner line', () => {
    const raw = '[38;5;174m✢[39m [1mThinking…[22m [2m(3s · esc to interrupt)[22m';
    expect(parseSpinner(raw)).toBe('Thinking… (3s)');
  });

  it('returns the latest frame from CR-rewritten output', () => {
    const raw = '· Pondering… (1s · esc to interrupt)\r· Pondering… (2s · esc to interrupt)';
    expect(parseSpinner(raw)).toBe('Pondering… (2s)');
  });

  it('handles minute-form elapsed and token counts', () => {
    expect(parseSpinner('* Reticulating… (1m 12s · ↑ 2.3k tokens · esc to interrupt)'))
      .toBe('Reticulating… (1m 12s · ↑ 2.3k tokens)');
  });

  it('returns null for a chunk cut mid-line', () => {
    expect(parseSpinner('· Undula')).toBeNull();
    expect(parseSpinner('· Undulating… (3')).toBeNull();
  });

  it('returns null for codex-style status lines without an ellipsis verb', () => {
    expect(parseSpinner('▌ Working (2s)')).toBeNull();
  });

  it('does not false-positive on ordinary prose parentheses', () => {
    expect(parseSpinner('Done. The fix took a while (about 30 seconds of work).')).toBeNull();
    expect(parseSpinner('What next? (see notes)')).toBeNull();
  });

  it('picks the last spinner when several appear across lines', () => {
    const raw = '· Musing… (4s · esc to interrupt)\n· Musing… (5s · esc to interrupt)\nsome output';
    expect(parseSpinner(raw)).toBe('Musing… (5s)');
  });

  it('keeps a spinner without a token segment intact', () => {
    expect(parseSpinner('✶ Simmering… (7s)')).toBe('Simmering… (7s)');
  });
});
