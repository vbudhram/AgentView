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
