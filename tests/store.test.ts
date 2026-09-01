import { describe, it, expect } from 'vitest';
import { SessionStore, asksQuestion, isIgnoredCwd } from '../src/lib/store';
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
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    // last event is a user_message -> idle
    expect(s.summaries(later)[0].status).toBe('idle');
    // last event a statement assistant_message -> waiting (no ask, no alarm)
    s.apply('claude', 'f1', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:01Z', text: 'done' }] });
    expect(s.summaries(later)[0].status).toBe('waiting');
    // a trailing question -> needs_input
    s.apply('claude', 'f1', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:01.500Z', text: 'Ship it?' }] });
    expect(s.summaries(later)[0].status).toBe('needs_input');
    // last event tool_call without result -> blocked
    s.apply('claude', 'f1', { events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:02Z', name: 'Bash', input: '{}' }] });
    expect(s.summaries(later)[0].status).toBe('blocked');
  });

  it('surfaces an ask within the short settle window, not after 30s', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Do you prefer red or blue?' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    // still settling at +3s: no flap yet
    expect(s.summaries(new Date('2026-08-26T10:00:03Z'))[0].status).toBe('working');
    // at +6s the ask is live -- no 30s wait
    expect(s.summaries(new Date('2026-08-26T10:00:06Z'))[0].status).toBe('needs_input');
  });

  it('does not alarm when a tool call follows the assistant message moments later', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [
        { kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Should I run the tests?' },
        { kind: 'tool_call', ts: '2026-08-26T10:00:02Z', name: 'Bash', input: '{}' },
      ],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    // mid-stream tool activity keeps the full recency window: working, no alarm
    expect(s.summaries(new Date('2026-08-26T10:00:06Z'))[0].status).toBe('working');
    expect(s.summaries(new Date('2026-08-26T10:00:20Z'))[0].status).toBe('working');
  });

  it('clears the alarm within the settle window after the agent resumes and finishes', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Red or blue?' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    expect(s.summaries(new Date('2026-08-26T10:00:06Z'))[0].status).toBe('needs_input');
    // the user answered; the agent acknowledged with a statement
    s.apply('claude', 'f1', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:30Z', text: 'acknowledged' }] });
    expect(s.summaries(new Date('2026-08-26T10:00:36Z'))[0].status).toBe('waiting');
  });

  it('ended detection is not delayed by the settle window', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'done' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    // no live process -> ended as soon as the settle window passes
    expect(s.summaries(new Date('2026-08-26T10:00:06Z'))[0].status).toBe('ended');
  });

  it('ignores tool-machinery and scratch directories', () => {
    const home = require('node:os').homedir();
    expect(isIgnoredCwd(`${home}/.claude-mem/observer-sessions`)).toBe(true);
    expect(isIgnoredCwd(`${home}/.codex/sessions`)).toBe(true);
    expect(isIgnoredCwd('/private/tmp/agentview-loop-t1')).toBe(true);
    // a real project keeps showing, including one that merely starts alike
    expect(isIgnoredCwd(`${home}/Desktop/working/agentview`)).toBe(false);
    expect(isIgnoredCwd(`${home}/.claude-mem-notes`)).toBe(false);
    expect(isIgnoredCwd(null)).toBe(false);
  });

  it('never creates a session for an ignored directory', () => {
    const s = new SessionStore();
    const home = require('node:os').homedir();
    s.apply('claude', 'obs', {
      events: [{ kind: 'user_message', ts: '2026-08-26T10:00:00Z', text: 'internal' }],
      meta: { sessionId: 'o1', cwd: `${home}/.claude-mem/observer-sessions`, source: 'terminal' },
    });
    expect(s.summaries(new Date('2026-08-26T10:00:05Z'))).toHaveLength(0);
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
    s.setAliveCounts(new Map([['claude:/p', 1]]));
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
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    const now = s.summaries(new Date('2026-08-26T10:05:00Z'))[0].now!;
    expect(now.startsWith('asked: Want me to fix it?')).toBe(true);
    expect(now.endsWith('…')).toBe(true);
    expect(now.length).toBeLessThanOrEqual('asked: '.length + 121);
    // never cut mid-word: the char before the ellipsis ends a whole word from the source
    const body = now.slice('asked: '.length, -1);
    expect(long.startsWith(body)).toBe(true);
    expect(long[body.length]).toBe(' ');
  });

  it('presents a pending tool call as running, never as an approval claim', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: JSON.stringify({ command: 'rm -rf build' }) }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    const [sum] = s.summaries(new Date('2026-08-26T10:05:00Z'));
    expect(sum.status).toBe('blocked');
    expect(sum.now).toBe('running Bash: rm -rf build');
  });

  it('labels a non-question waiting message with said:, and strips cd prefixes from commands', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Nothing to squash, and nothing to push.' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    const [w] = s.summaries(new Date('2026-08-26T10:05:00Z'));
    expect(w.status).toBe('waiting');
    expect(w.now).toBe('said: Nothing to squash, and nothing to push.');
    s.apply('claude', 'f2', { events: [
      { kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: JSON.stringify({ command: 'cd /Users/me/proj && npm test' }) },
    ] });
    const f2 = s.summaries(new Date('2026-08-26T10:00:10Z')).find((x) => x.key === 'claude:f2');
    expect(f2?.now).toBe('Bash: npm test');
  });

  it('pins needs_input on top; a pending tool call sits in the working band', () => {
    const s = new SessionStore();
    const ev = (kind: 'tool_call' | 'assistant_message' | 'user_message', ts: string): ParsedLine => ({
      events: [kind === 'tool_call'
        ? { kind, ts, name: 'Bash', input: '{}' }
        : { kind, ts, text: 'x' }],
    });
    s.apply('claude', 'working', { events: [{ kind: 'user_message', ts: '2026-08-26T10:04:50Z', text: 'x' }], meta: { sessionId: 'w', cwd: '/w', source: 'terminal' } });
    s.apply('claude', 'blocked', { events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: '{}' }], meta: { sessionId: 'b', cwd: '/b', source: 'terminal' } });
    s.apply('claude', 'needs', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:03:00Z', text: 'done?' }], meta: { sessionId: 'n', cwd: '/n', source: 'terminal' } });
    s.apply('claude', 'idle', { events: [{ kind: 'user_message', ts: '2026-08-26T10:02:00Z', text: 'x' }], meta: { sessionId: 'i', cwd: '/i', source: 'terminal' } });
    s.apply('claude', 'ended', ev('assistant_message', '2026-08-26T10:04:00Z'));
    s.setAliveCounts(new Map([['claude:/w', 1], ['claude:/b', 1], ['claude:/n', 1], ['claude:/i', 1]]));
    const order = s.summaries(new Date('2026-08-26T10:05:00Z')).map((x) => x.key);
    // needs_input pins the top; blocked shares the working band (recency inside it)
    expect(order).toEqual(['claude:needs', 'claude:working', 'claude:blocked', 'claude:idle', 'claude:ended']);
  });

  it('never ranks a long-pending tool call above a needs_input session', () => {
    const s = new SessionStore();
    // pending tool with fresher activity than the needs_input session
    s.apply('claude', 'pending', { events: [{ kind: 'tool_call', ts: '2026-08-26T10:04:00Z', name: 'Bash', input: '{}' }], meta: { sessionId: 'p', cwd: '/pnd', source: 'terminal' } });
    s.apply('claude', 'needs', { events: [{ kind: 'assistant_message', ts: '2026-08-26T09:30:00Z', text: 'done?' }], meta: { sessionId: 'n', cwd: '/n', source: 'terminal' } });
    s.setAliveCounts(new Map([['claude:/pnd', 1], ['claude:/n', 1]]));
    const order = s.summaries(new Date('2026-08-26T10:20:00Z')).map((x) => x.key);
    expect(order).toEqual(['claude:needs', 'claude:pending']);
  });

  it('leaves now null for idle and ended sessions', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'x'));
    const later = new Date('2026-08-26T10:05:00Z');
    expect(s.summaries(later)[0]).toMatchObject({ status: 'ended', now: null });
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    expect(s.summaries(later)[0]).toMatchObject({ status: 'idle', now: null });
  });

  it('sets the spinner, no-ops on the same value, and clears with null', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'x'));
    const got: string[] = [];
    s.on('events', ({ key }) => got.push(key));
    s.setSpinner('claude:f1', 'Undulating… (34s · ↓ 46 tokens)');
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].spinner).toBe('Undulating… (34s · ↓ 46 tokens)');
    s.setSpinner('claude:f1', 'Undulating… (34s · ↓ 46 tokens)'); // unchanged -> no emit
    s.setSpinner('claude:missing', 'x'); // unknown key -> no-op
    s.setSpinner('claude:f1', null);
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].spinner).toBeNull();
    expect(got).toEqual(['claude:f1', 'claude:f1']);
  });

  it('marks only the most recent session in an alive cwd as alive', () => {
    const s = new SessionStore();
    const msg = (iso: string) => ({
      events: [{ kind: 'assistant_message' as const, ts: iso, text: 'done' }],
      meta: { sessionId: 'x', cwd: '/p', source: 'terminal' as const },
    });
    s.apply('claude', 'old', msg('2026-08-26T08:00:00Z'));
    s.apply('claude', 'new', msg('2026-08-26T10:00:00Z'));
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    const later = new Date('2026-08-26T10:05:00Z');
    const by = Object.fromEntries(s.summaries(later).map((x) => [x.key, x.status]));
    expect(by['claude:new']).toBe('waiting');
    expect(by['claude:old']).toBe('ended');
  });

  it('marks the N most recent sessions alive when N processes share a cwd', () => {
    const s = new SessionStore();
    const msg = (iso: string) => ({
      events: [{ kind: 'assistant_message' as const, ts: iso, text: 'done' }],
      meta: { sessionId: 'x', cwd: '/p', source: 'terminal' as const },
    });
    s.apply('claude', 'a', msg('2026-08-26T08:00:00Z'));
    s.apply('claude', 'b', msg('2026-08-26T09:00:00Z'));
    s.apply('claude', 'c', msg('2026-08-26T10:00:00Z'));
    s.setAliveCounts(new Map([['claude:/p', 2]]));
    const later = new Date('2026-08-26T10:05:00Z');
    const by = Object.fromEntries(s.summaries(later).map((x) => [x.key, x.status]));
    // two live processes in /p: the two most recent sessions are alive
    expect(by['claude:c']).toBe('waiting');
    expect(by['claude:b']).toBe('waiting');
    expect(by['claude:a']).toBe('ended');
    // counts are per agent kind: a codex process gives no claude session life
    s.setAliveCounts(new Map([['codex:/p', 2]]));
    expect(s.summaries(later).every((x) => x.status === 'ended')).toBe(true);
  });

  it('keeps the first cwd as the session identity when later lines cd elsewhere', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', at('2026-08-26T10:00:00Z', 'start'));
    s.apply('claude', 'f1', {
      events: [{ kind: 'user_message', ts: '2026-08-26T10:01:00Z', text: 'later' }],
      meta: { sessionId: 's1', cwd: '/elsewhere', source: 'terminal' },
    });
    expect(s.summaries(new Date('2026-08-26T10:01:10Z'))[0].cwd).toBe('/p');
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

describe('asksQuestion', () => {
  it('detects a trailing question mark on the last non-empty line', () => {
    expect(asksQuestion('Done.\nShould I also update the tests?')).toBe(true);
    expect(asksQuestion('Which file is canonical?  ')).toBe(true);
    expect(asksQuestion('Is this right?**')).toBe(true);
  });

  it('detects clear ask phrasing in the final two sentences', () => {
    expect(asksQuestion('The fix is ready. Want me to commit it.')).toBe(true);
    expect(asksQuestion('Two options exist. Let me know which you prefer.')).toBe(true);
    expect(asksQuestion('I can do A or B. Please confirm before I continue.')).toBe(true);
  });

  it('treats trailing statements as non-asks', () => {
    expect(asksQuestion("Iteration 1's critic is running. I'll continue automatically when it reports")).toBe(false);
    expect(asksQuestion('Armour builder is still running against the bar. I will report when it lands.')).toBe(false);
    expect(asksQuestion('All tests pass.')).toBe(false);
    expect(asksQuestion('')).toBe(false);
  });

  it('ignores an ask that only appears early in a long message', () => {
    expect(asksQuestion('Should I refactor? I decided yes. I refactored it. All tests pass. The build is green.')).toBe(false);
  });
});

describe('attention tiering', () => {
  const aliveP = new Map([['claude:/p', 1]]);
  const later = new Date('2026-08-26T10:05:00Z');

  it('a completed turn ending in a statement is waiting, not needs_input', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [
        { kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: "I'll continue automatically when it reports" },
        { kind: 'turn_status', ts: '2026-08-26T10:00:01Z', status: 'completed' },
      ],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(aliveP);
    const [sum] = s.summaries(later);
    expect(sum.status).toBe('waiting');
    expect(sum.now).toBe("said: I'll continue automatically when it reports");
  });

  it('a completed turn ending in a question is needs_input', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [
        { kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'Which option do you want?' },
        { kind: 'turn_status', ts: '2026-08-26T10:00:01Z', status: 'completed' },
      ],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(aliveP);
    expect(s.summaries(later)[0].status).toBe('needs_input');
  });

  it('a completed turn with no assistant message is waiting', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'turn_status', ts: '2026-08-26T10:00:00Z', status: 'completed' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal' },
    });
    s.setAliveCounts(aliveP);
    expect(s.summaries(later)[0].status).toBe('waiting');
  });
});

