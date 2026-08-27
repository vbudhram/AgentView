import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionStore } from './store';
import type { AgentKind } from './types';
import { SpinnerScreen } from './spinner';

export const SCROLLBACK_MAX = 200 * 1024;
const LINE_BUF_MAX = 2 * 1024 * 1024;
// The CLI redraws its spinner at least once a second; a text that stops
// changing for this long is a leftover, not a live spinner.
export const SPINNER_STALE_MS = 5000;

export interface Bridge {
  id: string; agent: AgentKind; cwd: string;
  cols: number; rows: number;
  write(data: Buffer): void;
  onData(cb: (data: Buffer) => void): () => void;
  onResize(cb: (size: { cols: number; rows: number }) => void): () => void;
  scrollback(): Buffer;
  snapshot(): Buffer;
}

// The wrapped PTY reports its real size; anything else is a bad frame.
export function isValidSize(cols: unknown, rows: unknown): cols is number {
  return Number.isInteger(cols) && Number.isInteger(rows)
    && (cols as number) >= 10 && (cols as number) <= 500
    && (rows as number) >= 10 && (rows as number) <= 500;
}

class BridgeImpl extends EventEmitter implements Bridge {
  private chunks: Buffer[] = [];
  private size = 0;
  private screen: SpinnerScreen;
  spinner: string | null = null;
  private spinnerAt = 0;
  constructor(
    public id: string, public agent: AgentKind, public cwd: string,
    private socket: Socket, public cols = 80, public rows = 24,
  ) {
    super();
    this.screen = new SpinnerScreen(cols, rows);
  }

  setSize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.screen.resize(cols, rows);
    this.emit('resize', { cols, rows });
  }

  // A clean attach for mirrors: redraw the current screen from the VT model
  // instead of replaying raw scrollback that can start mid-escape-sequence.
  // Colors are lost; the geometry and the text are exact.
  snapshot(): Buffer {
    const { lines, row, col } = this.screen.snapshot();
    let out = '\u001b[0m\u001b[2J\u001b[H';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) out += `\u001b[${i + 1};1H${lines[i]}`;
    }
    out += `\u001b[${row + 1};${col + 1}H`;
    return Buffer.from(out, 'utf8');
  }

  pushOutput(data: Buffer): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > SCROLLBACK_MAX) {
      const head = this.chunks[0];
      const excess = this.size - SCROLLBACK_MAX;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
    this.screen.write(data);
    this.setSpinner(this.screen.spinner());
    this.emit('data', data);
  }

  // Only a CHANGE refreshes the clock; an unchanged parse of leftover text
  // must not keep a dead spinner alive.
  private setSpinner(text: string | null): void {
    if (text === this.spinner) return;
    this.spinner = text;
    this.spinnerAt = Date.now();
    this.emit('spinner', text);
  }

  expireSpinner(staleMs: number): void {
    if (this.spinner === null || Date.now() - this.spinnerAt <= staleMs) return;
    this.screen.reset(); // the leftover line must not re-match later
    this.setSpinner(null);
  }
  write(data: Buffer): void {
    this.socket.write(JSON.stringify({ t: 'in', d: data.toString('base64') }) + '\n');
  }
  onData(cb: (data: Buffer) => void): () => void {
    this.on('data', cb);
    return () => this.off('data', cb);
  }
  onResize(cb: (size: { cols: number; rows: number }) => void): () => void {
    this.on('resize', cb);
    return () => this.off('resize', cb);
  }
  scrollback(): Buffer { return Buffer.concat(this.chunks); }
}

function isValidHello(msg: any): boolean {
  return (msg.agent === 'claude' || msg.agent === 'codex')
    && typeof msg.pid === 'number'
    && typeof msg.cwd === 'string';
}

export class BridgeServer extends EventEmitter {
  private server: Server;
  private bridges = new Map<string, BridgeImpl>();
  private pairs = new Map<string, string>(); // sessionKey -> bridgeId
  private sockets = new Set<Socket>();
  private onStoreEvents = () => this.pairAll();
  private spinnerTimer: ReturnType<typeof setInterval>;

