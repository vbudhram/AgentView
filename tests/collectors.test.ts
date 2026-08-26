import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/lib/store';
import { startCollectors } from '../src/lib/collectors';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startCollectors', () => {
  it('ingests existing and appended claude lines; survives a missing codex root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'col-'));
    const claudeRoot = join(base, 'projects');
    mkdirSync(join(claudeRoot, '-Users-x-proj'), { recursive: true });
    const f = join(claudeRoot, '-Users-x-proj', 'sess-1.jsonl');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-08-26T10:00:00Z', sessionId: 'sess-1', cwd: '/Users/x/proj', entrypoint: 'cli' });
    writeFileSync(f, line + '\n');

    const store = new SessionStore();
    const h = startCollectors({ claudeRoot, codexRoot: join(base, 'nope'), store });
    await wait(500);
    expect(store.events('claude:sess-1')).toHaveLength(1);

    appendFileSync(f, line + '\n');
    await wait(500);
    expect(store.events('claude:sess-1')).toHaveLength(2);
    await h.close();
  });
});
