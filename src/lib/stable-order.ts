'use client';
import { useMemo, useRef } from 'react';
import type { SessionSummary, SourceKind } from './ui-types';
import { demoteMutedAlarms, isAlarm, isMuted, useMuteVersion } from './mute';

// Display bands mirror the list's triage tiers. A row that switches band is
// the only event that may reorder the visible list.
export function bandOf(s: SessionSummary, muted: boolean): number {
  if (isAlarm(s)) return muted ? 1 : 0;
  if (s.status === 'waiting') return 2;
  if (s.status === 'working' || s.status === 'blocked') return 3;
  if (s.status === 'idle') return 4;
  return 5; // ended
}

export interface OrderedEntry { key: string; band: number }

// The server re-sorts on every data frame, and recency tie-breaks shuffle
// rows continuously. On a phone that moves rows under the user's finger,
// and the tap opens the WRONG session. Freeze the displayed order: adopt a
// new order only when membership changes (a session appears, leaves, or
// switches band). Recency drift inside a band keeps the previous order.
export function stabilizeOrder(
  prev: OrderedEntry[] | null,
  next: { s: SessionSummary; band: number }[],
): { order: SessionSummary[]; changed: boolean } {
  const prevBands = new Map((prev ?? []).map((p) => [p.key, p.band]));
  const material = prev === null
    || prev.length !== next.length
    || next.some(({ s, band }) => prevBands.get(s.key) !== band);
  if (!material) {
    // same membership, same bands: keep the previous order, refresh the data
    const byKey = new Map(next.map((n) => [n.s.key, n.s]));
    return { order: (prev as OrderedEntry[]).map((p) => byKey.get(p.key)!), changed: false };
  }
  const order = next.map((n) => n.s);
  // `changed` means a row actually moved; it arms the tap guard.
  const changed = prev !== null && order.some((s, i) => prev[i]?.key !== s.key);
  return { order, changed };
}

// One stabilized order for the whole app: the nav rows and the keyboard
// cycle must agree on it. `orderChangedAt` stamps the last real reorder so
// a tap that lands mid-shuffle can be ignored.
export function useStableSessionOrder(
  sessions: SessionSummary[],
  filter: SourceKind | 'all',
): { visible: SessionSummary[]; orderChangedAt: number } {
  const prev = useRef<OrderedEntry[] | null>(null);
  const changedAt = useRef(0);
  const muteVersion = useMuteVersion();
  return useMemo(() => {
    const withBands = demoteMutedAlarms(
      sessions.filter((s) => filter === 'all' || s.source === filter),
    ).map((s) => ({ s, band: bandOf(s, isMuted(s.key, s.lastActivity)) }));
    const { order, changed } = stabilizeOrder(prev.current, withBands);
    const bands = new Map(withBands.map(({ s, band }) => [s.key, band]));
    prev.current = order.map((s) => ({ key: s.key, band: bands.get(s.key)! }));
    if (changed) changedAt.current = Date.now();
    return { visible: order, orderChangedAt: changedAt.current };
    // muteVersion invalidates bands when an alarm is (un)acknowledged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, filter, muteVersion]);
}
