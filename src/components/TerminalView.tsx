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
  const [link, setLink] = useState<LinkState>('connecting');

  useEffect(() => {
    setLink('connecting');
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !ref.current) return;
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
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();
      // Refit once layout and fonts settle; a fit that raced either can size
      // the terminal wider than the pane and force page-level overflow.
      requestAnimationFrame(() => { try { fit.fit(); } catch {} });
      document.fonts?.ready.then(() => { if (!disposed) try { fit.fit(); } catch {} });
      ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
      ro.observe(ref.current);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/term?key=${encodeURIComponent(sessionKey)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (!disposed) setLink('live'); };
      ws.onmessage = (m) => term?.write(new Uint8Array(m.data as ArrayBuffer));
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
      ro?.disconnect();
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
      <div ref={ref} style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', padding: '8px 2px 8px 12px' }} />
    </div>
  );
}
