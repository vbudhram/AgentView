'use client';
import { useSyncExternalStore } from 'react';
import type { SessionSummary } from './ui-types';

// Client-side needs-you acknowledgement. Muting stores the session's
// lastActivity stamp; any new activity changes the stamp, so the mute
// expires on its own the moment the session does something new.

const PREFIX = 'agentview.mute.';

const listeners = new Set<() => void>();
let version = 0;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isMuted(key: string, lastActivity: string): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem(PREFIX + key) === lastActivity; } catch { return false; }
}

export function setMuted(key: string, lastActivity: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(PREFIX + key, lastActivity);
    else localStorage.removeItem(PREFIX + key);
  } catch {}
  version++;
  listeners.forEach((l) => l());
}

// Subscribing components re-render whenever any mute changes.
export function useMuteVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function isAlarm(s: Pick<SessionSummary, 'status' | 'approvalLikely'>): boolean {
  return s.status === 'needs_input' || s.approvalLikely;
}

// Display order: an acknowledged (muted) alarm must never outrank an
// unacknowledged one — it drops to the bottom of the alarm band. The rest
// of the list keeps the server's order. Stable within each part.
export function demoteMutedAlarms(
  list: SessionSummary[],
  muted: (key: string, lastActivity: string) => boolean = isMuted,
): SessionSummary[] {
  const loud: SessionSummary[] = [];
  const acked: SessionSummary[] = [];
  const rest: SessionSummary[] = [];
  for (const s of list) {
    if (!isAlarm(s)) rest.push(s);
    else if (muted(s.key, s.lastActivity)) acked.push(s);
    else loud.push(s);
  }
  return [...loud, ...acked, ...rest];
}
