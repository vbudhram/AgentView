'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent } from '@/lib/ui-types';
import { classifySystemNote, describeToolCall, prettyToolInput, shortToolName, shortenPaths, stripAnsi, type SystemNote } from '@/lib/describe';
import { useTapActivate } from '@/lib/mobile';

// GFM (tables, autolinked URLs, strikethrough) plus theme-fitting renderers:
// links open in a new tab; wide tables scroll inside their own container.
const remarkPlugins = [remarkGfm];
const mdComponents: Components = {
  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _n, ...props }) => (
    <div className="table-wrap"><table {...props} /></div>
  ),
};

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={mdComponents}>
      {text}
    </ReactMarkdown>
  );
}

const MAX_TOOL_BODY = 4000;
const MAX_THINKING = 300;

// Collapsed rows carry the evidence inline: the command for a call, a size
// summary + first line for a result. Clicking still expands the full payload.
function toolCallSummary(name: string, input: string): { label: string; detail: string } {
  const label = shortToolName(name);
  const described = describeToolCall(name, input);
  const detail = described.startsWith(`${label}: `) ? described.slice(label.length + 2) : '';
  return { label, detail };
}

function toolResultSummary(output: string, isError: boolean): { label: string; detail: string } {
  const trimmed = output.trim();
  if (!trimmed) return { label: isError ? 'error' : 'result', detail: '(empty)' };
  const lines = trimmed.split('\n');
  const first = shortenPaths(lines[0]).replace(/\s+/g, ' ').trim();
  const firstCut = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  const label = isError ? 'error' : lines.length > 1 ? `${lines.length} lines` : 'result';
  return { label, detail: firstCut };
}

