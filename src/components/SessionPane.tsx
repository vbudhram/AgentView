'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, SessionSummary } from '@/lib/ui-types';
import { ConversationView } from './ConversationView';
import { ActivityFeed } from './ActivityFeed';
import { TerminalView } from './TerminalView';
import { TerminalPreview } from './TerminalPreview';
import { accentSoft, type Persona } from '@/lib/persona';
import { AgentAvatar } from './AgentAvatar';

// Client-side transcript cache: revisiting a session renders instantly
// instead of flashing "loading…". Bounded LRU, freshest last.
const MAX_CACHED = 10;
const snapshotCache = new Map<string, AgentEvent[]>();
function cachePut(key: string, events: AgentEvent[]): void {
  snapshotCache.delete(key);
  snapshotCache.set(key, events);
  if (snapshotCache.size > MAX_CACHED) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
}

function relDur(iso: string, now: number): string {
  const m = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

// A pending tool this old gets a quiet "may need approval" note — no alarm.
const APPROVAL_HINT_MIN = 10;

// There is no reply channel for non-steerable sessions; the honest fallback
// is telling the user where the real prompt lives.
function respondHint(session: SessionSummary | undefined): string {
  if (!session) return '';
  if (session.steerable) return 'reply in the Terminal tab';
  if (session.source === 'desktop') return 'respond in Claude Desktop';
  return 'respond in the terminal running this session';
}

// Themed skeleton shown while the first transcript snapshot loads.
function LoadingSkeleton() {
  return (
    <div style={{ padding: '18px 24px', maxWidth: 780, margin: '0 auto' }} aria-label="loading">
      {[72, 46, 88, 34, 61, 52].map((w, i) => (
        <div key={i} className="skeleton-bar" style={{ width: `${w}%`, animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

// One-click bridge to the right terminal: copies `cd <cwd>` for pasting.
function CopyCdButton({ cwd }: { cwd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-cd-btn"
      title={`copy "cd ${cwd}"`}
      onClick={() => {
        navigator.clipboard?.writeText(`cd ${cwd}`).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }).catch(() => {});
      }}
    >
      {copied ? '✓ copied' : '⧉ copy path'}
    </button>
  );
}


const TABS = ['conversation', 'activity', 'terminal'] as const;
type Tab = (typeof TABS)[number];

export function SessionPane({ sessionKey, persona, session, liveEvents }: {
  sessionKey: string;
  persona: Persona;
  session: SessionSummary | undefined;
  liveEvents: AgentEvent[];
}) {
  // Seed from the cache so cycling with j/k never blanks the pane.
  const [snapshot, setSnapshot] = useState<AgentEvent[] | null>(
    () => snapshotCache.get(sessionKey) ?? null);
  const [tab, setTab] = useState<Tab>('conversation');
  const tabs = session?.steerable ? TABS : TABS.filter((t) => t !== 'terminal');

  // The terminal tab vanishes when the bridge drops; leave it with it.
  useEffect(() => {
    if (tab === 'terminal' && !session?.steerable) setTab('conversation');
  }, [tab, session?.steerable]);

  // Live-terminal preview lifecycle: mount while steerable; when the bridge
  // drops, keep it mounted briefly so the card can animate away.
  const steerable = !!session?.steerable;
  const [previewMounted, setPreviewMounted] = useState(steerable);
  // A session switch snaps to the new state; only a live drop animates out.
  const [previewKey, setPreviewKey] = useState(sessionKey);
  if (previewKey !== sessionKey) {
    setPreviewKey(sessionKey);
    setPreviewMounted(steerable);
  }
  useEffect(() => {
    if (steerable) { setPreviewMounted(true); return; }
    const t = setTimeout(() => setPreviewMounted(false), 300);
    return () => clearTimeout(t);
  }, [steerable, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(snapshotCache.get(sessionKey) ?? null);
    fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/events`)
      .then((r) => r.json())
      .then((d) => {
        const events = Array.isArray(d.events) ? d.events : [];
        cachePut(sessionKey, events);
        if (!cancelled) setSnapshot(events);
      })
      .catch(() => { if (!cancelled) setSnapshot((prev) => prev ?? []); });
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
        .then((d) => {
          if (!Array.isArray(d.events)) return;
          cachePut(sessionKey, d.events);
          if (!cancelled) setSnapshot(d.events);
        })
        .catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [session, snapshot, events.length, sessionKey]);

  const soft = accentSoft(persona.hue);
  const project = session?.cwd ? session.cwd.split('/').filter(Boolean).pop() : null;

  // 10s tick keeps the pending-tool elapsed time honest between frames.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const longPending = session?.status === 'blocked'
    && nowMs - new Date(session.lastActivity).getTime() >= APPROVAL_HINT_MIN * 60000;

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

      {session?.spinner ? (
        // The CLI's own live spinner line: the strip mirrors the terminal.
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          <span style={{ color: 'var(--green)' }}>{session.spinner}</span>
        </div>
      ) : session?.status === 'working' ? (
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          working{session.now ? ' — ' : ''}
          {session.now && <span style={{ color: 'var(--green)' }}>{session.now}</span>}
        </div>
      ) : null}
      {session?.status === 'needs_input' && (
        <div className="strip row-needs_input" style={{ color: 'var(--amber)', fontWeight: 600 }}>
          ⏸ {persona.name} needs you{session.now ? ` — ${session.now}` : ''}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
            · {respondHint(session)}
          </span>
          {!session.steerable && session.source !== 'desktop' && session.cwd && (
            <CopyCdButton cwd={session.cwd} />
          )}
        </div>
      )}
      {session?.status === 'blocked' && !session.spinner && (
        <div className="strip" style={{ color: 'var(--cyan)', fontWeight: 600 }}>
          ⏳ {session.now ?? 'running a tool'} — {relDur(session.lastActivity, nowMs)}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 8 }}>
            {longPending ? '· still running — may need approval' : '· tool still running'}
          </span>
        </div>
      )}

      {previewMounted && tab !== 'terminal' && (
        <TerminalPreview
          key={sessionKey}
          sessionKey={sessionKey}
          hue={persona.hue}
          open={steerable}
          onOpenTerminal={() => setTab('terminal')}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'terminal' ? (
          <TerminalView sessionKey={sessionKey} />
        ) : snapshot === null ? (
          <LoadingSkeleton />
        ) : tab === 'conversation' ? (
          <ConversationView events={events} />
        ) : (
          <ActivityFeed events={events} />
        )}
      </div>
    </div>
  );
}
