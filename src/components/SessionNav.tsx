'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { SessionSummary, SourceKind } from '@/lib/ui-types';
import { personaFor, accentSoft, type Persona } from '@/lib/persona';
import { useIsMobile, useTapActivate } from '@/lib/mobile';
import { isAlarm, isMuted } from '@/lib/mute';
import { useStableSessionOrder } from '@/lib/stable-order';
import { AgentAvatar } from './AgentAvatar';
import { AgentLogo } from './AgentLogo';

// Minutes granularity below 2h keeps neighboring rows distinguishable.
function rel(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  if (s < 7200) return m % 60 ? `1h${m % 60}m` : '1h';
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A pending tool this old gets a quiet "may need approval" note — no alarm.
const APPROVAL_HINT_MIN = 10;

// Row taps this soon after a real reorder are aimed at the OLD layout.
const TAP_GUARD_MS = 400;

function folderOf(cwd: string | null): string {
  return cwd ? cwd.split('/').filter(Boolean).pop() ?? '?' : '?';
}

// When two visible rows share a folder name, show parentDir/folder instead.
function projectLabel(cwd: string | null, dups: Set<string>): string {
  const folder = folderOf(cwd);
  if (!cwd || !dups.has(folder)) return folder;
  const parts = cwd.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${folder}` : folder;
}

function AgentBadge({ agent, mobile }: { agent: SessionSummary['agent']; mobile: boolean }) {
  return <AgentLogo agent={agent} size={mobile ? 15 : 13} />;
}

function Row({ s, persona, selected, onSelect, now, dups, showAgent, mobile, muted, flash }: {
  s: SessionSummary; persona: Persona; selected: boolean; onSelect: (k: string) => void;
  now: number; dups: Set<string>; showAgent: boolean; mobile: boolean;
  muted: boolean; flash: boolean;
}) {
  const soft = accentSoft(persona.hue);
  const project = projectLabel(s.cwd, dups);
  const ended = s.status === 'ended';
  const pendingMin = s.status === 'blocked'
    ? Math.floor((now - new Date(s.lastActivity).getTime()) / 60000) : 0;
  const longPending = pendingMin >= APPROVAL_HINT_MIN;
  // Attention rows are physically louder: bigger avatar, bigger name, big chip.
  // Alarms are a confirmed ask (needs_input) or a likely permission prompt
  // (approvalLikely). A muted (acknowledged) alarm drops the treatment.
  const alarm = isAlarm(s);
  const attention = alarm && !muted;
  const rowClass = `${attention ? 'row-needs_input' : ''}${flash ? ' row-flash' : ''}`;
  const nowColor =
    s.status === 'working' ? 'var(--green-deep)' :
    s.status === 'needs_input' ? (muted ? 'var(--text-dim)' : 'var(--amber)') :
    s.status === 'blocked' ? (attention ? 'var(--amber)' : 'var(--cyan)') : 'var(--text-dim)';
  // arm's-length sizes on phones: nothing under 11px, names ≥14px
  const avatarSize = attention ? (mobile ? 40 : 36) : (mobile ? 32 : 28);
  const nameSize = mobile ? (attention ? 16 : ended ? 13 : 14) : (attention ? 14.5 : ended ? 11.5 : 12.5);
  const nowSize = mobile ? (attention ? 13 : 12) : (attention ? 12 : 10.5);
  const statusLabel =
    s.status === 'blocked' ? (s.approvalLikely ? 'may need approval' : 'running a tool')
      : s.status.replace('_', ' ');
  const ref = useRef<HTMLDivElement>(null);
  // Selection and focus are one system: selecting focuses the row and keeps
  // it fully in view; focusing (click, Tab) selects it.
  useEffect(() => {
    if (!selected) return;
    const el = ref.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <motion.div
      ref={ref}
      // Reorders are rare now (band changes only) and tap-guarded, so the
      // spring runs on touch too: a row that moves must be SEEN moving,
      // never teleport under a finger.
      layout="position"
      transition={{ layout: { type: 'spring', stiffness: 500, damping: 40 } }}
      role="button"
      tabIndex={0}
      aria-label={`${project}, ${persona.name}, ${statusLabel}`}
      aria-pressed={selected}
      onClick={() => onSelect(s.key)}
      onFocus={() => { if (!selected) onSelect(s.key); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.key); }
      }}
      className={`nav-row ${rowClass}`}
      title={s.cwd ?? undefined}
      style={{
        padding: attention ? '10px 10px 10px 8px' : '8px 10px 8px 8px',
        cursor: 'pointer',
        borderLeft: `2px solid ${selected ? 'var(--green)' : 'transparent'}`,
        background: selected ? 'var(--sel-bg)' : undefined,
        opacity: ended ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: `${avatarSize + 2}px 1fr`, columnGap: 8 }}>
        <div style={{ gridRow: '1 / span 2', alignSelf: 'center' }}>
          <AgentAvatar status={s.status} hue={persona.hue} size={avatarSize} />
        </div>
        {/* primary line: WHERE (project · branch) + status chip + age */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <b style={{
            fontFamily: 'var(--font-display)', fontSize: nameSize, fontWeight: 700,
            letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', color: ended ? 'var(--text-dim)' : 'var(--text)',
            // the project name is the WHERE: the branch gives way before it
            // does (and disappears on alarm rows so the name keeps its room),
            // but a shown branch always keeps at least ~6 characters
            flexShrink: 0,
            maxWidth: `calc(100% - ${attention ? 118 : alarm ? 100 : 46}px${s.gitBranch && !attention ? ' - 6ch' : ''})`,
          }}>
            {project}
          </b>
          {s.gitBranch && !attention && (
            <span style={{
              fontSize: 'var(--fs-meta)', color: 'var(--text-dim)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: '6ch',
            }}>
              {s.gitBranch}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            {attention && (
              <span className="chip-needs chip-lg">
                {s.status === 'needs_input' ? 'NEEDS YOU' : 'APPROVE?'}
              </span>
            )}
            {alarm && muted && <span className="chip-muted">muted</span>}
            {s.status === 'waiting' && <span className="chip-waiting">waiting</span>}
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-faint)' }}>{rel(s.lastActivity, now)}</span>
          </span>
        </div>
        {/* secondary line: WHO (codename, flavor color) + agent/source chips */}
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', minWidth: 0,
          fontSize: attention ? (mobile ? 13 : 11.5) : 'var(--fs-meta)', color: 'var(--text-dim)',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.03em',
            color: ended ? 'var(--text-faint)' : soft,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {persona.name}
          </span>
          {showAgent && <AgentBadge agent={s.agent} mobile={mobile} />}
          {s.steerable && (
            <span
              title={s.wrapperOutdated ? 'wrapper outdated — restart this session to upgrade the mirror' : 'steerable'}
              style={{ fontSize: 'var(--fs-tiny)', color: s.wrapperOutdated ? 'var(--amber)' : 'var(--cyan)', flexShrink: 0 }}
            >
              ⌁{s.wrapperOutdated ? '!' : ''}
            </span>
          )}
          <span style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-tiny)', marginLeft: 'auto', flexShrink: 0 }}>
            {s.source === 'desktop' ? 'desktop' : s.source === 'codex' ? 'cli' : 'terminal'}
          </span>
        </div>
      </div>
      <div style={{ paddingLeft: avatarSize + 10, marginTop: 3, minHeight: 15 }}>
        {s.spinner ? (
          // The CLI's own live spinner line beats the computed now-line. No
          // per-change animation: the text ticks every second.
          <div style={{
            fontSize: nowSize, color: 'var(--green-deep)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {'⚙ '}{s.spinner}
          </div>
        ) : s.now ? (
          // Plain element on purpose: s.now can change several times per
          // second, and per-change AnimatePresence exits leaked zombie nodes
          // into layout. Never key/animate this line on the ticker value.
          <div style={{
            fontSize: nowSize, color: nowColor, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {s.status === 'working' ? '⚙ ' : s.status === 'blocked' ? '⏳ ' : ''}
            {s.now}
            {s.status === 'blocked' ? ` — ${rel(s.lastActivity, now)}` : ''}
            {s.status === 'blocked' && (longPending || s.approvalLikely) ? (
              <span style={{ color: 'var(--text-dim)' }}> · may need approval</span>
            ) : null}
          </div>
        ) : s.status === 'working' ? (
          <span className="typing" aria-label="working"><i /><i /><i /></span>
        ) : (
          <div style={{
            fontSize: 'var(--fs-meta)', color: 'var(--text-dim)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {s.title ?? '(no prompt yet)'}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{
      // opaque + raised so rows animating between bands slide under it cleanly
      position: 'relative', zIndex: 2, background: 'var(--bg-nav)',
      display: 'flex', alignItems: 'center', gap: 8, padding: '14px 10px 4px',
      fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
      letterSpacing: '0.22em', color: 'var(--text-faint)', textTransform: 'uppercase',
    }}>
      <span>{label}</span>
      <span style={{ color: label === 'Live' && count > 0 ? 'var(--green)' : undefined }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

export function SessionNav({ sessions, personas, selectedKey, onSelect, filter, onFilter }: {
  sessions: SessionSummary[]; personas: Map<string, Persona>; selectedKey: string | null;
  onSelect: (k: string) => void;
  filter: SourceKind | 'all'; onFilter: (f: SourceKind | 'all') => void;
}) {
  // 10s tick keeps the relative times fresh between stream frames
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const mobile = useIsMobile();

  // In-app radar: the needs-you count must live in the list header, because
  // a phone never shows the tab title or favicon. Unfiltered on purpose.
  // Counts real asks and likely permission prompts, never mere statements.
  // Acknowledged (muted) sessions leave the count so it can reach zero.
  const needs = sessions.filter(
    (s) => isAlarm(s) && !isMuted(s.key, s.lastActivity));

  // The banner is radar, not a duplicate of the list: it renders only while
  // the needs-you group (pinned to the top of the list) is scrolled away.
  // Its tap scrolls back to the group and flashes the first row.
  const navRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // tap-activate (pointerup), not press: scrolling on pointerdown would move
  // a session row under the finger before the synthetic click lands on it
  const bannerTap = useTapActivate(() => {
    navRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    if (needs[0]) {
      setFlashKey(needs[0].key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashKey(null), 1800);
    }
  });
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Stabilized order: rows reorder only on a membership/band change, never
  // on recency drift, so the list cannot move under an aiming finger.
  const { visible, orderChangedAt } = useStableSessionOrder(sessions, filter);
  const live = visible.filter((s) => s.status !== 'ended');
  const recent = visible.filter((s) => s.status === 'ended');

  // A tap that lands right as the rows DO jump must not open the position's
  // new occupant; ignore activations inside the shuffle window.
  const guardedSelect = (k: string) => {
    if (Date.now() - orderChangedAt < TAP_GUARD_MS) return;
    onSelect(k);
  };

  // The agent badge distinguishes nothing when the whole fleet is one agent.

  // folder names that appear on more than one visible row
  const dups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of visible) {
      const f = folderOf(s.cwd);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([f]) => f));
  }, [visible]);

  // Single flat list: each session renders exactly once, keyed by session key.
  // The Live/Recent split is a render property, so a status change moves the
  // row instead of mounting a second copy.
  return (
    <nav
      ref={navRef}
      className="nav-scroll session-nav"
      onScroll={(e) => {
        // hysteresis keeps the banner from flapping around the threshold
        const st = e.currentTarget.scrollTop;
        setScrolled((prev) => (st > 72 ? true : st < 48 ? false : prev));
      }}
    >
      <div className="nav-header">
        <div className="nav-header-row">
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700,
            letterSpacing: '0.1em', color: 'var(--text)',
          }}>
            AGENT<span style={{ color: 'var(--green)' }}>VIEW</span>
          </span>
          <span className="cursor-blink" style={{
            width: 7, height: 14, background: 'var(--green)', display: 'inline-block', flexShrink: 0,
          }} />
          <select
            className="filter-select"
            aria-label="filter by source"
            value={filter}
            onChange={(e) => { onFilter(e.target.value as SourceKind | 'all'); e.target.blur(); }}
            style={{ marginLeft: 'auto' }}
          >
            <option value="all">All</option>
            <option value="terminal">Terminal</option>
            <option value="desktop">Desktop</option>
            <option value="codex">CLI</option>
          </select>
        </div>
        {needs.length > 0 && scrolled && (
          <button
            className="needs-banner"
            {...bannerTap}
            aria-label={`${needs.length} session${needs.length > 1 ? 's' : ''} need input — scroll to them`}
          >
            <span aria-hidden>⚠</span>
            {needs.length === 1
              ? `${(personas.get(needs[0].key) ?? personaFor(needs[0].key)).name} needs you`
              : `${needs.length} need you`}
            <span style={{ marginLeft: 'auto', fontWeight: 400, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              jump ›
            </span>
          </button>
        )}
      </div>
      <GroupHeader label="Live" count={live.length} />
      {live.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>— none —</div>
      )}
      {live.map((s) => (
        <Row
          key={s.key} s={s} persona={personas.get(s.key) ?? personaFor(s.key)}
          selected={s.key === selectedKey} onSelect={guardedSelect} now={now} dups={dups}
          showAgent mobile={mobile}
          muted={isMuted(s.key, s.lastActivity)} flash={s.key === flashKey}
        />
      ))}
      <GroupHeader label="Recent" count={recent.length} />
      {recent.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>— none —</div>
      )}
      {recent.map((s) => (
        <Row
          key={s.key} s={s} persona={personas.get(s.key) ?? personaFor(s.key)}
          selected={s.key === selectedKey} onSelect={guardedSelect} now={now} dups={dups}
          showAgent mobile={mobile}
          muted={isMuted(s.key, s.lastActivity)} flash={s.key === flashKey}
        />
      ))}
      <div style={{ height: 24 }} />
    </nav>
  );
}
