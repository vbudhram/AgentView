import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import next from 'next';
import { WebSocketServer } from 'ws';

// Tailscale assigns CGNAT-range (100.64.0.0/10) addresses; a listener there
// is reachable only through the tailnet's WireGuard tunnel, never the LAN.
function tailscaleIPv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4') continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();

// Only local hosts are valid; a foreign Host header means DNS rebinding.
// Tailscale access arrives via `tailscale serve`, which proxies to loopback
// with the machine's *.ts.net name as Host — a name only the tailnet's own
// MagicDNS can mint, so a rebinding page can never present it.
const tsIP = tailscaleIPv4();
const ALLOWED_HOSTS = new Set(['localhost:4400', '127.0.0.1:4400', 'localhost', '127.0.0.1']);
if (tsIP) { ALLOWED_HOSTS.add(tsIP); ALLOWED_HOSTS.add(`${tsIP}:4400`); }
const TSNET_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/;
const hostAllowed = (req) => {
  const host = (req.headers.host ?? '').toLowerCase();
  return ALLOWED_HOSTS.has(host) || TSNET_HOST.test(host);
};
const ALLOWED_ORIGINS = new Set(['http://localhost:4400', 'http://127.0.0.1:4400']);
if (tsIP) ALLOWED_ORIGINS.add(`http://${tsIP}:4400`);
// Tailnet origins may be plain http: WireGuard already encrypts the wire.
const originAllowed = (origin) => {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && TSNET_HOST.test(u.host.toLowerCase());
  } catch { return false; }
};

const onRequest = (req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  handle(req, res);
};

const wss = new WebSocketServer({ noServer: true });
const onUpgrade = (req, socket, head) => {
  if (!hostAllowed(req)) { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin)) { socket.destroy(); return; }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  // Other upgrades (e.g. Next's /_next/hmr socket in dev) belong to Next's
  // own upgrade listener; only /ws/term is ours. In production nothing else
  // listens, so destroy unmatched upgrades instead of leaving them hanging.
  if (url.pathname !== '/ws/term') { if (!dev) socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {});
    // The warm-up fetch boots the runtime inside Next's module graph,
    // which sets globalThis.__agentview for this handler.
    const rt = globalThis.__agentview;
    const key = url.searchParams.get('key') ?? '';
    const bridge = rt?.bridge?.forSessionKey(key);
    if (!bridge) { ws.close(4004, 'not steerable'); return; }
    // Server→client text frames are control JSON; binary frames are PTY bytes.
    // The size goes first so the mirror sets the exact grid before any bytes.
    ws.send(JSON.stringify({ t: 'size', cols: bridge.cols, rows: bridge.rows }));
    // A clean redraw from the VT screen model, never raw scrollback that can
    // start mid-escape-sequence.
    ws.send(bridge.snapshot());
    const unsub = bridge.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    const unsubResize = bridge.onResize(({ cols, rows }) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'size', cols, rows }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      // A write into a dead wrapper socket is a silently lost reply; tell
      // the client so it can keep the text and warn the user.
      const ok = bridge.write(Buffer.from(data.toString(), 'utf8'));
      if (!ok && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'write_failed' }));
    });
    ws.on('close', () => { unsub(); unsubResize(); });
  });
};

const server = createServer(onRequest);
server.on('upgrade', onUpgrade);
server.listen(4400, '127.0.0.1', () => {
  console.log('AgentView on http://localhost:4400');
  // Warm-up request boots the runtime singleton (collectors + proc poller) at start.
  fetch('http://127.0.0.1:4400/api/sessions').catch(() => {});
});

// Tailnet listener: same handlers, reachable only through WireGuard.
if (tsIP) {
  const tsServer = createServer(onRequest);
  tsServer.on('upgrade', onUpgrade);
  tsServer.listen(4400, tsIP, () => {
    console.log(`AgentView on tailnet at http://${tsIP}:4400`);
  });
  tsServer.on('error', (err) => console.error('[tailnet]', err.message));
}
