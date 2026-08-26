'use client';
import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { accentSoft } from '@/lib/persona';

// Read-only live monitor of the session PTY. It never sends input: no
// onData handler, stdin disabled, and the xterm surface takes no pointer
// events. Clicking the card jumps to the full Terminal tab.

const COLLAPSE_KEY = 'agentview.termPreview.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
function writeCollapsed(v: boolean): void {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch {}
}

type LinkState = 'connecting' | 'live' | 'closed';

export function TerminalPreview({ sessionKey, hue, open, onOpenTerminal }: {
  sessionKey: string;
  hue: number;
  open: boolean;              // false while the card animates away (bridge drop)
  onOpenTerminal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [link, setLink] = useState<LinkState>('connecting');
  const [dead, setDead] = useState(false);       // 4004: hide the card
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    setLink('connecting');
    setDead(false);
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
        fontSize: 10.5,
        fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        scrollback: 300,
        disableStdin: true,
        cursorBlink: false,
        cursorInactiveStyle: 'none',
        theme: {
          background: '#0a0d0b',
          foreground: '#b7c2b9',
          cursor: '#0a0d0b',
          cursorAccent: '#0a0d0b',
          selectionBackground: 'rgba(74, 222, 128, 0.25)',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      try { fit.fit(); } catch {}
      ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
      ro.observe(ref.current);

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/term?key=${encodeURIComponent(sessionKey)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (!disposed) setLink('live'); };
      ws.onmessage = (m) => {
        const t = term;
        if (!t) return;
        t.write(new Uint8Array(m.data as ArrayBuffer));
        // a monitor tracks the tail; xterm pins the viewport if the user scrolled
        t.scrollToBottom();
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4004) setDead(true);
        else setLink('closed');
      };
      // deliberately no term.onData / no ws.send: the preview is read-only
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [sessionKey]);

  const visible = open && !dead;
  return (
    <div className={`term-preview-shell ${visible ? '' : 'gone'}`} aria-hidden={!visible}>
      <div className="term-preview-shell-inner">
        <div
          className="term-preview"
          role="button"
          tabIndex={visible ? 0 : -1}
          aria-label="open the terminal tab"
          style={{ borderLeft: `2px solid ${accentSoft(hue)}` }}
          onClick={onOpenTerminal}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTerminal(); }
          }}
        >
          <div className="term-preview-head">
            <span
              className={link === 'live' ? 'dot dot-working' : 'dot'}
              style={{
                width: 6, height: 6,
                background: link === 'live' ? undefined : link === 'closed' ? 'var(--red)' : 'var(--text-faint)',
              }}
            />
            <span className="term-preview-label" style={{ color: accentSoft(hue) }}>
              live terminal
            </span>
            {link !== 'live' && (
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                {link === 'connecting' ? 'linking…' : 'link closed'}
              </span>
            )}
            <span className="term-preview-hint">open terminal ⇥</span>
            <button
              className="term-preview-chevron"
              aria-label={collapsed ? 'expand the preview' : 'collapse the preview'}
              aria-expanded={!collapsed}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((c) => { writeCollapsed(!c); return !c; });
              }}
            >
              <span style={{
                display: 'inline-block',
                transform: collapsed ? 'rotate(-90deg)' : 'none',
                transition: 'transform 0.18s ease',
              }}>▾</span>
            </button>
          </div>
          <div className={`term-preview-body-wrap ${collapsed ? 'closed' : ''}`}>
            <div className="term-preview-body-inner">
              <div ref={ref} className="term-preview-screen" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
