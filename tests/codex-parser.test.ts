import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCodexLine } from '../src/lib/parsers/codex';

const lines = readFileSync('tests/fixtures/codex-sample.jsonl', 'utf8').trim().split('\n');

describe('parseCodexLine', () => {
  it('extracts meta from session_meta', () => {
    const { meta, events } = parseCodexLine(lines[0]);
    expect(meta).toEqual({ sessionId: 'c-thread-1', cwd: '/Users/x/proj2', source: 'codex' });
    expect(events).toEqual([]);
  });

  it('maps task lifecycle event_msg to turn_status', () => {
    expect(parseCodexLine(lines[1]).events[0]).toMatchObject({ kind: 'turn_status', status: 'started' });
    expect(parseCodexLine(lines[7]).events[0]).toMatchObject({ kind: 'turn_status', status: 'completed' });
  });

  it('maps user and assistant messages', () => {
    expect(parseCodexLine(lines[2]).events[0]).toMatchObject({ kind: 'user_message', text: 'Refactor the parser' });
    expect(parseCodexLine(lines[6]).events[0]).toMatchObject({ kind: 'assistant_message', text: 'Done.' });
  });

  it('skips developer/system role messages', () => {
    const dev = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'internal' }] } });
    expect(parseCodexLine(dev).events).toEqual([]);
  });

  it('maps reasoning, function_call, function_call_output', () => {
    expect(parseCodexLine(lines[3]).events[0]).toMatchObject({ kind: 'thinking', text: 'Plan the refactor' });
    expect(parseCodexLine(lines[4]).events[0]).toMatchObject({ kind: 'tool_call', name: 'shell' });
    expect(parseCodexLine(lines[5]).events[0]).toMatchObject({ kind: 'tool_result', output: 'file.ts', isError: false });
  });

  it('returns no events for malformed lines', () => {
    expect(parseCodexLine('garbage').events).toEqual([]);
  });

  it('returns no events for a valid JSON line that is not an object', () => {
    expect(() => parseCodexLine(lines[8])).not.toThrow();
    expect(parseCodexLine(lines[8]).events).toEqual([]);
  });
});
