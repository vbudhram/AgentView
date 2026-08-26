import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionStore } from './store';
import type { AgentKind } from './types';

export const SCROLLBACK_MAX = 200 * 1024;
const LINE_BUF_MAX = 2 * 1024 * 1024;

export interface Bridge {
  id: string; agent: AgentKind; cwd: string;
  write(data: Buffer): void;
  onData(cb: (data: Buffer) => void): () => void;
  scrollback(): Buffer;
}

class BridgeImpl extends EventEmitter implements Bridge {
  private chunks: Buffer[] = [];
  private size = 0;
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
    this.emit('data', data);
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

  constructor(private store: SessionStore, private socketPath: string) {
    super();
    this.server = createServer((socket) => this.handle(socket));
    store.on('events', this.onStoreEvents);
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
        if (msg.t === 'hello' && !bridge && isValidHello(msg)) {
          bridge = new BridgeImpl(`${msg.agent}:${msg.pid}`, msg.agent, msg.cwd, socket);
          this.bridges.set(bridge.id, bridge);
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
      if (id === bridge.id) { this.pairs.delete(key); this.store.setSteerable(key, false); }
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
    this.store.off('events', this.onStoreEvents);
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
