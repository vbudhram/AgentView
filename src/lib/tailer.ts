import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

interface FileState { offset: number; partial: Buffer }

const NEWLINE = 0x0a;

export class Tailer {
  private files = new Map<string, FileState>();

  readNew(filePath: string): string[] {
    const state = this.files.get(filePath) ?? { offset: 0, partial: Buffer.alloc(0) };
    let fd: number;
    try {
      fd = openSync(filePath, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < state.offset) {
        state.offset = 0; // file was replaced
        state.partial = Buffer.alloc(0);
      }
      if (size === state.offset) return [];
      const buf = Buffer.alloc(size - state.offset);
      readSync(fd, buf, 0, buf.length, state.offset);
      state.offset = size;
      const chunk = Buffer.concat([state.partial, buf]);
      const parts: string[] = [];
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NEWLINE) {
          parts.push(chunk.toString('utf8', start, i));
          start = i + 1;
        }
      }
      state.partial = chunk.subarray(start);
      this.files.set(filePath, state);
      return parts.filter((l) => l.length > 0);
    } catch {
      return [];
    } finally {
      closeSync(fd);
    }
  }
}
