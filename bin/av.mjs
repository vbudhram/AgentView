#!/usr/bin/env node
import { spawn } from 'node-pty';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [agent, ...args] = process.argv.slice(2);
if (!agent || !['claude', 'codex'].includes(agent)) {
  console.error('usage: av <claude|codex> [args...]');
  process.exit(1);
}

// Leave the parent terminal usable on every exit path.
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  process.stdin.setRawMode?.(false);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

let pty;
try {
  pty = spawn(agent, args, {
    name: 'xterm-256color',
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    cwd: process.cwd(),
    env: process.env,
  });
} catch (err) {
  restore();
  console.error(`av: failed to start ${agent}: ${err.message}`);
  process.exit(1);
}

// Terminal passthrough — the user experience is unchanged.
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => pty.write(d.toString()));
pty.onData((d) => process.stdout.write(d));
process.stdout.on('resize', () => pty.resize(process.stdout.columns, process.stdout.rows));
pty.onExit(({ exitCode }) => { restore(); process.exit(exitCode); });

// Bridge connection — best effort; the wrapper works without the app running.
const sockPath = join(homedir(), '.agentview', 'bridge.sock');
let sock = null;
function connect() {
  const s = createConnection(sockPath);
  s.on('connect', () => {
    sock = s;
    s.write(JSON.stringify({ t: 'hello', agent, cwd: process.cwd(), pid: process.pid }) + '\n');
  });
  let buf = '';
  s.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.t === 'in') pty.write(Buffer.from(msg.d, 'base64').toString());
      } catch {}
    }
  });
  s.on('error', () => { sock = null; });
  s.on('close', () => { sock = null; setTimeout(connect, 5000).unref(); });
}
connect();
pty.onData((d) => {
  if (sock) sock.write(JSON.stringify({ t: 'out', d: Buffer.from(d).toString('base64') }) + '\n');
});
