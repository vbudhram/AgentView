import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();

// Only local hosts are valid; a foreign Host header means DNS rebinding.
const ALLOWED_HOSTS = new Set(['localhost:4400', '127.0.0.1:4400', 'localhost', '127.0.0.1']);
const ALLOWED_ORIGINS = new Set(['http://localhost:4400', 'http://127.0.0.1:4400']);
const hostAllowed = (req) => ALLOWED_HOSTS.has(req.headers.host ?? '');

const server = createServer((req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!hostAllowed(req)) { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) { socket.destroy(); return; }
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
    ws.send(bridge.scrollback());
    const unsub = bridge.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) bridge.write(Buffer.from(data.toString(), 'utf8'));
    });
    ws.on('close', unsub);
  });
});

server.listen(4400, '127.0.0.1', () => {
  console.log('AgentView on http://localhost:4400');
  // Warm-up request boots the runtime singleton (collectors + proc poller) at start.
  fetch('http://127.0.0.1:4400/api/sessions').catch(() => {});
});
