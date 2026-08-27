'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useIsMobile, usePressActivate } from '@/lib/mobile';

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

// Accessory keys Claude Code's own UI is driven by: interrupt, mode/menu
// navigation, and submit. Sent as raw bytes over the same WS path as typing.
const KEYS: { label: string; seq: string; hint: string }[] = [
  { label: 'esc', seq: '\x1b', hint: 'Escape' },
  { label: 'tab', seq: '\t', hint: 'Tab' },
  { label: '^C', seq: '\x03', hint: 'Ctrl+C' },
  { label: '↑', seq: '\x1b[A', hint: 'Up' },
  { label: '↓', seq: '\x1b[B', hint: 'Down' },
  { label: '←', seq: '\x1b[D', hint: 'Left' },
  { label: '→', seq: '\x1b[C', hint: 'Right' },
  { label: '⏎', seq: '\r', hint: 'Enter' },
];

function Key({ label, hint, onSend }: { label: string; hint: string; onSend: () => void }) {
  const press = usePressActivate(onSend);
  return (
    <button
      className="term-key"
      aria-label={hint}
      // fires on touch-down like a real key; preventDefault keeps focus
      // (and the soft keyboard) on the compose field
      onPointerDown={(e) => { e.preventDefault(); press.onPointerDown(); }}
      onClick={press.onClick}
    >
      {label}
    </button>
  );
}

export function TerminalView({ sessionKey }: { sessionKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitWrapRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Pinned to the bottom (where the prompt lives) until the user scrolls up.
  const pinned = useRef(true);
  const [link, setLink] = useState<LinkState>('connecting');
  const isMobile = useIsMobile();
  // The PTY grid is wider than a phone: scale-to-fit is the phone default,
  // with a 1:1 toggle for reading fine detail (two-axis pan).
  const [fit, setFit] = useState(isMobile);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const [compose, setCompose] = useState('');
  const fitTap = usePressActivate(() => setFit((f) => !f));

  const pinToBottom = () => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  };

  // Fit mode: keep the PTY-exact grid, shrink it to the pane width with a
  // CSS transform (same trick as the preview card), bottom still anchored.
  const rescale = useCallback(() => {
    const host = ref.current;
    const wrap = fitWrapRef.current;
    const scroller = scrollRef.current;
    if (!host || !wrap || !scroller) return;
    if (!fitRef.current) {
      host.style.transform = '';
      wrap.style.height = '';
      return;
    }
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    const w = screen?.offsetWidth || host.offsetWidth;
    const h = screen?.offsetHeight || host.offsetHeight;
    if (!w || !h) return;
    const s = Math.min(1, (scroller.clientWidth - 14) / w);
    host.style.transform = `scale(${s})`;
    host.style.transformOrigin = 'top left';
    wrap.style.height = `${Math.ceil(h * s)}px`;
    pinToBottom();
  }, []);

  useEffect(() => { rescale(); }, [fit, rescale]);

  useEffect(() => {
    setLink('connecting');
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
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
      rescale();
      document.fonts?.ready.then(() => { if (!disposed) rescale(); });
      if (scrollRef.current) {
        ro = new ResizeObserver(() => rescale());
        ro.observe(scrollRef.current);
      }

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/term?key=${encodeURIComponent(sessionKey)}`);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (!disposed) setLink('live'); };
      ws.onmessage = (m) => {
        // Server text frames carry control JSON; binary frames carry PTY bytes.
        if (typeof m.data === 'string') {
          try {
            const msg = JSON.parse(m.data);
            if (msg?.t === 'size' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
              term?.resize(msg.cols, msg.rows);
              requestAnimationFrame(() => { rescale(); pinToBottom(); });
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
      ro?.disconnect();
      ws?.close();
      wsRef.current = null;
      term?.dispose();
    };
  }, [sessionKey, rescale]);

  const sendBytes = (s: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(s);
      pinned.current = true;
      pinToBottom();
    }
  };
  const sendGuard = useRef(0);
  const sendCompose = () => {
    if (Date.now() - sendGuard.current < 500) return; // pointerdown + submit dedupe
    sendGuard.current = Date.now();
    if (!compose) { sendBytes('\r'); return; }
    sendBytes(`${compose}\r`);
    setCompose('');
  };

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
        {isMobile && (
          <button className="term-fit-btn" aria-pressed={fit} {...fitTap}>
            {fit ? 'fit ▣' : '1:1 ⤢'}
          </button>
        )}
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
        style={{
          flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto',
          overscrollBehavior: 'contain', padding: '8px 2px 8px 12px',
        }}
      >
        <div ref={fitWrapRef} style={{ overflow: fit ? 'hidden' : 'visible', width: fit ? '100%' : 'max-content' }}>
          <div ref={ref} style={{ width: 'max-content' }} />
        </div>
      </div>
      {isMobile && link !== 'unsteerable' && (
        // Phone input system: xterm's hidden textarea is unusable on iOS, so
        // the compose field is the primary input; chips carry the control keys.
        <div className="term-input-bar">
          <div className="term-keys">
            {KEYS.map((k) => (
              <Key key={k.label} label={k.label} hint={k.hint} onSend={() => sendBytes(k.seq)} />
            ))}
          </div>
          <form
            className="term-compose"
            onSubmit={(e) => { e.preventDefault(); sendCompose(); }}
          >
            <input
              type="text"
              value={compose}
              onChange={(e) => setCompose(e.target.value)}
              placeholder="type a reply…"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="send"
              aria-label="terminal input"
            />
            <button
              type="submit"
              className="term-send"
              aria-label="send"
              // touch-down send; preventDefault keeps the keyboard open
              onPointerDown={(e) => { e.preventDefault(); sendCompose(); }}
            >
              SEND
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
