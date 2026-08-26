import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store';
import { startCollectors } from './collectors';
import { startProcPoller } from './proc';

interface Runtime { store: SessionStore }

export function getRuntime(): Runtime {
  const g = globalThis as any;
  if (!g.__agentview) {
    const store = new SessionStore();
    startCollectors({
      claudeRoot: join(homedir(), '.claude', 'projects'),
      codexRoot: join(homedir(), '.codex', 'sessions'),
      store,
    });
    startProcPoller(store);
    g.__agentview = { store };
  }
  return g.__agentview;
}
