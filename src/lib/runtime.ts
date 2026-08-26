import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store';
import { startCollectors } from './collectors';
import { startProcPoller } from './proc';
import { BridgeServer } from './bridge';

interface Runtime { store: SessionStore; bridge: BridgeServer }

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
    const bridge = new BridgeServer(store, join(homedir(), '.agentview', 'bridge.sock'));
    bridge.listen();
    g.__agentview = { store, bridge };
  }
  return g.__agentview;
}
