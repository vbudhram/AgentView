import { describe, it, expect } from 'vitest';
import { plainText, stripAnsi } from '../src/lib/describe';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('strips color and cursor CSI sequences', () => {
    expect(stripAnsi(`${ESC}[32m[PM2]${ESC}[39m done ${ESC}[1;31mfail${ESC}[0m`))
      .toBe('[PM2] done fail');
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress 50%`)).toBe('progress 50%');
  });

  it('strips OSC title sequences and stray escapes', () => {
    expect(stripAnsi(`${ESC}]0;my titlehello`)).toBe('hello');
    expect(stripAnsi(`a${ESC}Mb`)).toBe('ab');
  });

  it('leaves plain text and bare brackets alone', () => {
    expect(stripAnsi('arr[0] = [32m no escape here')).toBe('arr[0] = [32m no escape here');
  });
});

describe('plainText', () => {
  it('strips ANSI before markup cleanup', () => {
    expect(plainText(`${ESC}[32m**bold**${ESC}[0m \`code\``)).toBe('bold code');
  });
});