function ToolBlock({ e }: { e: Extract<AgentEvent, { kind: 'tool_call' | 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  // A capped body hides its overflow honestly: a fade plus a "show all"
  // button instead of a silent inner scroll region that traps the thumb.
  const [full, setFull] = useState(false);
  const [moreLines, setMoreLines] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const toggleTap = useTapActivate(() => { setOpen((o) => !o); setFull(false); });
  const showAllTap = useTapActivate(() => setFull(true));
  // Bottom collapse: a long body strands the reader far from the toggle, so
  // close from the end and bring the toggle row back into view.
  const collapseTap = useTapActivate(() => {
    setOpen(false);
    setFull(false);
    rootRef.current?.scrollIntoView({ block: 'nearest' });
  });
  useLayoutEffect(() => {
    if (!open || full) { setMoreLines(0); return; }
    const el = bodyRef.current;
    if (!el) return;
    const hidden = el.scrollHeight - el.clientHeight;
    if (hidden <= 4) { setMoreLines(0); return; }
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 16;
    setMoreLines(Math.max(1, Math.round(hidden / lineH)));
  }, [open, full]);
  const isCall = e.kind === 'tool_call';
  const glyph = isCall ? '→' : e.isError ? '✗' : '✓';
  const color = isCall ? 'var(--cyan)' : e.isError ? 'var(--red)' : 'var(--green-deep)';
  const { label, detail } = isCall
    ? toolCallSummary(e.name, e.input)
    : toolResultSummary(stripAnsi(e.output), e.isError ?? false);
  // calls expand to key: value lines instead of raw JSON; results lose ANSI noise
  const body = isCall ? prettyToolInput(e.input) : stripAnsi(e.output);
  const long = body.length > 700 || body.split('\n').length > 12;
  return (
    <div ref={rootRef} style={{ margin: '2px 0' }}>
      <button className="tool-toggle" {...toggleTap} style={{ color }}>
        <span style={{ display: 'inline-block', width: 14, color: 'var(--text-faint)' }}>
          {open ? '▾' : '▸'}
        </span>
        {glyph} {label}
        {detail && (
          <span className="tool-detail">{detail}</span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ position: 'relative' }}>
              <pre ref={bodyRef} className={`tool-body${full ? ' tool-body-full' : ''}`}>
                {body.slice(0, MAX_TOOL_BODY) || '(empty)'}
                {body.length > MAX_TOOL_BODY ? '\n… truncated' : ''}
              </pre>
              {moreLines > 0 && <div className="tool-fade" />}
            </div>
            {moreLines > 0 && (
              <button className="tool-collapse-btn" {...showAllTap}>
                ▾ show all ({moreLines} more lines)
              </button>
            )}
            {long && moreLines === 0 && (
              <button className="tool-collapse-btn" {...collapseTap}>
                ▴ collapse
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Harness-injected user-role noise: a compact, muted, expandable note —
// never attributed to the owner.
function SystemNoteBlock({ note, text }: { note: SystemNote; text: string }) {
  const [open, setOpen] = useState(false);
  const toggleTap = useTapActivate(() => setOpen((o) => !o));
  return (
    <div style={{ margin: '2px 0' }}>
      <button className="tool-toggle" {...toggleTap} style={{ color: 'var(--text-faint)' }}>
        <span style={{ display: 'inline-block', width: 14 }}>{open ? '▾' : '▸'}</span>
        ⚙ system · {note.tag}
        {note.summary && <span className="tool-detail">{note.summary}</span>}
      </button>
      {open && (
        <pre className="tool-body tool-body-full">
          {text.slice(0, MAX_TOOL_BODY)}
          {text.length > MAX_TOOL_BODY ? '\n… truncated' : ''}
        </pre>
      )}
    </div>
  );
}

function Item({ e }: { e: AgentEvent }) {
  switch (e.kind) {
    case 'user_message': {
      const note = classifySystemNote(e.text);
      if (note) return <SystemNoteBlock note={note} text={e.text} />;
      return (
        <div className="msg-user">
          <div className="msg-label">YOU</div>
          <div className="md"><Markdown text={e.text} /></div>
        </div>
      );
    }
    case 'assistant_message':
      return (
        <div className="md" style={{ padding: '5px 0' }}>
          <Markdown text={e.text} />
        </div>
      );
    case 'thinking':
      return (
        <div style={{ color: 'var(--text-faint)', fontStyle: 'italic', fontSize: 11.5, padding: '3px 0' }}>
          ∴ {e.text.slice(0, MAX_THINKING)}{e.text.length > MAX_THINKING ? '…' : ''}
        </div>
      );
    case 'tool_call':
    case 'tool_result':
      return <ToolBlock e={e} />;
    default:
      return null;
  }
}

// Render only the tail of long transcripts: a 70k-event session must not
// freeze the tab. "Show earlier" reveals older events in chunks big enough
// that a 24k-event session takes taps in the dozens, not the hundreds.
const WINDOW = 250;
const CHUNK = 1000;

// A gap this long between messages earns a time divider.
const DIVIDER_GAP_MS = 30 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dividerLabel(ts: string): string | null {
  const d = new Date(ts);
  if (!(d.getTime() > 0)) return null;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString()
    ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hm}`;
}

function TimeDivider({ ts }: { ts: string }) {
  const label = dividerLabel(ts);
  if (!label) return null;
  return <div className="time-divider"><span>{label}</span></div>;
}

function relAgo(iso: string, nowMs: number): string {
  const s = Math.max(0, (nowMs - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 4 ? `${h}h${m % 60}m ago` : `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ConversationView({ events, earlierAvailable = 0, onLoadEarlier, onLoadAll, endedAt = null }: {
  events: AgentEvent[];
  // events the server holds before the loaded tail; tapping "show earlier"
  // near the buffer's start asks the parent to widen the tail
  earlierAvailable?: number;
  onLoadEarlier?: () => void;
  // "jump to start" needs the whole transcript client-side
  onLoadAll?: () => void;
  // set when the session is over: renders the end-of-transcript marker
  endedAt?: string | null;
}) {
  const visible = events.filter((e) => e.kind !== 'turn_status');
  const [shown, setShown] = useState(WINDOW);
  // keeps the "ended · Nm ago" marker honest while the view stays open
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!endedAt) return;
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, [endedAt]);
  // 'end' anchors the window to the newest events (the default); 'start'
  // anchors it to the beginning after a jump-to-start.
  const [anchor, setAnchor] = useState<'end' | 'start'>('end');
  const earlierTap = useTapActivate(() => {
    const el = scrollRef.current;
    expandAnchor.current = el ? el.scrollHeight - el.scrollTop : null;
    setShown((n) => n + CHUNK);
    // prefetch from the server before the local buffer runs out
    if (start <= CHUNK && earlierAvailable > 0) onLoadEarlier?.();
  });
  const laterTap = useTapActivate(() => setShown((n) => n + CHUNK));
  // The end window never shifts older rows when live events arrive.
  const start = anchor === 'end' ? Math.max(0, visible.length - shown) : 0;
  const windowed = anchor === 'end' ? visible.slice(start) : visible.slice(0, shown);
  const laterHidden = anchor === 'start' ? Math.max(0, visible.length - shown) : 0;
  // items already present at mount render statically; only later items animate in
  const initial = useRef(visible.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const firstScroll = useRef(true);
  // distance from the bottom, captured just before revealing earlier events
  const expandAnchor = useRef<number | null>(null);

  // Jump-to-latest: shown while detached from the bottom; counts the events
  // that arrive while the reader is away.
  const [detached, setDetached] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLen = useRef(visible.length);
  useEffect(() => {
    const delta = visible.length - prevLen.current;
    prevLen.current = visible.length;
    if (delta > 0 && !stickRef.current) setNewCount((n) => n + delta);
  }, [visible.length]);
  const jumpToLatest = () => {
    if (anchor === 'start') { setAnchor('end'); setShown(WINDOW); }
    pendingStart.current = false;
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setDetached(false);
    setNewCount(0);
  };
  // Jump to start: load the full transcript, flip the anchor, land at the top.
  const pendingStart = useRef(false);
  const startTap = useTapActivate(() => {
    if (earlierAvailable > 0) onLoadAll?.();
    pendingStart.current = true;
    stickRef.current = false;
    setDetached(true);
    setAnchor('start');
    setShown(WINDOW);
  });
  // Prev/next landmark: the owner's own rendered messages.
  const jumpUser = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const contTop = el.getBoundingClientRect().top;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('.msg-user'))
      .map((n) => ({ n, y: n.getBoundingClientRect().top - contTop + el.scrollTop }));
    let target: number | null = null;
    if (dir === -1) {
      for (const { y } of nodes) { if (y < el.scrollTop - 8) target = y; else break; }
    } else {
      for (const { y } of nodes) { if (y > el.scrollTop + 8) { target = y; break; } }
    }
    if (target == null) return;
    stickRef.current = false;
    el.scrollTo({ top: Math.max(0, target - 8), behavior: 'smooth' });
  };
  const prevUserTap = useTapActivate(() => jumpUser(-1));
  const nextUserTap = useTapActivate(() => jumpUser(1));

  // layout effect: the first bottom-anchor lands before paint (no top flash)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor === 'start' && pendingStart.current) {
      // hold the top until the full transcript has arrived
      el.scrollTop = 0;
      if (earlierAvailable === 0) pendingStart.current = false;
      return;
    }
    if (expandAnchor.current != null) {
      // keep the reader's place while earlier events mount above
      el.scrollTop = el.scrollHeight - expandAnchor.current;
      expandAnchor.current = null;
      return;
    }
    if (!stickRef.current) return;
    if (firstScroll.current) el.scrollTop = el.scrollHeight;
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    firstScroll.current = false;
  }, [windowed.length, start, anchor, earlierAvailable]);

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div
        ref={scrollRef}
        className="nav-scroll"
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          // stick to the bottom only while the user is near it
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stickRef.current = near;
          setDetached(!near);
          if (near) setNewCount(0);
        }}
        style={{
          height: '100%', overflowY: 'auto', overscrollBehavior: 'contain',
          padding: '14px 18px calc(24px + env(safe-area-inset-bottom))',
        }}
      >
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          {visible.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 11.5, color: 'var(--text-faint)' }}>
              no conversation events yet
            </div>
          )}
          {anchor === 'end' && (start > 0 || earlierAvailable > 0) && (
            <div className="earlier-row">
              <button className="show-earlier-btn" {...earlierTap}>
                ▲ show earlier ({(start + earlierAvailable).toLocaleString()} more)
              </button>
              <button className="show-earlier-btn jump-start-btn" {...startTap}>
                ⇤ start
              </button>
            </div>
          )}
          {windowed.map((e, i) => {
            const prev = i > 0 ? windowed[i - 1] : null;
            const gap = !prev || new Date(e.ts).getTime() - new Date(prev.ts).getTime() >= DIVIDER_GAP_MS;
            return (
              <motion.div
                key={start + i}
                title={new Date(e.ts).toLocaleString()}
                initial={start + i < initial.current ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                {gap && <TimeDivider ts={e.ts} />}
                <Item e={e} />
              </motion.div>
            );
          })}
          {laterHidden > 0 && (
            <button className="show-earlier-btn" {...laterTap}>
              ▼ show later ({laterHidden.toLocaleString()} more)
            </button>
          )}
          {endedAt && laterHidden === 0 && (
            <div className="conv-ended" title={new Date(endedAt).toLocaleString()}>
              ■ session ended · {relAgo(endedAt, nowMs)}
            </div>
          )}
        </div>
      </div>
      {(detached || anchor === 'start') && (
        <button
          className={`jump-pill${newCount > 0 ? ' fresh' : ''}`}
          onClick={jumpToLatest}
          aria-label="jump to the latest message"
        >
          ↓ latest{newCount > 0 ? <span className="jump-count">{newCount > 99 ? '99+' : newCount}</span> : null}
        </button>
      )}
      <div className="msg-nav" aria-label="jump between your messages">
        <button {...prevUserTap} aria-label="previous message from you" title="previous YOU message">▲❯</button>
        <button {...nextUserTap} aria-label="next message from you" title="next YOU message">▼❯</button>
      </div>
    </div>
  );
}
