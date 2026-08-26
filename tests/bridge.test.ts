import { describe, it, expect } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer } from '../src/lib/bridge';
import { SessionStore } from '../src/lib/store';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
});
