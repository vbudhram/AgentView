import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Tailer } from './tailer';
import { parseClaudeLine } from './parsers/claude';
import { parseCodexLine } from './parsers/codex';
import type { SessionStore } from './store';
import type { AgentKind } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CollectorOpts {
  claudeRoot: string;
  codexRoot: string;
  store: SessionStore;
  windowMs?: number;
}

// chokidar v5 dropped glob support, so we watch each root directly and
// filter the relative path it reports with a RegExp instead of a glob.
const CLAUDE_FILE_RE = /^[^/]+\/[^/]+\.jsonl$/; // matches `*/*.jsonl`
const CODEX_FILE_RE = /(^|\/)rollout-[^/]*\.jsonl$/; // matches `**/rollout-*.jsonl`

export function startCollectors(opts: CollectorOpts): { close(): Promise<void> } {
  const windowMs = opts.windowMs ?? DAY_MS;
  const tailer = new Tailer();
  const watchers: FSWatcher[] = [];

  const ingest = (agent: AgentKind, filePath: string) => {
    const fileId = basename(filePath).replace(/\.jsonl$/, '');
    const parse = agent === 'claude' ? parseClaudeLine : parseCodexLine;
    for (const line of tailer.readNew(filePath)) {
      try {
        opts.store.apply(agent, fileId, parse(line));
      } catch (err) {
        console.error(`[collector] skipping bad line in ${filePath}:`, err);
      }
    }
  };

  const watch = (agent: AgentKind, root: string, matches: RegExp) => {
    if (!existsSync(root)) return;
    const w = chokidar.watch(root, { cwd: root, ignoreInitial: false, alwaysStat: true });
    w.on('add', (rel, stats) => {
      if (!matches.test(rel)) return;
      if (stats && Date.now() - stats.mtimeMs > windowMs) return;
      ingest(agent, `${root}/${rel}`);
    });
    w.on('change', (rel) => {
      if (!matches.test(rel)) return;
      ingest(agent, `${root}/${rel}`);
    });
    w.on('error', (err) => console.error('[collector]', err));
    watchers.push(w);
  };

  watch('claude', opts.claudeRoot, CLAUDE_FILE_RE);
  watch('codex', opts.codexRoot, CODEX_FILE_RE);

  return { close: async () => { await Promise.all(watchers.map((w) => w.close())); } };
}
