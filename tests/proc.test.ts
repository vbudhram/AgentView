import { describe, it, expect } from 'vitest';
import { parsePsForAgents } from '../src/lib/proc';

const PS = [
  '  123 /Users/x/.local/bin/claude',
  '  124 /Applications/Claude.app/Contents/MacOS/Claude',
  '  125 codex',
  '  126 /usr/bin/grep',
  '  127 node',
  '  128 /Users/x/Library/Application Support/Claude/claude-code/2.1.246/claude.app/Contents/MacOS/claude',
].join('\n');

describe('parsePsForAgents', () => {
  it('matches claude and codex CLI binaries only, with their agent kind', () => {
    expect(parsePsForAgents(PS)).toEqual([
      { pid: 123, agent: 'claude' },
      { pid: 125, agent: 'codex' },
      { pid: 128, agent: 'claude' },
    ]);
  });
});
