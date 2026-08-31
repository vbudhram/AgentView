import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionStore } from './store';

const run = promisify(execFile);
const AGENT_RE = /(^|\/)(claude|codex)$/;

export interface AgentProc { pid: number; agent: 'claude' | 'codex' }

export function parsePsForAgents(psOutput: string): AgentProc[] {
  const procs: AgentProc[] = [];
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const a = m[2].match(AGENT_RE);
    if (a) procs.push({ pid: Number(m[1]), agent: a[2] as AgentProc['agent'] });
  }
  return procs;
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
      const { stdout } = await run('ps', ['-axo', 'pid=,comm=']);
      // Count processes per agent+cwd: two agents in one repo are two slots.
      const counts = new Map<string, number>();
      for (const { pid, agent } of parsePsForAgents(stdout)) {
        const cwd = await cwdOf(pid);
        if (!cwd) continue;
        const home = `${agent}:${cwd}`;
        counts.set(home, (counts.get(home) ?? 0) + 1);
      }
      store.setAliveCounts(counts);
    } catch (err) {
      console.error('[proc]', err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}
