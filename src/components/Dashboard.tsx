'use client';
import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, SessionSummary, SourceKind } from '@/lib/ui-types';
import { SessionNav } from './SessionNav';

export function Dashboard() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceKind | 'all'>('all');
  const [liveEvents, setLiveEvents] = useState<Record<string, AgentEvent[]>>({});

  // initial snapshot, then live frames over SSE
  useEffect(() => {
    let cancelled = false;
    fetch('/api/sessions')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && Array.isArray(d.sessions)) setSessions(d.sessions); })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type === 'sessions') setSessions(d.sessions);
      else if (d.type === 'events') {
        setLiveEvents((prev) => ({ ...prev, [d.key]: [...(prev[d.key] ?? []), ...d.events] }));
      }
    };
    return () => { cancelled = true; es.close(); };
  }, []);

  // keyboard order matches the rendered order: Live group first, then Recent
  const visible = useMemo(() => {
    const f = sessions.filter((s) => filter === 'all' || s.source === filter);
    return [...f.filter((s) => s.status !== 'ended'), ...f.filter((s) => s.status === 'ended')];
  }, [sessions, filter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'j', 'k'].includes(e.key)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (visible.length === 0) return;
      const idx = visible.findIndex((s) => s.key === selectedKey);
      const delta = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
      const next = visible[(idx + delta + visible.length) % visible.length] ?? visible[0];
      setSelectedKey(next.key);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedKey]);

  return (
    <div style={{ display: 'flex', background: 'var(--bg)' }}>
      <SessionNav
        sessions={sessions}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        filter={filter}
        onFilter={setFilter}
      />
      <main style={{ flex: 1, height: '100vh', overflow: 'hidden' }}>
        {selectedKey ? (
          <SessionPanePlaceholder key={selectedKey} sessionKey={selectedKey} liveEvents={liveEvents[selectedKey] ?? []} />
        ) : (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 10,
          }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700,
              letterSpacing: '0.3em', color: 'var(--text-faint)',
            }}>
              STANDBY
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              select a session · ↑↓ or j/k to cycle
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Replaced by SessionPane in Task 11.
function SessionPanePlaceholder({ sessionKey, liveEvents }: { sessionKey: string; liveEvents: AgentEvent[] }) {
  return (
    <div style={{ padding: 24, fontSize: 12, color: 'var(--text-dim)' }}>
      <span style={{ color: 'var(--text)' }}>{sessionKey}</span> — {liveEvents.length} live events
    </div>
  );
}
