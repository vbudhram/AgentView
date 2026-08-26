import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseClaudeLine } from '../src/lib/parsers/claude';

const lines = readFileSync('tests/fixtures/claude-sample.jsonl', 'utf8').trim().split('\n');

describe('parseClaudeLine', () => {
  it('parses a plain user message with meta', () => {
    const { events, meta } = parseClaudeLine(lines[0]);
    expect(events).toEqual([{ kind: 'user_message', ts: '2026-08-26T13:28:43.300Z', text: 'Fix the login bug' }]);
    expect(meta).toEqual({ sessionId: 's-1', cwd: '/Users/x/proj', source: 'desktop', gitBranch: null });
  });

  it('parses thinking + text blocks', () => {
    const { events } = parseClaudeLine(lines[1]);
    expect(events.map((e) => e.kind)).toEqual(['thinking', 'assistant_message']);
  });

  it('parses tool_use into tool_call', () => {
    const { events } = parseClaudeLine(lines[2]);
    expect(events[0]).toMatchObject({ kind: 'tool_call', name: 'Read' });
  });

  it('parses tool_result and is not a user_message', () => {
    const { events } = parseClaudeLine(lines[3]);
    expect(events[0]).toMatchObject({ kind: 'tool_result', isError: false });
  });

  it('ignores non-message line types', () => {
    expect(parseClaudeLine(lines[4]).events).toEqual([]);
  });

  it('returns no events for malformed lines', () => {
    expect(parseClaudeLine(lines[5]).events).toEqual([]);
  });

  it('returns no events and does not throw for a non-object JSON value', () => {
    expect(() => parseClaudeLine(lines[6])).not.toThrow();
    expect(parseClaudeLine(lines[6]).events).toEqual([]);
  });

  it('sets source to terminal for a non-desktop entrypoint', () => {
    const { meta } = parseClaudeLine(lines[7]);
    expect(meta?.source).toBe('terminal');
  });

  it('parses gitBranch into meta, null when absent', () => {
    expect(parseClaudeLine(lines[8]).meta?.gitBranch).toBe('FXA-13867');
    expect(parseClaudeLine(lines[0]).meta?.gitBranch).toBeNull();
  });
});
