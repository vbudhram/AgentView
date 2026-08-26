'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, SessionSummary } from '@/lib/ui-types';
import { ConversationView } from './ConversationView';
import { ActivityFeed } from './ActivityFeed';
import { TerminalView } from './TerminalView';
import { personaFor, accentSoft } from '@/lib/persona';
import { AgentAvatar } from './AgentAvatar';

// There is no reply channel for non-steerable sessions; the honest fallback
// is telling the user where the real prompt lives.
function respondHint(session: SessionSummary | undefined): string {
  if (!session) return '';
  if (session.steerable) return 'reply in the Terminal tab';
  if (session.source === 'desktop') return 'respond in Claude Desktop';
  return 'respond in the terminal running this session';
}

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

  const persona = personaFor(sessionKey);
  const soft = accentSoft(persona.hue);
  const project = session?.cwd ? session.cwd.split('/').filter(Boolean).pop() : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', padding: '10px 18px 8px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <AgentAvatar status={session?.status ?? 'idle'} hue={persona.hue} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700,
            letterSpacing: '0.04em', color: 'var(--text)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {project ?? sessionKey}
            {session?.gitBranch ? (
              <span style={{ color: 'var(--text-dim)', fontWeight: 500, fontSize: 12 }}> · {session.gitBranch}</span>
            ) : null}
          </div>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.04em', color: soft, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {persona.name}
          </div>
        </div>
        <span title={session?.cwd ?? undefined} style={{
          marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
          maxWidth: '40%',
        }}>
          {session?.cwd ?? ''}
        </span>
      </div>
      <div style={{
        display: 'flex', gap: 18, alignItems: 'center', padding: '0 18px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {tabs.map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? 'active' : ''}`}
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        {session?.source === 'desktop' && (
          <button
            className="desktop-open-btn"
            onClick={() => fetch('/api/open-desktop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: session?.sessionId ?? null }),
            })}
          >
            Open in Claude Desktop
          </button>
        )}
      </div>

      {session?.status === 'working' && (
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          working{session.now ? ' — ' : ''}
          {session.now && <span style={{ color: 'var(--green)' }}>{session.now}</span>}
        </div>
      )}
      {session?.status === 'needs_input' && (
        <div className="strip row-needs_input" style={{ color: 'var(--amber)', fontWeight: 600 }}>
          ⏸ waiting for your input{session.now ? ` — ${session.now}` : ''}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
            · {respondHint(session)}
          </span>
        </div>
      )}
      {session?.status === 'blocked' && (
        <div className="strip row-blocked" style={{ color: 'var(--red)', fontWeight: 600 }}>
          ⚠ likely waiting on a permission prompt{session.now ? ` — ${session.now}` : ''}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
            · {respondHint(session)}
          </span>
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
