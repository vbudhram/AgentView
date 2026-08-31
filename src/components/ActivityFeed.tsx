'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { AgentEvent } from '@/lib/ui-types';
import { describeToolCall, plainText, stripAnsi } from '@/lib/describe';

const CLIP = 140;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Local wall-clock stamp; events from another day carry their date so an
// old session's feed cannot pass for today's.
function stamp(iso: string, todayKey: string): string {
  const d = new Date(iso);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
  return d.toDateString() === todayKey ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

function row(e: AgentEvent): { glyph: string; color: string; text: string; raw?: string } {
  switch (e.kind) {
    case 'user_message':
      return { glyph: '❯', color: 'var(--green)', text: plainText(e.text.slice(0, CLIP * 2)).slice(0, CLIP) };
    case 'assistant_message':
      return { glyph: '◆', color: 'var(--text-dim)', text: plainText(e.text.slice(0, CLIP * 2)).slice(0, CLIP) };
    case 'thinking':
      return { glyph: '∴', color: 'var(--text-faint)', text: plainText(e.text.slice(0, CLIP * 2)).slice(0, CLIP) };
    case 'tool_call':
      // humanized summary; the raw payload survives on hover
      return { glyph: '⚙', color: 'var(--cyan)', text: describeToolCall(e.name, e.input), raw: `${e.name} ${e.input.slice(0, 800)}` };
    case 'tool_result':
      return e.isError
        ? { glyph: '✗', color: 'var(--red)', text: stripAnsi(e.output.slice(0, CLIP * 4)).slice(0, CLIP) }
        : { glyph: '✓', color: 'var(--green-deep)', text: stripAnsi(e.output.slice(0, CLIP * 4)).slice(0, CLIP) };
    case 'turn_status':
      return { glyph: '—', color: 'var(--text-faint)', text: `turn ${e.status}` };
  }
}

// Same tail-windowing as the conversation: huge feeds must not freeze the tab.
const WINDOW = 250;
const CHUNK = 250;

export function ActivityFeed({ events, earlierAvailable = 0, onLoadEarlier }: {
  events: AgentEvent[];
  // events the server holds before the loaded tail; tapping "show earlier"
  // near the buffer's start asks the parent to widen the tail
  earlierAvailable?: number;
  onLoadEarlier?: () => void;
}) {
  const [shown, setShown] = useState(WINDOW);
  const start = Math.max(0, events.length - shown);
  const windowed = events.slice(start);
  const todayKey = new Date().toDateString();
  // rows already present at mount render statically; only later rows animate in
  const initial = useRef(events.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const expandAnchor = useRef<number | null>(null);

  // layout effect: the first bottom-anchor lands before paint (no top flash)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (expandAnchor.current != null) {
      el.scrollTop = el.scrollHeight - expandAnchor.current;
      expandAnchor.current = null;
      return;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [windowed.length, start]);

  return (
    <div
      ref={scrollRef}
      className="nav-scroll"
      onScroll={() => {
        const el = scrollRef.current;
        // stick to the bottom only while the user is near it
        if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      style={{
        height: '100%', overflowY: 'auto', overscrollBehavior: 'contain',
        padding: '12px 18px calc(20px + env(safe-area-inset-bottom))', fontSize: 'var(--fs-feed, 11.5px)',
      }}
    >
      {events.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-faint)' }}>
          no activity yet
        </div>
      )}
      {(start > 0 || earlierAvailable > 0) && (
        <button
          className="show-earlier-btn"
          onClick={() => {
            const el = scrollRef.current;
            expandAnchor.current = el ? el.scrollHeight - el.scrollTop : null;
            setShown((n) => n + CHUNK);
            // prefetch from the server before the local buffer runs out
            if (start <= CHUNK && earlierAvailable > 0) onLoadEarlier?.();
          }}
        >
          ▲ show earlier ({(start + earlierAvailable).toLocaleString()} more)
        </button>
      )}
      {windowed.map((e, i) => {
        const r = row(e);
        return (
          <motion.div
            key={start + i}
            initial={start + i < initial.current ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0',
              whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{stamp(e.ts, todayKey)}</span>
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
