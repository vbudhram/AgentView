import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tailer } from '../src/lib/tailer';

describe('Tailer', () => {
  it('reads all complete lines first, then only appended lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailer-'));
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, 'one\ntwo\n');
    const t = new Tailer();
    expect(t.readNew(f)).toEqual(['one', 'two']);
    expect(t.readNew(f)).toEqual([]);
    appendFileSync(f, 'three\n');
    expect(t.readNew(f)).toEqual(['three']);
  });

  it('holds a truncated final line until it completes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailer-'));
    const f = join(dir, 'b.jsonl');
    writeFileSync(f, 'full\npart');
    const t = new Tailer();
    expect(t.readNew(f)).toEqual(['full']);
    appendFileSync(f, 'ial\n');
    expect(t.readNew(f)).toEqual(['partial']);
  });
});
