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
  // false when the wrapper socket is gone: the byte did NOT reach the PTY
  write(data: Buffer): boolean;
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
  public outdated = false;
  // When this wrapper last produced PTY output; pairing prefers the bridge
  // that demonstrably spoke last. Starts at 0: a wrapper that has not yet
  // spoken must not outrank an incumbent.
  public lastOutputAt = 0;
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

  // A dead socket cannot deliver a reply; it must never own a session.
  get live(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }

  pushOutput(data: Buffer): void {
    this.lastOutputAt = Date.now();
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
  write(data: Buffer): boolean {
    // A destroyed or ending socket silently drops writes; report that so the
    // UI can tell the user instead of losing the reply. Backpressure (a false
    // return from socket.write) still queues, so it counts as delivered.
    if (this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(JSON.stringify({ t: 'in', d: data.toString('base64') }) + '\n');
    return true;
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

// Keep in sync with PROTOCOL_VERSION in bin/av.mjs.
export const BRIDGE_PROTOCOL_VERSION = 2;

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
          // A wrapper behind the current protocol (or with no size) renders
          // an unfaithful mirror; surface that so the UI can say "restart".
          bridge.outdated = msg.v !== BRIDGE_PROTOCOL_VERSION || !sized;
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
    const freed: string[] = [];
    for (const [key, id] of this.pairs) {
      if (id === bridge.id) {
        freed.push(key);
        this.pairs.delete(key);
        this.store.setSpinner(key, null);
        this.store.setSteerable(key, false);
        this.store.setWrapperOutdated(key, false);
      }
    }
    this.pairAll(); // let a surviving bridge claim the freed key
    // Attached mirrors must re-resolve: to the successor, or to an honest
    // "not steerable" instead of a silent dead screen.
    for (const key of freed) this.emit('repair', key);
  }

  private pairAll(): void {
    // Group LIVE bridges by the session key their (agent, cwd) resolves to.
    // A bridge with a dead socket never pairs: it cannot deliver a reply.
    const byKey = new Map<string, BridgeImpl[]>();
    for (const bridge of this.bridges.values()) {
      if (!bridge.live) continue;
      const key = this.store.findKeyByAgentCwd(bridge.agent, bridge.cwd);
      if (!key) continue;
      const arr = byKey.get(key);
      if (arr) arr.push(bridge);
      else byKey.set(key, [bridge]);
    }
    for (const [key, candidates] of byKey) {
      // With two wrappers in one cwd (exit-and-relaunch), the session must
      // belong to the one that demonstrably spoke last, not to a zombie
      // frozen at a startup prompt. On a tie the current pairing stays.
      let best = candidates[0];
      for (const b of candidates) {
        if (b.lastOutputAt > best.lastOutputAt) best = b;
      }
      const cur = this.pairs.get(key);
      if (cur === best.id) continue;
      const curBridge = cur ? this.bridges.get(cur) : undefined;
      if (curBridge?.live && curBridge.lastOutputAt >= best.lastOutputAt) continue;
      this.pairs.set(key, best.id);
      this.store.setSteerable(key, true);
      this.store.setWrapperOutdated(key, best.outdated);
      this.store.setSpinner(key, best.spinner);
      // the spinner moved to the current key; older keys of this bridge lose it
      for (const [k, id] of this.pairs) {
        if (id === best.id && k !== key) this.store.setSpinner(k, null);
      }
      // A takeover from another bridge: attached mirrors are showing the
      // loser's screen; tell them to re-attach.
      if (curBridge) this.emit('repair', key);
    }
  }

  // Write through the CURRENT pairing. A failed write unpairs the dead
  // bridge on the spot so a surviving wrapper can claim the key; the caller
  // still reports the failure so no reply is silently swallowed.
  writeToKey(key: string, data: Buffer): boolean {
    const id = this.pairs.get(key);
    const bridge = id ? this.bridges.get(id) : undefined;
    if (!bridge) return false;
    const ok = bridge.write(data);
    if (!ok) this.drop(bridge);
    return ok;
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