describe('approval escalation', () => {
  const pending = (cwd: string): Parameters<SessionStore['apply']>[2] => ({
    events: [{ kind: 'tool_call', ts: '2026-08-26T10:00:00Z', name: 'Bash', input: '{}' }],
    meta: { sessionId: 'x', cwd, source: 'terminal' },
  });

  it('escalates a steerable pending tool whose spinner has been dead 90s', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', pending('/p'));
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    s.setSteerable('claude:f1', true);
    s.setSpinner('claude:f1', 'Working…', new Date('2026-08-26T10:00:30Z'));
    s.setSpinner('claude:f1', null, new Date('2026-08-26T10:01:00Z'));
    // 60s after the spinner died: still calm
    let [sum] = s.summaries(new Date('2026-08-26T10:02:00Z'));
    expect(sum.status).toBe('blocked');
    expect(sum.approvalLikely).toBe(false);
    // 90s after: escalated
    [sum] = s.summaries(new Date('2026-08-26T10:02:30Z'));
    expect(sum.status).toBe('blocked');
    expect(sum.approvalLikely).toBe(true);
  });

  it('stays calm while the spinner is live, and for non-steerable sessions', () => {
    const s = new SessionStore();
    s.apply('claude', 'live', pending('/a'));
    s.apply('claude', 'plain', pending('/b'));
    s.setAliveCounts(new Map([['claude:/a', 1], ['claude:/b', 1]]));
    s.setSteerable('claude:live', true);
    s.setSpinner('claude:live', 'Working… (5m)');
    const sums = s.summaries(new Date('2026-08-26T10:20:00Z'));
    for (const sum of sums) {
      expect(sum.status).toBe('blocked');
      expect(sum.approvalLikely).toBe(false);
    }
  });

  it('escalates a steerable session that never reported a spinner after 90s of pending', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', pending('/p'));
    s.setAliveCounts(new Map([['claude:/p', 1]]));
    s.setSteerable('claude:f1', true);
    expect(s.summaries(new Date('2026-08-26T10:01:00Z'))[0].approvalLikely).toBe(false);
    expect(s.summaries(new Date('2026-08-26T10:01:30Z'))[0].approvalLikely).toBe(true);
  });

  it('sorts: needs_input, then escalated approvals, then waiting, working, idle, ended', () => {
    const s = new SessionStore();
    s.apply('claude', 'needs', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:00:00Z', text: 'ok?' }], meta: { sessionId: 'n', cwd: '/n', source: 'terminal' } });
    s.apply('claude', 'approve', { events: [{ kind: 'tool_call', ts: '2026-08-26T10:03:00Z', name: 'Bash', input: '{}' }], meta: { sessionId: 'a', cwd: '/a', source: 'terminal' } });
    s.apply('claude', 'waiting', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:04:00Z', text: 'All done.' }], meta: { sessionId: 'w', cwd: '/w', source: 'terminal' } });
    s.apply('claude', 'working', { events: [{ kind: 'user_message', ts: '2026-08-26T10:04:50Z', text: 'x' }], meta: { sessionId: 'g', cwd: '/g', source: 'terminal' } });
    s.apply('claude', 'idle', { events: [{ kind: 'user_message', ts: '2026-08-26T10:02:00Z', text: 'x' }], meta: { sessionId: 'i', cwd: '/i', source: 'terminal' } });
    s.apply('claude', 'ended', { events: [{ kind: 'assistant_message', ts: '2026-08-26T10:01:00Z', text: 'bye' }], meta: { sessionId: 'e', cwd: '/e', source: 'terminal' } });
    s.setAliveCounts(new Map([['claude:/n', 1], ['claude:/a', 1], ['claude:/w', 1], ['claude:/g', 1], ['claude:/i', 1]]));
    s.setSteerable('claude:approve', true);
    const order = s.summaries(new Date('2026-08-26T10:05:00Z')).map((x) => x.key);
    expect(order).toEqual(['claude:needs', 'claude:approve', 'claude:waiting', 'claude:working', 'claude:idle', 'claude:ended']);
  });
});

describe('branch label hygiene', () => {
  it('suppresses a detached-head HEAD branch label', () => {
    const s = new SessionStore();
    s.apply('claude', 'f1', {
      events: [{ kind: 'user_message', ts: '2026-08-26T10:00:00Z', text: 'x' }],
      meta: { sessionId: 's1', cwd: '/p', source: 'terminal', gitBranch: 'HEAD' },
    });
    expect(s.summaries(new Date('2026-08-26T10:00:10Z'))[0].gitBranch).toBeNull();
  });
});
