import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/lib/store';
import type { ParsedLine } from '../src/lib/types';

const at = (iso: string, text: string): ParsedLine => ({
  events: [{ kind: 'user_message', ts: iso, text }],
  meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
});

describe('SessionStore', () => {
  it('creates a session, sets title from first user message', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'Fix the bug'));
    const [sum] = s.summaries(new Date('2026-08-26T10:00:10Z'));
    expect(sum).toMatchObject({ key: 'claude:f1', title: 'Fix the bug', status: 'working', eventCount: 1 });
  });

  it('computes ended vs alive statuses from cwds and the last event', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'x'));
    const later = new Date('2026-08-26T10:05:00Z');
    expect(s.summaries(later)[0].status).toBe('ended');
    s.setAliveCwds(new Set(['/p']));
    // last event is a user_message -> idle
    expect(s.summaries(later)[0].status).toBe('idle');
    // last event assistant_message -> needs_input
    s.apply('claude', 'f1', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:01Z', text: 'done' }] });
    expect(s.summaries(later)[0].status).toBe('needs_input');
    // last event tool_call without result -> blocked
    s.apply('claude', 'f1', { events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:02Z', name: 'Bash', input: '{}' }] });
    expect(s.summaries(later)[0].status).toBe('blocked');
  });

  it('drops sessions older than 24h from summaries', () => {
    const s = new SessionStore();
    s.apply('claude', 'old', at('2026-08-24T10:00:00Z', 'x'));
    expect(s.summaries(new Date('2026-08-26T10:00:00Z'))).toHaveLength(0);
  });

  it('skips markup-ish user messages when picking the title', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', { events: [
      { kind: 'user_message', ts: '2026-08-26T10:00:00Z', text: '<local-command-caveat>stuff</local-command-caveat>' },
      { kind: 'user_message', ts: '2026-08-26T10:00:01Z', text: 'Caveat: the messages below were generated' },
      { kind: 'user_message', ts: '2026-08-26T10:00:02Z', text: 'Fix the login bug' },
    ] });
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].title).toBe('Fix the login bug');
  });

  it('stores gitBranch from meta on the summary', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'user_message', ts: '2026-08-26T10:00:00Z', text: 'x' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal', gitBranch: 'FXA-13867' },
    });
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].gitBranch).toBe('FXA-13867');
  });

  it('computes a working now-line from the latest tool call', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: JSON.stringify({ command: 'npm test' }) },
    ] });
    // within 30s -> working
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0]).toMatchObject({ status: 'working', now: 'Bash: npm test' });
    s.apply('claude', 'f1', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:05Z', name: 'Edit', input: JSON.stringify({ file_path: '/a/b/store.ts', old_string: 'x' }) },
    ] });
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].now).toBe('Edit: store.ts');
    s.apply('claude', 'f1', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:06Z', name: 'Grep', input: '{"pattern":"foo"}' },
    ] });
    // structured input is humanized, never raw JSON
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].now).toBe('Grep: foo');
  });

  it('humanizes agent-style tool calls and mcp tool names in the now-line', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Agent', input: JSON.stringify({ description: 'Critic round 2', prompt: 'long...' }) },
    ] });
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].now).toBe('Agent: Critic round 2');
    s.apply('claude', 'f2', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'mcp__plugin_x_y__get_observations', input: '{"unknown":1}' },
    ] });
    const sums = s.summaries(new Date('2026-08-26T10:00:10Z'));
    expect(sums.find((x) => x.key === 'claude:f2')?.now).toBe('get_observations');
  });

  it('computes a needs_input now-line from the last assistant message', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Done.\nShould I also update the tests?' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCwds(new Set(['/p']));
    const [sum] = s.summaries(new Date('2026-08-26T10:05:00Z'));
    expect(sum.status).toBe('needs_input');
    expect(sum.now).toBe('asked: Should I also update the tests?');
  });

  it('truncates a long ask from the head at a word boundary with a trailing ellipsis', () => {
    const s = new SessionStore();
    const long = 'Want me to fix it? The minimal change is to key every row by session id and let the group assignment be a render property instead of a separate mount point entirely.';
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: long }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCwds(new Set(['/p']));
    const now = s.summaries(new Date('2026-08-26T10:05:00Z'))[0].now!;
    expect(now.startsWith('asked: Want me to fix it?')).toBe(true);
    expect(now.endsWith('…')).toBe(true);
    expect(now.length).toBeLessThanOrEqual('asked: '.length + 121);
    // never cut mid-word: the char before the ellipsis ends a whole word from the source
    const body = now.slice('asked: '.length, -1);
    expect(long.startsWith(body)).toBe(true);
    expect(long[body.length]).toBe(' ');
  });

  it('computes a blocked now-line from the pending tool call', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: JSON.stringify({ command: 'rm -rf build' }) }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCwds(new Set(['/p']));
    const [sum] = s.summaries(new Date('2026-08-26T10:05:00Z'));
    expect(sum.status).toBe('blocked');
    expect(sum.now).toBe('wants: Bash: rm -rf build');
  });

  it('leaves now null for idle and ended sessions', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'x'));
    const later = new Date('2026-08-26T10:05:00Z');
    expect(s.summaries(later)[0]).toMatchObject({ status: 'ended', now: null });
    s.setAliveCwds(new Set(['/p']));
    expect(s.summaries(later)[0]).toMatchObject({ status: 'idle', now: null });
  });

  it('emits events and finds sessions by agent+cwd', () => {
    const s = new SessionStore();
    const got: string[] = [];
    s.on('events', ({ key }) => got.push(key));
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'x'));
    expect(got).toEqual(['claude:f1']);
    expect(s.findKeyByAgentCwd('claude', '/p')).toBe('claude:f1');
    expect(s.findKeyByAgentCwd('codex', '/p')).toBeNull();
  });
});
