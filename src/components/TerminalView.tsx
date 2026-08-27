'use client';
import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type LinkState = 'connecting' | 'live' | 'closed' | 'unsteerable';

const LINK_LABEL: Record<LinkState, string> = {
  connecting: 'linking…',
  live: 'live mirror',
  closed: 'link closed',
  unsteerable: 'not steerable',
};
const LINK_COLOR: Record<LinkState, string> = {
  connecting: 'var(--text-faint)',
  live: 'var(--green)',
  closed: 'var(--red)',
  unsteerable: 'var(--amber)',
};

export function TerminalView({ sessionKey }: { sessionKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pinned to the bottom (where the prompt lives) until the user scrolls up.
  const pinned = useRef(true);
  const [link, setLink] = useState<LinkState>('connecting');

  const pinToBottom = () => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    setLink('connecting');
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      if (disposed || !ref.current) return;
      // The mirror renders at the PTY's exact cols×rows (the size control
      // frame sets them); fitting to the container corrupts absolute
      // cursor-positioned repaints.
      term = new Terminal({
        fontSize: 12.5,
        fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        scrollback: 5000,
        theme: {
          background: '#0a0d0b',
          foreground: '#d9e2da',
          cursor: '#4ade80',
          cursorAccent: '#0a0d0b',
          selectionBackground: 'rgba(74, 222, 128, 0.25)',
        },
      });
      term.open(ref.current);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/term?key=${encodeURIComponent(sessionKey)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (!disposed) setLink('live'); };
      ws.onmessage = (m) => {
        // Server text frames carry control JSON; binary frames carry PTY bytes.
        if (typeof m.data === 'string') {
          try {
            const msg = JSON.parse(m.data);
            if (msg?.t === 'size' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
              term?.resize(msg.cols, msg.rows);
              requestAnimationFrame(pinToBottom);
            }
          } catch {}
          return;
        }
        term?.write(new Uint8Array(m.data as ArrayBuffer), pinToBottom);
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4004) {
          setLink('unsteerable');
          term?.writeln('\r\n[not steerable — launch this session with `av`]');
        } else {
          setLink('closed');
        }
      };
      term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(d); });
    })();
    return () => {
      disposed = true;
      ws?.close();
      term?.dispose();
    };
  }, [sessionKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflow: 'hidden', background: '#0a0d0b' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 18px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-raised)', flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700,
          letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--text-faint)',
        }}>
          terminal
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: LINK_COLOR[link] }}>
          <span
            className={link === 'live' ? 'dot dot-working' : 'dot'}
            style={{ width: 6, height: 6, background: link === 'live' ? undefined : LINK_COLOR[link] }}
          />
          {LINK_LABEL[link]}
        </span>
      </div>
      {/* the real-size grid scrolls inside this pane, never at page level */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', padding: '8px 2px 8px 12px' }}
      >
        <div ref={ref} style={{ width: 'max-content' }} />
      </div>
    </div>
  );
}
