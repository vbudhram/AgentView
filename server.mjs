import { createServer } from 'node:http';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

await app.prepare();
const server = createServer((req, res) => handle(req, res));
server.listen(4400, '127.0.0.1', () => {
  console.log('AgentView on http://localhost:4400');
  // Warm-up request boots the runtime singleton (collectors + proc poller) at start.
  fetch('http://127.0.0.1:4400/api/sessions').catch(() => {});
});
