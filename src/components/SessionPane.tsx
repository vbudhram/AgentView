'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, SessionSummary } from '@/lib/ui-types';
import { ConversationView } from './ConversationView';
import { ActivityFeed } from './ActivityFeed';
import { TerminalView } from './TerminalView';
import { TerminalPreview } from './TerminalPreview';
import { accentSoft, type Persona } from '@/lib/persona';
import { usePressActivate } from '@/lib/mobile';
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


// Back fires on touch-down (instant, and immune to taps whose synthetic
// click never lands); the guard keeps the follow-up click from firing twice.
function BackButton({ onBack }: { onBack: () => void }) {
  const handled = useRef(0);
  const go = () => {
    if (Date.now() - handled.current < 600) return;
    handled.current = Date.now();
    onBack();
  };
  return (
    <button
      className="back-btn"
      aria-label="back to the session list"
      onPointerDown={go}
      onClick={go}
    >
      <span className="chev">‹</span>
      <span>list</span>
    </button>
  );
}

const TABS = ['conversation', 'activity', 'terminal'] as const;
type Tab = (typeof TABS)[number];

export function SessionPane({ sessionKey, persona, session, liveEvents, isMobile = false, onBack }: {
  sessionKey: string;
  persona: Persona;
  session: SessionSummary | undefined;
  liveEvents: AgentEvent[];
  isMobile?: boolean;
  onBack?: () => void;
}) {
  // Seed from the cache so cycling with j/k never blanks the pane.
  const [snapshot, setSnapshot] = useState<AgentEvent[] | null>(
    () => snapshotCache.get(sessionKey) ?? null);
  // Steerable sessions open straight into their live terminal.
  const [tab, setTab] = useState<Tab>(session?.steerable ? 'terminal' : 'conversation');
  const tabs = session?.steerable ? TABS : TABS.filter((t) => t !== 'terminal');

  // The terminal tab vanishes when the bridge drops; leave it with it.
  useEffect(() => {
    if (tab === 'terminal' && !session?.steerable) setTab('conversation');
  }, [tab, session?.steerable]);

  // If the summary had not loaded at mount, apply the terminal default once
  // when it arrives; never override a choice made after that.
  const defaultApplied = useRef(session !== undefined);
  useEffect(() => {
    if (!defaultApplied.current && session) {
      defaultApplied.current = true;
      if (session.steerable) setTab('terminal');
    }
  }, [session]);

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
  // Tap-to-reveal session info: on touch there is no hover/title, so the
  // cwd in the top bar toggles a strip with the full path and glyph meanings.
  const [infoOpen, setInfoOpen] = useState(false);
  const infoTap = usePressActivate(() => setInfoOpen((o) => !o));

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
      <div className="pane-header">
        {onBack && (
          <BackButton onBack={onBack} />
        )}
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
        <button
          className="session-info-btn"
          title={session?.cwd ?? undefined}
          aria-expanded={infoOpen}
          aria-label="session details"
          {...infoTap}
        >
          {session?.cwd ? `${session.cwd} ${infoOpen ? '▴' : '▾'}` : infoOpen ? '▴' : '▾'}
        </button>
      </div>
      {infoOpen && (
        <div className="session-info-strip">
          <div style={{ color: 'var(--text)' }}>{session?.cwd ?? '(no working directory)'}</div>
          {session?.gitBranch && <div>branch: {session.gitBranch}</div>}
          <div>
            source: {session?.source ?? 'unknown'}
            {session?.steerable
              ? session.wrapperOutdated
                ? ' · ⌁! steerable, wrapper outdated — restart with `claude --continue` to fix the mirror'
                : ' · ⌁ steerable — the Terminal tab is a live two-way mirror'
              : ' · not steerable from here'}
          </div>
        </div>
      )}
      <div style={{
        display: 'flex', gap: 18, alignItems: 'center', padding: '0 18px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {tabs.map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? 'active' : ''}`}
            aria-selected={tab === t}
            // pointerdown: instant switch on touch-down (segmented-control
            // feel) and immune to taps whose click never lands; setTab is
            // idempotent, so the follow-up click is harmless
            onPointerDown={() => setTab(t)}
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
      {session?.steerable && session.wrapperOutdated && (
        <div className="strip" style={{ color: 'var(--amber)', fontSize: 11.5 }}>
          ⌁! wrapper outdated — the mirror may render incorrectly. Restart this
          session (<code>claude --continue</code>) to upgrade.
        </div>
      )}
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

      {/* one WS per session on phones: the Terminal tab IS the mirror there */}
      {!isMobile && previewMounted && tab !== 'terminal' && (
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
