'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent } from '@/lib/ui-types';
import { prettyToolInput, shortToolName } from '@/lib/describe';

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

function ToolBlock({ e }: { e: Extract<AgentEvent, { kind: 'tool_call' | 'tool_result' }> }) {
  const [open, setOpen] = useState(false);
  const isCall = e.kind === 'tool_call';
  const glyph = isCall ? '→' : e.isError ? '✗' : '✓';
  const label = isCall ? shortToolName(e.name) : e.isError ? 'error' : 'result';
  const color = isCall ? 'var(--cyan)' : e.isError ? 'var(--red)' : 'var(--green-deep)';
  // calls expand to key: value lines instead of raw JSON
  const body = isCall ? prettyToolInput(e.input) : e.output;
  return (
    <div style={{ margin: '2px 0' }}>
      <button className="tool-toggle" onClick={() => setOpen(!open)} style={{ color }}>
        <span style={{ display: 'inline-block', width: 14, color: 'var(--text-faint)' }}>
          {open ? '▾' : '▸'}
        </span>
        {glyph} {label}
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

export function ConversationView({ events }: { events: AgentEvent[] }) {
  const visible = events.filter((e) => e.kind !== 'turn_status');
  // items already present at mount render statically; only later items animate in
  const initial = useRef(visible.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const firstScroll = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [visible.length]);

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
        {visible.map((e, i) => (
          <motion.div
            key={i}
            initial={i < initial.current ? false : { opacity: 0, y: 10 }}
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
