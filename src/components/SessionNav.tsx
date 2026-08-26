'use client';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { SessionSummary, SourceKind } from '@/lib/ui-types';

function rel(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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

function Row({ s, selected, onSelect, now }: {
  s: SessionSummary; selected: boolean; onSelect: (k: string) => void; now: number;
}) {
  const project = s.cwd ? s.cwd.split('/').pop() : '?';
  const attention = s.status === 'needs_input' ? 'row-needs_input' : s.status === 'blocked' ? 'row-blocked' : '';
  const ended = s.status === 'ended';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ layout: { type: 'spring', stiffness: 500, damping: 40 } }}
      onClick={() => onSelect(s.key)}
      className={`nav-row ${attention}`}
      style={{
        padding: '7px 10px 7px 8px',
        cursor: 'pointer',
        borderLeft: `2px solid ${selected ? 'var(--green)' : 'transparent'}`,
        background: selected ? 'var(--sel-bg)' : undefined,
        opacity: ended ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className={`dot dot-${s.status}`} />
        <b style={{
          fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
          textOverflow: 'ellipsis', color: selected ? 'var(--text)' : undefined,
        }}>
          {project}
        </b>
        <AgentBadge agent={s.agent} />
        <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>
          {s.source === 'desktop' ? 'app' : 'term'}
        </span>
        {s.steerable && (
          <span title="steerable" style={{ fontSize: 10, color: 'var(--cyan)', flexShrink: 0 }}>⌁</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'baseline', flexShrink: 0 }}>
          {s.status === 'needs_input' && (
            <span className="word-needs" style={{ color: 'var(--amber)', fontSize: 9, fontWeight: 600, letterSpacing: '0.08em' }}>
              NEEDS YOU
            </span>
          )}
          {s.status === 'blocked' && (
            <span className="word-blocked" style={{ color: 'var(--red)', fontSize: 9, fontWeight: 600, letterSpacing: '0.08em' }}>
              APPROVE?
            </span>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{rel(s.lastActivity, now)}</span>
        </span>
      </div>
      <div style={{ paddingLeft: 14, marginTop: 2, minHeight: 15 }}>
        {s.status === 'working' && s.lastTool ? (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={s.lastTool + s.eventCount}
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -8, opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                fontSize: 10.5, color: 'var(--green-deep)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              ⚙ {s.lastTool}
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

  const visible = sessions.filter((s) => filter === 'all' || s.source === filter);
  const live = visible.filter((s) => s.status !== 'ended');
  const recent = visible.filter((s) => s.status === 'ended');

  const group = (label: string, items: SessionSummary[]) => (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '14px 10px 4px',
        fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.22em', color: 'var(--text-faint)', textTransform: 'uppercase',
      }}>
        <span>{label}</span>
        <span style={{ color: label === 'Live' && items.length > 0 ? 'var(--green)' : undefined }}>{items.length}</span>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      {items.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 10.5, color: 'var(--text-faint)' }}>— none —</div>
      )}
      <AnimatePresence initial={false}>
        {items.map((s) => (
          <Row key={s.key} s={s} selected={s.key === selectedKey} onSelect={onSelect} now={now} />
        ))}
      </AnimatePresence>
    </div>
  );

  return (
    <nav
      className="nav-scroll scanlines"
      style={{
        position: 'relative', width: 300, height: '100vh', overflowY: 'auto', flexShrink: 0,
        background: 'var(--bg-nav)', borderRight: '1px solid var(--border)',
      }}
    >
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
          value={filter}
          onChange={(e) => onFilter(e.target.value as SourceKind | 'all')}
          style={{ marginLeft: 'auto' }}
        >
          <option value="all">All</option>
          <option value="terminal">Terminal</option>
          <option value="desktop">Desktop</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      {group('Live', live)}
      {group('Recent', recent)}
      <div style={{ height: 24 }} />
    </nav>
  );
}
