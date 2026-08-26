import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionStore } from './store';

const run = promisify(execFile);
const AGENT_RE = /(^|\/)(claude|codex)( |$)/;

export function parsePsForAgents(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[2];
    const bin = cmd.split(' ')[0];
    if (AGENT_RE.test(bin + ' ')) pids.push(Number(m[1]));
  }
  return pids;
}

async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const n = stdout.split('\n').find((l) => l.startsWith('n'));
    return n ? n.slice(1) : null;
  } catch {
    return null;
  }
}

export function startProcPoller(store: SessionStore, intervalMs = 5000): { stop(): void } {
  let stopped = false;
  const tick = async () => {
    try {
      const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
      const cwds = new Set<string>();
      for (const pid of parsePsForAgents(stdout)) {
        const cwd = await cwdOf(pid);
        if (cwd) cwds.add(cwd);
      }
      store.setAliveCwds(cwds);
    } catch (err) {
      console.error('[proc]', err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}
