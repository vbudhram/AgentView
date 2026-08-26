import { describe, it, expect } from 'vitest';
import { parsePsForAgents } from '../src/lib/proc';

const PS = [
  '  123 /Users/x/.local/bin/claude --resume abc',
  '  124 /Applications/Claude.app/Contents/MacOS/Claude',
  '  125 codex exec something',
  '  126 /usr/bin/grep claude',
  '  127 node server.mjs',
].join('\n');

describe('parsePsForAgents', () => {
  it('matches claude and codex CLI binaries only', () => {
    expect(parsePsForAgents(PS)).toEqual([123, 125]);
  });
});
