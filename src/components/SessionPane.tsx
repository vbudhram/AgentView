'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, SessionSummary } from '@/lib/ui-types';
import { ConversationView } from './ConversationView';
import { ActivityFeed } from './ActivityFeed';
import { TerminalView, LINK_COLOR, LINK_LABEL, type LinkState } from './TerminalView';
import { TerminalPreview } from './TerminalPreview';
import { accentSoft, type Persona } from '@/lib/persona';
import { usePressActivate, useTapActivate } from '@/lib/mobile';
import { isMuted, setMuted, useMuteVersion } from '@/lib/mute';
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
  // Tap-to-reveal session info: on touch there is no hover/title, so the ⓘ
  // toggles a strip with the full path and glyph meanings. The path itself
  // lives ONLY there — the header shows project · branch once.
  const [infoOpen, setInfoOpen] = useState(false);
  const infoTap = usePressActivate(() => setInfoOpen((o) => !o));

  // Wrapper-outdated: a small ⌁! pill, not a banner. The explanation sheet
  // opens once per browser session (sessionStorage) and then on demand.
  const wrapDismissKey = `agentview.wrapdismiss.${sessionKey}`;
  const [wrapOpen, setWrapOpen] = useState<boolean>(() => {
    try { return sessionStorage.getItem(wrapDismissKey) !== '1'; } catch { return true; }
  });
  const dismissWrap = () => {
    setWrapOpen(false);
    try { sessionStorage.setItem(wrapDismissKey, '1'); } catch {}
  };
  const wrapTap = usePressActivate(() => {
    if (wrapOpen) dismissWrap();
    else setWrapOpen(true);
  });

  // Needs-you strip: one line collapsed; tap for the full ask + where to reply.
  const [needsOpen, setNeedsOpen] = useState(false);
  const needsTap = useTapActivate(() => setNeedsOpen((o) => !o));
  // Ack/mute: silences THIS ask until the session's next new activity.
  useMuteVersion();
  const muted = session ? isMuted(sessionKey, session.lastActivity) : false;
  const muteTap = useTapActivate(() => {
    if (session) setMuted(sessionKey, session.lastActivity, !muted);
  });

  // Terminal chrome lives in the tab row (no sub-header): fit toggle + link dot.
  const [fitChoice, setFitChoice] = useState<boolean | null>(null);
  const fit = fitChoice ?? isMobile;
  const fitTap = usePressActivate(() => setFitChoice(!fit));
  const [link, setLink] = useState<LinkState>('connecting');

  // 10s tick keeps the pending-tool elapsed time honest between frames.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const longPending = session?.status === 'blocked'
    && (session.approvalLikely
      || nowMs - new Date(session.lastActivity).getTime() >= APPROVAL_HINT_MIN * 60000);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="pane-header">
        {onBack && (
          <BackButton onBack={onBack} />
        )}
        <AgentAvatar status={session?.status ?? 'idle'} hue={persona.hue} size={34} />
        <div style={{ minWidth: 0, flex: 1 }}>
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
        {session?.steerable && session.wrapperOutdated && (
          <button
            className="wrap-pill"
            aria-expanded={wrapOpen}
            aria-label="wrapper outdated — details"
            {...wrapTap}
          >
            ⌁!
          </button>
        )}
        <button
          className="session-info-btn"
          title={session?.cwd ?? undefined}
          aria-expanded={infoOpen}
          aria-label="session details"
          {...infoTap}
        >
          ⓘ {infoOpen ? '▴' : '▾'}
        </button>
      </div>
      {session?.steerable && session.wrapperOutdated && wrapOpen && (
        <div className="session-info-strip wrap-sheet">
          <span>
            ⌁! wrapper outdated — the mirror may render incorrectly. Restart
            this session (<code>claude --continue</code>) to upgrade.
          </span>
          <button className="wrap-dismiss" onClick={dismissWrap}>dismiss</button>
        </div>
      )}
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
      <div className="tab-row">
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
        <span className="tab-row-tools">
          {session?.source === 'desktop' && !isMobile && (
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
          {tab === 'terminal' && (
            <>
              {isMobile && (
                <button className="term-fit-btn" aria-pressed={fit} {...fitTap}>
                  {fit ? 'fit ▣' : '1:1 ⤢'}
                </button>
              )}
              <span className="term-link" style={{ color: LINK_COLOR[link] }} title={LINK_LABEL[link]}>
                <span
                  className={link === 'live' ? 'dot dot-working' : 'dot'}
                  style={{ width: 6, height: 6, background: link === 'live' ? undefined : LINK_COLOR[link] }}
                />
                <span className="term-link-label">{LINK_LABEL[link]}</span>
              </span>
            </>
          )}
        </span>
      </div>

      {session?.spinner ? (
        // The CLI's own live spinner line: the strip mirrors the terminal.
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          <span style={{ color: 'var(--green)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.spinner}</span>
        </div>
      ) : session?.status === 'working' ? (
        <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
          <span className="typing" aria-label="working"><i /><i /><i /></span>
          working{session.now ? ' — ' : ''}
          {session.now && <span style={{ color: 'var(--green)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.now}</span>}
        </div>
      ) : null}
      {(session?.status === 'needs_input' || session?.approvalLikely) && (
        <div className={`strip needs-strip${muted ? ' muted' : ' row-needs_input'}`}>
          <div className="needs-strip-row">
            <button
              className="needs-strip-main"
              aria-expanded={needsOpen}
              aria-label="what this session needs"
              {...needsTap}
            >
              <span className={`needs-strip-line${needsOpen ? ' open' : ''}`}>
                {session.status === 'needs_input' ? '⏸ needs you' : '⏳ may need approval'}
                {session.now ? ` — ${session.now}` : ''}
              </span>
            </button>
            <button
              className="mute-btn"
              title={muted ? 'unmute this alarm' : 'acknowledge — mute until this session\'s next activity'}
              aria-pressed={muted}
              {...muteTap}
            >
              {muted ? '✓ muted' : 'mute'}
            </button>
          </div>
          {needsOpen && (
            <div className="needs-strip-detail">
              · {respondHint(session)}
              {!session.steerable && session.source !== 'desktop' && session.cwd && (
                <CopyCdButton cwd={session.cwd} />
              )}
            </div>
          )}
        </div>
      )}
      {session?.status === 'blocked' && !session.spinner && !session.approvalLikely && (
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
          <TerminalView sessionKey={sessionKey} fit={fit} onLinkChange={setLink} />
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
