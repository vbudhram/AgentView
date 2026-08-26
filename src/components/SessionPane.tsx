'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { AgentEvent, SessionSummary } from '@/lib/ui-types';
import { ConversationView } from './ConversationView';
import { ActivityFeed } from './ActivityFeed';
import { TerminalView } from './TerminalView';

const TABS = ['conversation', 'activity', 'terminal'] as const;
type Tab = (typeof TABS)[number];

export function SessionPane({ sessionKey, session, liveEvents }: {
  sessionKey: string;
  session: SessionSummary | undefined;
  liveEvents: AgentEvent[];
}) {
  const [snapshot, setSnapshot] = useState<AgentEvent[] | null>(null);
  const [tab, setTab] = useState<Tab>('conversation');
  const tabs = session?.steerable ? TABS : TABS.filter((t) => t !== 'terminal');

  // The terminal tab vanishes when the bridge drops; leave it with it.
  useEffect(() => {
    if (tab === 'terminal' && !session?.steerable) setTab('conversation');
  }, [tab, session?.steerable]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/events`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setSnapshot(Array.isArray(d.events) ? d.events : []); })
      .catch(() => { if (!cancelled) setSnapshot([]); });
    return () => { cancelled = true; };
  }, [sessionKey]);

  // The snapshot is authoritative. Live events are a suffix of the same stream,
  // so find the snapshot tail inside liveEvents and append only what follows it.
  const events = useMemo(() => {
    if (!snapshot) return [];
    if (liveEvents.length === 0) return snapshot;
    if (snapshot.length === 0) return liveEvents;
    const tail = snapshot[snapshot.length - 1];
    let tailKey: string | null = null;
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      // cheap ts precheck; stringify only candidates with a matching timestamp
      if (liveEvents[i].ts !== tail.ts) continue;
      tailKey ??= JSON.stringify(tail);
      if (JSON.stringify(liveEvents[i]) === tailKey) {
        return [...snapshot, ...liveEvents.slice(i + 1)];
      }
    }
    // the snapshot tail predates the live stream: append only strictly newer events
    return [...snapshot, ...liveEvents.filter((e) => e.ts > tail.ts)];
  }, [snapshot, liveEvents]);

  // If the store holds more events than the merge produced (e.g. the live buffer
  // trimmed past its cap), the snapshot is stale: refetch it. The short delay
  // skips transient leads where a summary frame lands before its events frame,
  // and the throttle keeps a burst from hammering the API.
  const lastRefetch = useRef(0);
  useEffect(() => {
    if (!snapshot || !session || session.eventCount <= events.length) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (Date.now() - lastRefetch.current < 2000) return;
      lastRefetch.current = Date.now();
      fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/events`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled && Array.isArray(d.events)) setSnapshot(d.events); })
        .catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [session, snapshot, events.length, sessionKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', gap: 18, alignItems: 'center', padding: '0 18px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {tabs.map((t) => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
            {tab === t && (
              <motion.div
                layoutId="pane-tab"
                style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: 'var(--green)' }}
              />
            )}
          </button>
        ))}
        <span style={{
          marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
        }}>
          {session?.cwd ?? sessionKey}
        </span>
      </div>

      {session?.status === 'working' && (
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          working{session.lastTool ? ' — ' : ''}
          {session.lastTool && <span style={{ color: 'var(--green)' }}>{session.lastTool}</span>}
        </div>
      )}
      {session?.status === 'needs_input' && (
        <div className="strip row-needs_input" style={{ color: 'var(--amber)', fontWeight: 600 }}>
          ⏸ waiting for your input
        </div>
      )}
      {session?.status === 'blocked' && (
        <div className="strip row-blocked" style={{ color: 'var(--red)', fontWeight: 600 }}>
          ⚠ likely waiting on a permission prompt
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'terminal' ? (
          <TerminalView sessionKey={sessionKey} />
        ) : snapshot === null ? (
          <div style={{ padding: 24, fontSize: 11.5, color: 'var(--text-faint)' }}>loading…</div>
        ) : tab === 'conversation' ? (
          <ConversationView events={events} />
        ) : (
          <ActivityFeed events={events} />
        )}
      </div>
    </div>
  );
}
