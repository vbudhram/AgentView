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

  it('write reports delivery: true on a live socket, false after it dies', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 42 }) + '\n');
    await wait(200);

    const bridge = server.forSessionKey('claude:f1')!;
    expect(bridge.write(Buffer.from('ok'))).toBe(true);

    client.destroy();
    await wait(200);
    // the held reference must not pretend a dead wrapper accepted the reply
    expect(bridge.write(Buffer.from('lost'))).toBe(false);
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

  it('ignores non-object json frames (null, string) and keeps relaying', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 8 }) + '\n');
    client.write('null\n');
    client.write('"str"\n');
    client.write(JSON.stringify({ t: 'out', d: Buffer.from('still-ok').toString('base64') }) + '\n');
    await wait(200);

    const bridge = server.get('claude:8');
    expect(bridge).toBeDefined();
    expect(bridge!.scrollback().toString()).toBe('still-ok');

    client.end();
    await server.close();
  });

  it('surfaces the parsed spinner on the session and clears it on disconnect', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 11 }) + '\n');
    const out = (s: string) => JSON.stringify({ t: 'out', d: Buffer.from(s).toString('base64') }) + '\n';
    client.write(out('· Undulating… (34s · ↓ 46 tokens · esc to interrupt)'));
    await wait(200);
    expect(store.summaries()[0].spinner).toBe('Undulating… (34s · ↓ 46 tokens)');

    // a redraw with new elapsed replaces the text
    client.write(out('\r· Undulating… (35s · ↓ 48 tokens · esc to interrupt)'));
    await wait(200);
    expect(store.summaries()[0].spinner).toBe('Undulating… (35s · ↓ 48 tokens)');

    client.end();
    await wait(200);
    expect(store.summaries()[0].spinner).toBeNull();
    await server.close();
  });

  it('stales out a spinner that stops refreshing', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock, 200); // short stale window for the test
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 12 }) + '\n');
    client.write(JSON.stringify({ t: 'out', d: Buffer.from('· Musing… (4s · esc to interrupt)').toString('base64') }) + '\n');
    await wait(150);
    expect(store.summaries()[0].spinner).toBe('Musing… (4s)');
    await wait(600); // no refresh -> the interval clears it
    expect(store.summaries()[0].spinner).toBeNull();

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

  it('flags a wrapper behind the protocol version as outdated, current as not', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();
    // old wrapper: no v, no size
    const c1 = createConnection(sock);
    await new Promise((r) => c1.on('connect', r));
    c1.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 1 }) + '\n');
    await wait(150);
    expect(store.summaries()[0].wrapperOutdated).toBe(true);
    c1.end();
    await wait(150);
    expect(store.summaries()[0].wrapperOutdated).toBe(false);
    // current wrapper: v matches and size present
    const c2 = createConnection(sock);
    await new Promise((r) => c2.on('connect', r));
    c2.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 2, cols: 120, rows: 40, v: 2 }) + '\n');
    await wait(150);
    const s = store.summaries()[0];
    expect(s.steerable).toBe(true);
    expect(s.wrapperOutdated).toBe(false);
    c2.end();
    await server.close();
  });

  it('stores the PTY size from hello and falls back on bad values', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 20, cols: 190, rows: 45 }) + '\n');
    await wait(200);
    const bridge = server.get('claude:20')!;
    expect(bridge.cols).toBe(190);
    expect(bridge.rows).toBe(45);
    client.end();
    await wait(100);

    // out-of-bounds or non-numeric size falls back to 80x24
    const client2 = createConnection(sock);
    await new Promise((r) => client2.on('connect', r));
    client2.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 21, cols: 9000, rows: 'x' }) + '\n');
    await wait(200);
    const b2 = server.get('claude:21')!;
    expect(b2.cols).toBe(80);
    expect(b2.rows).toBe(24);

    client2.end();
    await server.close();
  });

  it('applies valid resize frames, notifies listeners, ignores invalid ones', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 22, cols: 120, rows: 30 }) + '\n');
    await wait(200);
    const bridge = server.get('claude:22')!;
    const seen: { cols: number; rows: number }[] = [];
    bridge.onResize((s) => seen.push(s));

    client.write(JSON.stringify({ t: 'resize', cols: 190, rows: 50 }) + '\n');
    client.write(JSON.stringify({ t: 'resize', cols: 2, rows: 50 }) + '\n');   // below bounds
    client.write(JSON.stringify({ t: 'resize', cols: 100.5, rows: 50 }) + '\n'); // not integers
    await wait(200);
    expect(bridge.cols).toBe(190);
    expect(bridge.rows).toBe(50);
    expect(seen).toEqual([{ cols: 190, rows: 50 }]);

    client.end();
    await server.close();
  });

  it('serializes a clean ANSI snapshot of the screen model', async () => {
    const store = makeStore();
    const sock = makeSock();
    const server = new BridgeServer(store, sock);
    await server.listen();

    const client = createConnection(sock);
    await new Promise((r) => client.on('connect', r));
    client.write(JSON.stringify({ t: 'hello', agent: 'claude', cwd: '/p', pid: 23, cols: 80, rows: 24 }) + '\n');
    // colored text, then a cursor-addressed status line on row 3
    const raw = 'first line\r\n\u001b[31msecond\u001b[0m line\u001b[3;5Hstatus';
    client.write(JSON.stringify({ t: 'out', d: Buffer.from(raw).toString('base64') }) + '\n');
    await wait(200);

    const snap = server.get('claude:23')!.snapshot().toString('utf8');
    expect(snap.startsWith('\u001b[0m\u001b[2J\u001b[H')).toBe(true);
    expect(snap).toContain('\u001b[1;1Hfirst line');
    expect(snap).toContain('\u001b[2;1Hsecond line'); // colors dropped, text exact
    expect(snap).toContain('\u001b[3;1H    status');
    expect(snap.endsWith('\u001b[3;11H')).toBe(true);  // cursor after "status"

    client.end();
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
