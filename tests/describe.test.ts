import { describe, it, expect } from 'vitest';
import { classifySystemNote, plainText, stripAnsi } from '../src/lib/describe';

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


describe('classifySystemNote', () => {
  it('classifies task-notification wrappers and extracts the summary', () => {
    const note = classifySystemNote(
      '<task-notification>\n<task-id>bgu3</task-id>\n<status>stopped</status>\n<summary>Agent finished the audit</summary>\n</task-notification>',
    );
    expect(note?.tag).toBe('task-notification');
    expect(note?.summary).toBe('Agent finished the audit');
  });

  it('classifies system-reminder and command wrappers', () => {
    expect(classifySystemNote('<system-reminder>context low</system-reminder>')?.tag).toBe('system-reminder');
    expect(classifySystemNote('<command-name>/compact</command-name>\n<command-message>compact</command-message>')?.tag).toBe('command-name');
    expect(classifySystemNote('<local-command-stdout>ok</local-command-stdout>')?.tag).toBe('local-command-stdout');
  });

  it('classifies unknown hyphenated tags only when they wrap the whole message', () => {
    expect(classifySystemNote('<foo-wrapper>stuff</foo-wrapper>')?.tag).toBe('foo-wrapper');
    expect(classifySystemNote('<foo-wrapper>unclosed leading tag then my real question')).toBeNull();
  });

  it('classifies Caveat: preambles', () => {
    expect(classifySystemNote('Caveat: the messages below were generated during local commands')?.tag).toBe('caveat');
  });

  it('leaves genuine user text alone, including pasted HTML', () => {
    expect(classifySystemNote('fix the login bug please')).toBeNull();
    expect(classifySystemNote('<div>why does this render wrong?</div>')).toBeNull();
    expect(classifySystemNote('here is the error I saw')).toBeNull();
  });
});

import { describeToolCall, describeToolResult, shortenPaths } from '../src/lib/describe';

describe('describeToolCall', () => {
  it('prefers the Bash description over the raw command', () => {
    expect(describeToolCall('Bash', JSON.stringify({ command: 'S=/tmp/x node run.mjs', description: 'Run the loop driver' })))
      .toBe('Bash: Run the loop driver');
  });

  it('strips leading env assignments and cd prefixes from commands', () => {
    expect(describeToolCall('Bash', JSON.stringify({ command: 'S=/private/tmp/claude-501/-Users-vi FOO="a b" node bin/av.mjs claude' })))
      .toBe('Bash: node bin/av.mjs claude');
    expect(describeToolCall('Bash', JSON.stringify({ command: 'cd /Users/x/repo && S=1 npm test' })))
      .toBe('Bash: npm test');
  });
});

describe('describeToolResult', () => {
  it('reports shape and basenames the first line', () => {
    expect(describeToolResult('The file /Users/vijaybudham/Desktop/working/agentview/src/lib/store.ts has been updated\nmore\nmore'))
      .toBe('3 lines · The file store.ts has been updated');
  });

  it('handles empty, single-line, and error outputs', () => {
    expect(describeToolResult('   ')).toBe('(empty)');
    expect(describeToolResult('ok')).toBe('ok');
    expect(describeToolResult('boom\ntrace', true)).toBe('error · 2 lines · boom');
  });

  it('reports size for one huge line', () => {
    expect(describeToolResult('x'.repeat(2048))).toMatch(/^2\.0KB · x+…$/);
  });
});

describe('shortenPaths', () => {
  it('keeps relative paths and bare words alone', () => {
    expect(shortenPaths('src/lib/store.ts and a/b')).toBe('src/lib/store.ts and a/b');
  });
});
