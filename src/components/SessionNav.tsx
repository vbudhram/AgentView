'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { SessionSummary, SourceKind } from '@/lib/ui-types';
import { personaFor, accentSoft } from '@/lib/persona';
import { AgentAvatar } from './AgentAvatar';

function rel(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

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

function AgentBadge({ agent }: { agent: SessionSummary['agent'] }) {
  const claude = agent === 'claude';
  return (
    <span
      style={{
        fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', lineHeight: '14px',
        padding: '0 4px', borderRadius: 3, flexShrink: 0,
        color: claude ? 'var(--green)' : 'var(--cyan)',
        border: `1px solid ${claude ? 'var(--green-dim)' : 'rgba(103,232,249,0.35)'}`,
        background: claude ? 'rgba(74,222,128,0.08)' : 'rgba(103,232,249,0.07)',
      }}
    >
      {claude ? 'CL' : 'CX'}
    </span>
  );
}

function Row({ s, selected, onSelect, now, dups }: {
  s: SessionSummary; selected: boolean; onSelect: (k: string) => void; now: number;
  dups: Set<string>;
}) {
  const persona = personaFor(s.key);
  const soft = accentSoft(persona.hue);
  const project = projectLabel(s.cwd, dups);
  const attention = s.status === 'needs_input' ? 'row-needs_input' : s.status === 'blocked' ? 'row-blocked' : '';
  const ended = s.status === 'ended';
  const nowColor =
    s.status === 'working' ? 'var(--green-deep)' :
    s.status === 'needs_input' ? 'var(--amber)' :
    s.status === 'blocked' ? 'var(--red)' : 'var(--text-dim)';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <motion.div
      ref={ref}
      layout="position"
      transition={{ layout: { type: 'spring', stiffness: 500, damping: 40 } }}
      role="button"
      tabIndex={0}
      aria-label={`${project}, ${persona.name}, ${s.status.replace('_', ' ')}`}
      aria-pressed={selected}
      onClick={() => onSelect(s.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.key); }
      }}
      className={`nav-row ${attention}`}
      title={s.cwd ?? undefined}
      style={{
        padding: '8px 10px 8px 8px',
        cursor: 'pointer',
        borderLeft: `2px solid ${selected ? 'var(--green)' : 'transparent'}`,
        background: selected ? 'var(--sel-bg)' : undefined,
        opacity: ended ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr', columnGap: 8 }}>
        <div style={{ gridRow: '1 / span 2', alignSelf: 'center' }}>
          <AgentAvatar status={s.status} hue={persona.hue} size={28} />
        </div>
        {/* primary line: WHERE (project · branch) + status chip + age */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <b style={{
            fontFamily: 'var(--font-display)', fontSize: 12.5, fontWeight: 700,
            letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', color: ended ? 'var(--text-dim)' : 'var(--text)',
          }}>
            {project}
          </b>
          {s.gitBranch && (
            <span style={{
              fontSize: 10.5, color: 'var(--text-dim)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0,
            }}>
              {s.gitBranch}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            {s.status === 'needs_input' && <span className="chip-needs">NEEDS YOU</span>}
            {s.status === 'blocked' && <span className="chip-blocked">APPROVE?</span>}
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{rel(s.lastActivity, now)}</span>
          </span>
        </div>
        {/* secondary line: WHO (codename, flavor color) + agent/source chips */}
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', minWidth: 0,
          fontSize: 10.5, color: 'var(--text-dim)',
        }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.03em',
            color: ended ? 'var(--text-faint)' : soft,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {persona.name}
          </span>
          <AgentBadge agent={s.agent} />
          {s.steerable && (
            <span title="steerable" style={{ fontSize: 10, color: 'var(--cyan)', flexShrink: 0 }}>⌁</span>
          )}
          <span style={{ color: 'var(--text-faint)', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
            {s.source === 'desktop' ? 'app' : s.source === 'codex' ? 'cli' : 'term'}
          </span>
        </div>
      </div>
      <div style={{ paddingLeft: 38, marginTop: 3, minHeight: 15 }}>
        {s.now ? (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={s.now}
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -8, opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                fontSize: 10.5, color: nowColor, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {s.status === 'working' ? '⚙ ' : ''}{s.now}
            </motion.div>
          </AnimatePresence>
        ) : s.status === 'working' ? (
          <span className="typing" aria-label="working"><i /><i /><i /></span>
        ) : (
          <div style={{
            fontSize: 10.5, color: 'var(--text-dim)', overflow: 'hidden',
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

export function SessionNav({ sessions, selectedKey, onSelect, filter, onFilter }: {
  sessions: SessionSummary[]; selectedKey: string | null; onSelect: (k: string) => void;
  filter: SourceKind | 'all'; onFilter: (f: SourceKind | 'all') => void;
}) {
  // 10s tick keeps the relative times fresh between stream frames
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // One predicate feeds both the rows and the counts, so they cannot disagree.
  const visible = sessions.filter((s) => filter === 'all' || s.source === filter);
  const live = visible.filter((s) => s.status !== 'ended');
  const recent = visible.filter((s) => s.status === 'ended');

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
    <nav className="nav-scroll session-nav">
      <div style={{
        position: 'sticky', top: 0, zIndex: 1, display: 'flex', gap: 8, alignItems: 'center',
        padding: '12px 10px', background: 'var(--bg-nav)', borderBottom: '1px solid var(--border)',
      }}>
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
          <option value="codex">Codex</option>
        </select>
      </div>
      <GroupHeader label="Live" count={live.length} />
      {live.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>— none —</div>
      )}
      {live.map((s) => (
        <Row key={s.key} s={s} selected={s.key === selectedKey} onSelect={onSelect} now={now} dups={dups} />
      ))}
      <GroupHeader label="Recent" count={recent.length} />
      {recent.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>— none —</div>
      )}
      {recent.map((s) => (
        <Row key={s.key} s={s} selected={s.key === selectedKey} onSelect={onSelect} now={now} dups={dups} />
      ))}
      <div style={{ height: 24 }} />
    </nav>
  );
}
