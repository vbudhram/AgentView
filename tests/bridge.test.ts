import { describe, it, expect } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer, SCROLLBACK_MAX } from '../src/lib/bridge';
import { SessionStore } from '../src/lib/store';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeStore(): SessionStore {
  const store = new SessionStore();
  store.apply('claude', 'f1', {
    events: [{ kind: 'user_message', ts: new Date().toISOString(), text: 'hi' }],
    meta: { sessionId: 'f1', cwd: '/p', source: 'terminal' },
  });
  return store;
}

function makeSock(): string {
  return join(mkdtempSync(join(tmpdir(), 'br-')), 'b.sock');
}

describe('BridgeServer', () => {
  it('pairs a hello with a session and relays both directions', async () => {
    const store = new SessionStore();
    store.apply('claude', 'f1', {
      events: [{ kind: 'user_message', ts: new Date().toISOString(), text: 'hi' }],
      meta: { sessionId: 'f1', cwd: '/p', source: 'terminal' },
    });
    const sock = join(mkdtempSync(join(tmpdir(), 'br-')), 'b.sock');
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 42 }) + '\n');
    await wait(200);

    const bridge = server.forSessionKey('claude:f1');
    expect(bridge).toBeDefined();
    expect(store.summaries()[0].steerable).toBe(true);

    // PTY → browser
    const got: Buffer[] = [];
    bridge!.onData((d) => got.push(d));
    client.write(JSON.stringify({ t: 'out', d: Buffer.from('hello-out').toString('base64') }) + '\n');
    await wait(200);
    expect(Buffer.concat(got).toString()).toBe('hello-out');
    expect(bridge!.scrollback().toString()).toContain('hello-out');

    // browser → PTY
    const received = new Promise<string>((resolve) => {
      client.on('data', (buf) => {
        const msg = JSON.parse(buf.toString().trim());
        if (msg.t === 'in') resolve(Buffer.from(msg.d, 'base64').toString());
      });
    });
    bridge!.write(Buffer.from('typed'));
    expect(await received).toBe('typed');

    client.end();
    await wait(200);
    expect(store.summaries()[0].steerable).toBe(false);
    await server.close();
  });

  it('keeps a stable pairing with two bridges for the same agent+cwd', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const clientA = createConnection(sock);
    await new Promise((r) => clientA.on('connect', r));
    clientA.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 1 }) + '\n');
    await wait(100);

    const clientB = createConnection(sock);
    await new Promise((r) => clientB.on('connect', r));
    clientB.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 2 }) + '\n');
    await wait(200);

    // no crash, session steerable, first bridge keeps the pairing
    expect(store.summaries()[0].steerable).toBe(true);
    expect(server.forSessionKey('claude:f1')!.id).toBe('claude:1');

    // disconnect the first bridge; the second takes over
    clientA.end();
    await wait(200);
    expect(server.forSessionKey('claude:f1')!.id).toBe('claude:2');
    expect(store.summaries()[0].steerable).toBe(true);

    clientB.end();
    await wait(200);
    expect(store.summaries()[0].steerable).toBe(false);
    await server.close();
  });

  it('ignores malformed out frames and keeps relaying', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 7 }) + '\n');
    client.write(JSON.stringify({ t: 'out' }) + '\n'); // d missing
    client.write(JSON.stringify({ t: 'out', d: 42 }) + '\n'); // d not a string
    client.write(JSON.stringify({ t: 'out', d: Buffer.from('ok').toString('base64') }) + '\n');
    await wait(200);

    const bridge = server.get('claude:7');
    expect(bridge).toBeDefined();
    expect(bridge!.scrollback().toString()).toBe('ok');

    client.end();
    await server.close();
  });

  it('destroys a socket that floods the line buffer without a newline', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    client.on('error', () => {});
    await new Promise((r) => client.on('connect', r));
    const closed = new Promise((r) => client.on('close', r));
    client.write(Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61)); // 2MB+ of 'a', no newline
    await closed; // server destroyed the connection
    await server.close();
  });

  it('caps scrollback at SCROLLBACK_MAX even for one oversized frame', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 9 }) + '\n');
    const big = Buffer.alloc(SCROLLBACK_MAX + 50 * 1024, 0x62); // 250KB frame
    client.write(JSON.stringify({ t: 'out', d: big.toString('base64') }) + '\n');
    await wait(300);

    const bridge = server.get('claude:9');
    expect(bridge).toBeDefined();
    expect(bridge!.scrollback().length).toBe(SCROLLBACK_MAX);

    client.end();
    await server.close();
  });
});
