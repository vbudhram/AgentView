import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionStore } from './store';
import type { AgentKind } from './types';
import { parseSpinner } from './spinner';

export const SCROLLBACK_MAX = 200 * 1024;
const LINE_BUF_MAX = 2 * 1024 * 1024;
// The CLI redraws its spinner at least once a second; a text that stops
// changing for this long is a leftover, not a live spinner.
export const SPINNER_STALE_MS = 5000;
const SPINNER_TAIL_MAX = 2048;

export interface Bridge {
  id: string; agent: AgentKind; cwd: string;
  write(data: Buffer): void;
  onData(cb: (data: Buffer) => void): () => void;
  scrollback(): Buffer;
}

class BridgeImpl extends EventEmitter implements Bridge {
  private chunks: Buffer[] = [];
  private size = 0;
  private tail: Buffer = Buffer.alloc(0);
  spinner: string | null = null;
  private spinnerAt = 0;
  constructor(public id: string, public agent: AgentKind, public cwd: string, private socket: Socket) { super(); }

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
    // A short tail survives chunks that split the spinner line mid-frame.
    this.tail = Buffer.concat([this.tail, data]);
    if (this.tail.length > SPINNER_TAIL_MAX) this.tail = this.tail.subarray(this.tail.length - SPINNER_TAIL_MAX);
    this.setSpinner(parseSpinner(this.tail.toString('utf8')));
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
    this.tail = Buffer.alloc(0); // the leftover line must not re-match later
    this.setSpinner(null);
  }
  write(data: Buffer): void {
    this.socket.write(JSON.stringify({ t: 'in', d: data.toString('base64') }) + '\n');
  }
  onData(cb: (data: Buffer) => void): () => void {
    this.on('data', cb);
    return () => this.off('data', cb);
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
          bridge = new BridgeImpl(`${msg.agent}:${msg.pid}`, msg.agent, msg.cwd, socket);
          this.bridges.set(bridge.id, bridge);
          const b = bridge;
          b.on('spinner', (text: string | null) => {
            const key = this.keyFor(b);
            if (key) this.store.setSpinner(key, text);
          });
          this.pairAll();
        } else if (msg.t === 'out' && bridge && typeof msg.d === 'string') {
          bridge.pushOutput(Buffer.from(msg.d, 'base64'));
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
