'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent } from '@/lib/ui-types';
import { describeToolCall, prettyToolInput, shortToolName, stripAnsi } from '@/lib/describe';

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
  const first = lines[0].replace(/\s+/g, ' ').trim();
  const firstCut = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  const label = isError ? 'error' : lines.length > 1 ? `${lines.length} lines` : 'result';
  return { label, detail: firstCut };
}

function ToolBlock({ e }: { e: Extract<AgentEvent, { kind: 'tool_call' | 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  const isCall = e.kind === 'tool_call';
  const glyph = isCall ? '→' : e.isError ? '✗' : '✓';
  const color = isCall ? 'var(--cyan)' : e.isError ? 'var(--red)' : 'var(--green-deep)';
  const { label, detail } = isCall
    ? toolCallSummary(e.name, e.input)
    : toolResultSummary(stripAnsi(e.output), e.isError ?? false);
  // calls expand to key: value lines instead of raw JSON; results lose ANSI noise
  const body = isCall ? prettyToolInput(e.input) : stripAnsi(e.output);
  return (
    <div style={{ margin: '2px 0' }}>
      <button className="tool-toggle" onClick={() => setOpen(!open)} style={{ color }}>
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
            <pre className="tool-body">
              {body.slice(0, MAX_TOOL_BODY) || '(empty)'}
              {body.length > MAX_TOOL_BODY ? '\n… truncated' : ''}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Item({ e }: { e: AgentEvent }) {
  switch (e.kind) {
    case 'user_message':
      return (
        <div className="msg-user">
          <div className="msg-label">YOU</div>
          <div className="md"><Markdown text={e.text} /></div>
        </div>
      );
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
// freeze the tab. "Show earlier" reveals older events in chunks.
const WINDOW = 250;
const CHUNK = 250;

export function ConversationView({ events }: { events: AgentEvent[] }) {
  const visible = events.filter((e) => e.kind !== 'turn_status');
  const [shown, setShown] = useState(WINDOW);
  // The window is anchored to the end, so live events never shift older rows.
  const start = Math.max(0, visible.length - shown);
  const windowed = visible.slice(start);
  // items already present at mount render statically; only later items animate in
  const initial = useRef(visible.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const firstScroll = useRef(true);
  // distance from the bottom, captured just before revealing earlier events
  const expandAnchor = useRef<number | null>(null);

  // layout effect: the first bottom-anchor lands before paint (no top flash)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
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
      style={{ height: '100%', overflowY: 'auto', padding: '14px 18px 24px' }}
    >
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        {visible.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 11.5, color: 'var(--text-faint)' }}>
            no conversation events yet
          </div>
        )}
        {start > 0 && (
          <button
            className="show-earlier-btn"
            onClick={() => {
              const el = scrollRef.current;
              expandAnchor.current = el ? el.scrollHeight - el.scrollTop : null;
              setShown((n) => n + CHUNK);
            }}
          >
            ▲ show earlier ({start.toLocaleString()} more)
          </button>
        )}
        {windowed.map((e, i) => (
          <motion.div
            key={start + i}
            title={new Date(e.ts).toLocaleString()}
            initial={start + i < initial.current ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <Item e={e} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
