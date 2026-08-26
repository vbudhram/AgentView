import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionStore } from './store';
import type { AgentKind } from './types';

const SCROLLBACK_MAX = 200 * 1024;

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
    while (this.size > SCROLLBACK_MAX && this.chunks.length > 1) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
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

export class BridgeServer extends EventEmitter {
  private server: Server;
  private bridges = new Map<string, BridgeImpl>();
  private pairs = new Map<string, string>(); // sessionKey -> bridgeId
  private onStoreEvents = () => this.pairAll();

  constructor(private store: SessionStore, private socketPath: string) {
    super();
    this.server = createServer((socket) => this.handle(socket));
    store.on('events', this.onStoreEvents);
  }

  private handle(socket: Socket): void {
    let bridge: BridgeImpl | null = null;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.t === 'hello' && !bridge) {
          bridge = new BridgeImpl(`${msg.agent}:${msg.pid}`, msg.agent, msg.cwd, socket);
          this.bridges.set(bridge.id, bridge);
          this.pairAll();
        } else if (msg.t === 'out' && bridge) {
          bridge.pushOutput(Buffer.from(msg.d, 'base64'));
        }
      }
    });
    socket.on('close', () => { if (bridge) this.drop(bridge.id); });
    socket.on('error', () => { if (bridge) this.drop(bridge.id); });
  }

  private drop(bridgeId: string): void {
    this.bridges.delete(bridgeId);
    for (const [key, id] of this.pairs) {
      if (id === bridgeId) { this.pairs.delete(key); this.store.setSteerable(key, false); }
    }
  }

  private pairAll(): void {
    for (const bridge of this.bridges.values()) {
      const key = this.store.findKeyByAgentCwd(bridge.agent, bridge.cwd);
      if (key && this.pairs.get(key) !== bridge.id) {
        this.pairs.set(key, bridge.id);
        this.store.setSteerable(key, true);
      }
    }
  }

  listen(): Promise<void> {
    try { unlinkSync(this.socketPath); } catch {}
    mkdirSync(dirname(this.socketPath), { recursive: true });
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, () => {
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
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
