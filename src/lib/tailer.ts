import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

interface FileState { offset: number; partial: string }

export class Tailer {
  private files = new Map<string, FileState>();

  readNew(filePath: string): string[] {
    const state = this.files.get(filePath) ?? { offset: 0, partial: '' };
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
        state.partial = '';
      }
      if (size === state.offset) return [];
      const buf = Buffer.alloc(size - state.offset);
      readSync(fd, buf, 0, buf.length, state.offset);
      state.offset = size;
      const chunk = state.partial + buf.toString('utf8');
      const parts = chunk.split('\n');
      state.partial = parts.pop() ?? '';
      this.files.set(filePath, state);
      return parts.filter((l) => l.length > 0);
    } finally {
      closeSync(fd);
    }
  }
}
