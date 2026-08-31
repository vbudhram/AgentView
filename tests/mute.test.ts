import { describe, it, expect } from 'vitest';
import { demoteMutedAlarms, isAlarm } from '../src/lib/mute';
import type { SessionSummary } from '../src/lib/ui-types';

const sum = (key: string, status: SessionSummary['status'], approvalLikely = false): SessionSummary => ({
  key, agent: 'claude', sessionId: null, cwd: `/${key}`, source: 'terminal',
  title: null, lastActivity: '2026-08-26T10:00:00Z', status, steerable: false,
  wrapperOutdated: false, eventCount: 1, approvalLikely, lastTool: null,
  gitBranch: null, now: null, spinner: null,
});

describe('isAlarm', () => {
  it('alarms on needs_input and escalated approvals only', () => {
    expect(isAlarm(sum('a', 'needs_input'))).toBe(true);
    expect(isAlarm(sum('b', 'blocked', true))).toBe(true);
    expect(isAlarm(sum('c', 'blocked'))).toBe(false);
    expect(isAlarm(sum('d', 'waiting'))).toBe(false);
    expect(isAlarm(sum('e', 'working'))).toBe(false);
  });
});

describe('demoteMutedAlarms', () => {
  it('drops muted alarms below unmuted alarms but above the calm bands', () => {
    const list = [
      sum('muted-ask', 'needs_input'),
      sum('loud-ask', 'needs_input'),
      sum('approve', 'blocked', true),
      sum('waiting', 'waiting'),
      sum('working', 'working'),
    ];
    const muted = (key: string) => key === 'muted-ask';
    expect(demoteMutedAlarms(list, muted).map((s) => s.key))
      .toEqual(['loud-ask', 'approve', 'muted-ask', 'waiting', 'working']);
  });

  it('keeps the order untouched when nothing is muted', () => {
    const list = [sum('a', 'needs_input'), sum('b', 'waiting'), sum('c', 'ended')];
    expect(demoteMutedAlarms(list, () => false).map((s) => s.key)).toEqual(['a', 'b', 'c']);
  });
});
