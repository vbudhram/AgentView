import { describe, it, expect } from 'vitest';
import { bandOf, stabilizeOrder } from '../src/lib/stable-order';
import type { SessionSummary } from '../src/lib/ui-types';

const sum = (key: string, status: SessionSummary['status'], approvalLikely = false): SessionSummary => ({
  key, agent: 'claude', sessionId: null, cwd: `/${key}`, source: 'terminal',
  title: null, lastActivity: '2026-08-31T10:00:00Z', status, steerable: false,
  wrapperOutdated: false, eventCount: 1, approvalLikely, lastTool: null,
  gitBranch: null, now: null, spinner: null,
});

const entry = (s: SessionSummary, muted = false) => ({ s, band: bandOf(s, muted) });

describe('bandOf', () => {
  it('maps the triage tiers, with muted alarms one band down', () => {
    expect(bandOf(sum('a', 'needs_input'), false)).toBe(0);
    expect(bandOf(sum('a', 'needs_input'), true)).toBe(1);
    expect(bandOf(sum('a', 'blocked', true), false)).toBe(0);
    expect(bandOf(sum('a', 'waiting'), false)).toBe(2);
    expect(bandOf(sum('a', 'working'), false)).toBe(3);
    expect(bandOf(sum('a', 'blocked'), false)).toBe(3);
    expect(bandOf(sum('a', 'idle'), false)).toBe(4);
    expect(bandOf(sum('a', 'ended'), false)).toBe(5);
  });
});

describe('stabilizeOrder', () => {
  it('adopts the incoming order on first render without arming the guard', () => {
    const next = [entry(sum('a', 'waiting')), entry(sum('b', 'working'))];
    const { order, changed } = stabilizeOrder(null, next);
    expect(order.map((s) => s.key)).toEqual(['a', 'b']);
    expect(changed).toBe(false);
  });

  // The wrong-tap regression guard: recency drift must never move rows.
  it('keeps the previous order when only recency shuffles rows inside a band', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const next = [entry(sum('b', 'waiting')), entry(sum('a', 'waiting'))];
    const { order, changed } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['a', 'b']);
    expect(changed).toBe(false);
  });

  it('refreshes row data even while the order is frozen', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const freshB = { ...sum('b', 'waiting'), now: 'said: done' };
    const { order } = stabilizeOrder(prev, [{ s: freshB, band: 2 }, entry(sum('a', 'waiting'))]);
    expect(order.find((s) => s.key === 'b')?.now).toBe('said: done');
  });

  it('adopts the new order and arms the guard when a session switches band', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const next = [entry(sum('b', 'needs_input')), entry(sum('a', 'waiting'))];
    const { order, changed } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['b', 'a']);
    expect(changed).toBe(true);
  });

  it('does not arm the guard on a band change that moves nothing', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const next = [entry(sum('a', 'needs_input')), entry(sum('b', 'waiting'))];
    const { order, changed } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['a', 'b']);
    expect(changed).toBe(false);
  });

  it('resorts when a session appears', () => {
    const prev = [{ key: 'a', band: 2 }];
    const next = [entry(sum('c', 'needs_input')), entry(sum('a', 'waiting'))];
    const { order, changed } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['c', 'a']);
    expect(changed).toBe(true);
  });

  it('resorts when a session leaves', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const next = [entry(sum('b', 'waiting'))];
    const { order, changed } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['b']);
    expect(changed).toBe(true);
  });

  it('treats an ended transition as a band change (row moves to Recent)', () => {
    const prev = [{ key: 'a', band: 2 }, { key: 'b', band: 2 }];
    const next = [entry(sum('a', 'waiting')), entry(sum('b', 'ended'))];
    const { changed, order } = stabilizeOrder(prev, next);
    expect(order.map((s) => s.key)).toEqual(['a', 'b']);
    expect(changed).toBe(false); // same positions, no guard needed
  });
});