  constructor(private store: SessionStore, private socketPath: string, spinnerStaleMs = SPINNER_STALE_MS) {
    super();
    this.server = createServer((socket) => this.handle(socket));
    store.on('events', this.onStoreEvents);
    this.spinnerTimer = setInterval(() => {
      for (const b of this.bridges.values()) b.expireSpinner(spinnerStaleMs);
    }, Math.min(1000, spinnerStaleMs));
    this.spinnerTimer.unref?.();
  }

  // One bridge can be paired to several keys for its cwd (an ended session
  // plus the live one). The spinner belongs on the current key only, the
  // same one pairAll would pick.
  private keyFor(bridge: BridgeImpl): string | null {
    const key = this.store.findKeyByAgentCwd(bridge.agent, bridge.cwd);
    return key && this.pairs.get(key) === bridge.id ? key : null;
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    let bridge: BridgeImpl | null = null;
    let buf = '';
    const decoder = new StringDecoder('utf8');
    socket.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.t === 'hello' && !bridge && isValidHello(msg)) {
          // An older wrapper sends no size; fall back to the PTY defaults.
          const sized = isValidSize(msg.cols, msg.rows);
          bridge = new BridgeImpl(
            `${msg.agent}:${msg.pid}`, msg.agent, msg.cwd, socket,
            sized ? msg.cols : 80, sized ? msg.rows : 24,
          );
          this.bridges.set(bridge.id, bridge);
          const b = bridge;
          b.on('spinner', (text: string | null) => {
            const key = this.keyFor(b);
            if (key) this.store.setSpinner(key, text);
          });
          this.pairAll();
        } else if (msg.t === 'out' && bridge && typeof msg.d === 'string') {
          bridge.pushOutput(Buffer.from(msg.d, 'base64'));
        } else if (msg.t === 'resize' && bridge && isValidSize(msg.cols, msg.rows)) {
          bridge.setSize(msg.cols, msg.rows);
        }
      }
      if (buf.length > LINE_BUF_MAX) socket.destroy();
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (bridge) this.drop(bridge);
    });
    socket.on('error', () => { if (bridge) this.drop(bridge); });
  }

  private drop(bridge: BridgeImpl): void {
    // A reconnect with the same pid replaces the map entry; the stale
    // socket's close must not clobber the new bridge.
    if (this.bridges.get(bridge.id) !== bridge) return;
    this.bridges.delete(bridge.id);
    for (const [key, id] of this.pairs) {
      if (id === bridge.id) {
        this.pairs.delete(key);
        this.store.setSpinner(key, null);
        this.store.setSteerable(key, false);
      }
    }
    this.pairAll(); // let a surviving bridge claim the freed key
  }

  private pairAll(): void {
    for (const bridge of this.bridges.values()) {
      const key = this.store.findKeyByAgentCwd(bridge.agent, bridge.cwd);
      if (!key) continue;
      const cur = this.pairs.get(key);
      // A key paired to a live bridge keeps that pairing; this is the
      // fixed point that stops re-entrant 'events' emissions.
      if (cur && this.bridges.has(cur)) continue;
      this.pairs.set(key, bridge.id);
      this.store.setSteerable(key, true);
      if (bridge.spinner !== null) this.store.setSpinner(key, bridge.spinner);
      // the spinner moved to the current key; older keys of this bridge lose it
      for (const [k, id] of this.pairs) {
        if (id === bridge.id && k !== key) this.store.setSpinner(k, null);
      }
    }
  }

  listen(): Promise<void> {
    try { unlinkSync(this.socketPath); } catch {}
    mkdirSync(dirname(this.socketPath), { recursive: true });
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', onError);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  get(id: string): Bridge | undefined { return this.bridges.get(id); }
  forSessionKey(key: string): Bridge | undefined {
    const id = this.pairs.get(key);
    return id ? this.bridges.get(id) : undefined;
  }
  close(): Promise<void> {
    clearInterval(this.spinnerTimer);
    this.store.off('events', this.onStoreEvents);
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
