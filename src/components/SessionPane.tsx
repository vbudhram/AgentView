'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
// A snapshot is a TAIL of the transcript: `total` is the server-side event
// count when it was taken, so a tailed snapshot is never mistaken for stale.
type Snapshot = { events: AgentEvent[]; total: number };
const MAX_CACHED = 10;
const snapshotCache = new Map<string, Snapshot>();
function cachePut(key: string, snap: Snapshot): void {
  snapshotCache.delete(key);
  snapshotCache.set(key, snap);
  if (snapshotCache.size > MAX_CACHED) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
}

// Opening a session fetches only this many trailing events (a 21MB transcript
// must not be re-downloaded over Tailscale); "show earlier" widens the tail.
const DEFAULT_TAIL = 400;
const TAIL_STEP = 400;

async function fetchTail(sessionKey: string, tail: number): Promise<Snapshot | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}/events?tail=${tail}`);
    const d = await r.json();
    if (!Array.isArray(d.events)) return null;
    return { events: d.events, total: Number.isFinite(d.total) ? d.total : d.events.length };
  } catch {
    return null;
  }
}

function relDur(iso: string, now: number): string {
  const m = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

// A pending tool this old gets a quiet "may need approval" note, no alarm.
const APPROVAL_HINT_MIN = 10;

// One-line truncation, used across the header and status strips.
const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

// Green activity strip with the typing dots; content varies by caller.
function WorkingStrip({ children }: { children: ReactNode }) {
  return (
    <div className="strip" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--green-deep)' }}>
      <span className="typing" aria-label="working"><i /><i /><i /></span>
      {children}
    </div>
  );
}

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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(
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
    // A revisit keeps its widened tail; a first open starts at the default.
    const tail = Math.max(DEFAULT_TAIL, snapshotCache.get(sessionKey)?.events.length ?? 0);
    fetchTail(sessionKey, tail).then((snap) => {
      if (snap) {
        cachePut(sessionKey, snap);
        if (!cancelled) setSnapshot(snap);
      } else if (!cancelled) {
        setSnapshot((prev) => prev ?? { events: [], total: 0 });
      }
    });
    return () => { cancelled = true; };
  }, [sessionKey]);

  // The snapshot is authoritative. Live events are a suffix of the same stream,
  // so find the snapshot tail inside liveEvents and append only what follows it.
  const snapEvents = snapshot?.events ?? null;
  const events = useMemo(() => {
    if (!snapEvents) return [];
    if (liveEvents.length === 0) return snapEvents;
    if (snapEvents.length === 0) return liveEvents;
    const tail = snapEvents[snapEvents.length - 1];
    let tailKey: string | null = null;
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      // cheap ts precheck; stringify only candidates with a matching timestamp
      if (liveEvents[i].ts !== tail.ts) continue;
      tailKey ??= JSON.stringify(tail);
      if (JSON.stringify(liveEvents[i]) === tailKey) {
        return [...snapEvents, ...liveEvents.slice(i + 1)];
      }
    }
    // the snapshot tail predates the live stream: append only strictly newer events
    return [...snapEvents, ...liveEvents.filter((e) => e.ts > tail.ts)];
  }, [snapEvents, liveEvents]);

  // Staleness: the snapshot covered `total` server events, and the merge
  // appended `events.length - snapshot.length` live ones. Only when the store
  // holds MORE than that (e.g. the live buffer trimmed past its cap) is the
  // snapshot stale; a tailed snapshot alone must never trigger a refetch.
  // The short delay skips transient leads where a summary frame lands before
  // its events frame; the throttle keeps a burst from hammering the API.
  const known = snapshot ? snapshot.total + Math.max(0, events.length - snapshot.events.length) : 0;
  const lastRefetch = useRef(0);
  useEffect(() => {
    if (!snapshot || !session || session.eventCount <= known) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (Date.now() - lastRefetch.current < 2000) return;
      lastRefetch.current = Date.now();
      fetchTail(sessionKey, Math.max(DEFAULT_TAIL, snapshot.events.length)).then((snap) => {
        if (!snap) return;
        cachePut(sessionKey, snap);
        if (!cancelled) setSnapshot(snap);
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [session, snapshot, known, sessionKey]);

  // "Show earlier" past the local buffer: widen the tail from the server.
  const loadingEarlier = useRef(false);
  const loadEarlier = useCallback(() => {
    const cur = snapshotCache.get(sessionKey);
    if (loadingEarlier.current) return;
    loadingEarlier.current = true;
    fetchTail(sessionKey, (cur?.events.length ?? 0) + TAIL_STEP).then((snap) => {
      loadingEarlier.current = false;
      if (!snap) return;
      cachePut(sessionKey, snap);
      setSnapshot(snap);
    });
  }, [sessionKey]);
  // "Jump to start" needs everything the server holds.
  const loadAll = useCallback(() => {
    if (loadingEarlier.current) return;
    loadingEarlier.current = true;
    fetchTail(sessionKey, 1e9).then((snap) => {
      loadingEarlier.current = false;
      if (!snap) return;
      cachePut(sessionKey, snap);
      setSnapshot(snap);
    });
  }, [sessionKey]);
  // Events on the server before the snapshot's first one (turn_status included,
  // so the expander count is approximate for the conversation view).
  const earlierAvailable = snapshot ? Math.max(0, snapshot.total - snapshot.events.length) : 0;

  const soft = accentSoft(persona.hue);
  const project = session?.cwd ? session.cwd.split('/').filter(Boolean).pop() : null;
  // Tap-to-reveal session info: on touch there is no hover/title, so the ⓘ
  // toggles a strip with the full path and glyph meanings. The path itself
  // lives ONLY there; the header shows project · branch once.
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

  // View-only session (no av wrapper): where the terminal tab would be,
  // say so and give the exact recovery instead of silently missing a tab.
  const viewOnly = !!session && !session.steerable && session.source !== 'desktop';
  const [viewOnlyOpen, setViewOnlyOpen] = useState(false);
  const viewOnlyTap = usePressActivate(() => setViewOnlyOpen((o) => !o));
  const relaunchCmd = session?.agent === 'codex' ? 'av codex resume' : 'av claude --continue';

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
            letterSpacing: '0.04em', color: 'var(--text)', ...ellipsis,
          }}>
            {project ?? sessionKey}
            {session?.gitBranch ? (
              <span style={{ color: 'var(--text-dim)', fontWeight: 500, fontSize: 12 }}> · {session.gitBranch}</span>
            ) : null}
          </div>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.04em', color: soft, ...ellipsis,
          }}>
            {persona.name}
            {session && (
              <span style={{
                color: session.status === 'ended' ? 'var(--text-faint)'
                  : session.status === 'needs_input' ? 'var(--amber)'
                  : session.status === 'working' ? 'var(--green-deep)' : 'var(--text-dim)',
                fontWeight: 500,
              }}>
                {' · '}
                {session.status === 'ended'
                  ? `ended ${relDur(session.lastActivity, nowMs)} ago`
                  : session.status === 'needs_input' ? 'needs you'
                  : session.status === 'blocked'
                    // Without a live spinner the app cannot tell a running
                    // tool from a pending approval; say so instead of guessing.
                    ? (session.approvalLikely ? 'may need approval'
                      : session.spinner ? 'running a tool'
                      : 'running a tool — or awaiting approval')
                  : session.status}
              </span>
            )}
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
        {viewOnly && (
          <button
            className="tab-btn tab-viewonly"
            aria-expanded={viewOnlyOpen}
            aria-label="terminal is view-only — how to enable it"
            {...viewOnlyTap}
          >
            terminal: view-only
          </button>
        )}
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

      {viewOnly && viewOnlyOpen && (
        <div className="session-info-strip">
          <div style={{ color: 'var(--text)' }}>
            view-only — this session was not launched with <code>av</code>, so
            there is no live terminal here.
          </div>
          <div>
            To steer it from your phone: exit the agent in its own terminal,
            then relaunch it there with <code>{relaunchCmd}</code> to pick the
            session back up.
            {session?.cwd && <CopyCdButton cwd={session.cwd} />}
          </div>
        </div>
      )}
      {session?.spinner ? (
        // The CLI's own live spinner line: the strip mirrors the terminal.
        <WorkingStrip>
          <span style={{ color: 'var(--green)', ...ellipsis }}>{session.spinner}</span>
        </WorkingStrip>
      ) : session?.status === 'working' ? (
        <WorkingStrip>
          working{session.now ? ' — ' : ''}
          {session.now && <span style={{ color: 'var(--green)', ...ellipsis }}>{session.now}</span>}
        </WorkingStrip>
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
            {longPending ? '· still running — may need approval' : '· running — or waiting for approval'}
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
          <ConversationView events={events} earlierAvailable={earlierAvailable} onLoadEarlier={loadEarlier} onLoadAll={loadAll} endedAt={session?.status === 'ended' ? session.lastActivity : null} />
        ) : (
          <ActivityFeed events={events} earlierAvailable={earlierAvailable} onLoadEarlier={loadEarlier} />
        )}
      </div>
    </div>
  );
}
