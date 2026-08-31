'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import type { AgentEvent, SessionSummary, SourceKind } from '@/lib/ui-types';
import { personaFor, resolvePersonas } from '@/lib/persona';
import { useIsMobile, useVisualViewportVar } from '@/lib/mobile';
import { demoteMutedAlarms, isAlarm, isMuted, useMuteVersion } from '@/lib/mute';
import { SessionNav } from './SessionNav';
import { SessionPane } from './SessionPane';

const MAX_LIVE_EVENTS = 500; // per-key cap so a long-running dashboard stays bounded

// Tiny data-URI favicon: a dot whose color mirrors the fleet status.
function faviconFor(color: string, alert: boolean): string {
  const mark = alert
    ? `<rect x='14' y='7' width='4' height='12' rx='2' fill='#0a0d0b'/><rect x='14' y='21' width='4' height='4' rx='2' fill='#0a0d0b'/>`
    : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<rect width='32' height='32' rx='7' fill='#0a0d0b'/>` +
    `<circle cx='16' cy='16' r='10' fill='${color}'/>${mark}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function Dashboard() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceKind | 'all'>('all');
  const [navW, setNavW] = useState(() => {
    if (typeof window === 'undefined') return 320;
    try {
      const saved = Number(localStorage.getItem('agentview.navW'));
      return saved >= 240 && saved <= 600 ? saved : 320;
    } catch { return 320; }
  });
  const [dragging, setDragging] = useState(false);
  const [liveEvents, setLiveEvents] = useState<Record<string, AgentEvent[]>>({});

  // Phone model: full-screen list ⇄ full-screen detail, like a chat app.
  const isMobile = useIsMobile();
  const showDetail = isMobile && selectedKey !== null;
  useVisualViewportVar(showDetail);

  // On mobile a selection is a navigation push, so the browser back button
  // (and the ‹ chevron, which calls history.back) returns to the list.
  const inDetailHistory = useRef(false);
  const select = useCallback((key: string) => {
    setSelectedKey(key);
    if (window.matchMedia('(max-width: 700px)').matches && !inDetailHistory.current) {
      history.pushState({ avDetail: true }, '');
      inDetailHistory.current = true;
    }
  }, []);
  const goBack = useCallback(() => {
    if (inDetailHistory.current) history.back();
    else setSelectedKey(null);
  }, []);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (!e.state?.avDetail) {
        inDetailHistory.current = false;
        setSelectedKey(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // initial snapshot, then live frames over SSE
  useEffect(() => {
    let cancelled = false;
    const loadSnapshot = () =>
      fetch('/api/sessions', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { if (!cancelled && Array.isArray(d.sessions)) setSessions(d.sessions); })
        .catch(() => {});
    loadSnapshot();

    // Mobile networks and proxies often stall long-lived SSE; poll the small
    // session list as a fallback so the radar stays current regardless.
    const poll = setInterval(loadSnapshot, 4000);

    const es = new EventSource('/api/stream');
    es.onmessage = (m) => {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch {
        return; // ignore malformed frames
      }
      if (d.type === 'sessions') setSessions(d.sessions);
      else if (d.type === 'events') {
        setLiveEvents((prev) => ({
          ...prev,
          [d.key]: [...(prev[d.key] ?? []), ...d.events].slice(-MAX_LIVE_EVENTS),
        }));
      }
    };
    return () => { cancelled = true; clearInterval(poll); es.close(); };
  }, []);

  // keyboard order matches the rendered order: Live group first, then Recent,
  // with muted alarms demoted below unmuted ones exactly as the list draws them
  const muteVersion = useMuteVersion();
  const visible = useMemo(() => {
    const f = demoteMutedAlarms(sessions.filter((s) => filter === 'all' || s.source === filter));
    return [...f.filter((s) => s.status !== 'ended'), ...f.filter((s) => s.status === 'ended')];
    // muteVersion invalidates the order when an alarm is (un)acknowledged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, filter, muteVersion]);

  // Codenames resolved against the current fleet, so collisions get epithets.
  const personas = useMemo(() => resolvePersonas(sessions.map((s) => s.key)), [sessions]);

  // Title + favicon radar: the needs-you count reaches the user before they
  // ever focus this window. It counts confirmed asks (needs_input) and likely
  // permission prompts (approvalLikely) — never mere statements (waiting) or
  // a pending tool with a live spinner, which count as working. Muted
  // (acknowledged) sessions leave the count so it can reach zero.
  useEffect(() => {
    const needs = sessions.filter(
      (s) => isAlarm(s) && !isMuted(s.key, s.lastActivity));
    const working = sessions.filter(
      (s) => s.status === 'working' || (s.status === 'blocked' && !s.approvalLikely)).length;
    document.title =
      needs.length === 1 ? `⚠ ${personas.get(needs[0].key)?.name ?? '1'} needs you — AgentView` :
      needs.length > 0 ? `⚠ ${needs.length} need you — AgentView` :
      working > 0 ? `● ${working} working — AgentView` : 'AgentView';
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = needs.length > 0
      ? faviconFor('#fbbf24', true)
      : faviconFor(working > 0 ? '#4ade80' : '#556057', false);
  }, [sessions, personas, muteVersion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code covers layouts/environments where arrows report a legacy e.key
      const down = e.key === 'ArrowDown' || e.key === 'Down' || e.code === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'Up' || e.code === 'ArrowUp' || e.key === 'k';
      if (!down && !up) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (visible.length === 0) return;
      const idx = visible.findIndex((s) => s.key === selectedKey);
      const delta = down ? 1 : -1;
      // with no current selection, down starts at the top and up at the bottom
      const nextIdx = idx === -1
        ? (delta > 0 ? 0 : visible.length - 1)
        : (idx + delta + visible.length) % visible.length;
      setSelectedKey(visible[nextIdx].key);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedKey]);

  return (
    <MotionConfig reducedMotion="user">
    <div
      className={`app-shell${showDetail ? ' show-detail' : ''}`}
      style={{ ['--nav-w' as string]: `${navW}px` }}
    >
      <SessionNav
        sessions={sessions}
        personas={personas}
        selectedKey={selectedKey}
        onSelect={select}
        filter={filter}
        onFilter={setFilter}
      />
      <div
        className={`nav-resizer${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="resize session list"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const w = Math.min(600, Math.max(240, Math.round(e.clientX)));
          setNavW(w);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          try { localStorage.setItem('agentview.navW', String(navW)); } catch {}
        }}
      />
      <main className="app-main">
        {selectedKey ? (
          <SessionPane
            key={selectedKey}
            sessionKey={selectedKey}
            persona={personas.get(selectedKey) ?? personaFor(selectedKey)}
            session={sessions.find((s) => s.key === selectedKey)}
            liveEvents={liveEvents[selectedKey] ?? []}
            isMobile={isMobile}
            onBack={isMobile ? goBack : undefined}
          />
        ) : !isMobile ? (
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
        ) : null}
      </main>
    </div>
    </MotionConfig>
  );
}
