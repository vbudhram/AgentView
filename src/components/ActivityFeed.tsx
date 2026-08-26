'use client';
import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import type { AgentEvent } from '@/lib/ui-types';
import { describeToolCall } from '@/lib/describe';

const CLIP = 140;

function row(e: AgentEvent): { glyph: string; color: string; text: string; raw?: string } {
  switch (e.kind) {
    case 'user_message':
      return { glyph: '❯', color: 'var(--green)', text: e.text.slice(0, CLIP) };
    case 'assistant_message':
      return { glyph: '◆', color: 'var(--text-dim)', text: e.text.slice(0, CLIP) };
    case 'thinking':
      return { glyph: '∴', color: 'var(--text-faint)', text: e.text.slice(0, CLIP) };
    case 'tool_call':
      // humanized summary; the raw payload survives on hover
      return { glyph: '⚙', color: 'var(--cyan)', text: describeToolCall(e.name, e.input), raw: `${e.name} ${e.input.slice(0, 800)}` };
    case 'tool_result':
      return e.isError
        ? { glyph: '✗', color: 'var(--red)', text: e.output.slice(0, CLIP) }
        : { glyph: '✓', color: 'var(--green-deep)', text: e.output.slice(0, CLIP) };
    case 'turn_status':
      return { glyph: '—', color: 'var(--text-faint)', text: `turn ${e.status}` };
  }
}

export function ActivityFeed({ events }: { events: AgentEvent[] }) {
  // rows already present at mount render statically; only later rows animate in
  const initial = useRef(events.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div
      ref={scrollRef}
      className="nav-scroll"
      onScroll={() => {
        const el = scrollRef.current;
        // stick to the bottom only while the user is near it
        if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      style={{ height: '100%', overflowY: 'auto', padding: '12px 18px 20px', fontSize: 11.5 }}
    >
      {events.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-faint)' }}>
          no activity yet
        </div>
      )}
      {events.map((e, i) => {
        const r = row(e);
        return (
          <motion.div
            key={i}
            initial={i < initial.current ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0',
              whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{e.ts.slice(11, 19)}</span>
            <span style={{ color: r.color, flexShrink: 0, width: 12, textAlign: 'center' }}>{r.glyph}</span>
            <span
              title={r.raw}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-dim)' }}
            >
              {r.text.replace(/\s+/g, ' ')}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}
