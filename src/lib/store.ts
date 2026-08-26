import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentKind, ParsedLine, SourceKind } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKING_MS = 30 * 1000;

export type SessionStatus = 'working' | 'needs_input' | 'blocked' | 'idle' | 'ended';

export interface SessionSummary {
  key: string; agent: AgentKind; sessionId: string | null; cwd: string | null;
  source: SourceKind | null; title: string | null; lastActivity: string;
  status: SessionStatus; steerable: boolean; eventCount: number;
  lastTool: string | null;  // name of the most recent tool_call, for the working ticker
  gitBranch: string | null;
  now: string | null;  // status-aware one-liner: what the agent does or waits on
}

interface SessionRec {
  agent: AgentKind; sessionId: string | null; cwd: string | null;
  source: SourceKind | null; title: string | null; lastActivity: string;
  steerable: boolean; events: AgentEvent[]; gitBranch: string | null;
}

function excerpt(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// Human-readable one-liner for a tool call, e.g. "Bash: npm test" or "Edit: store.ts"
function describeToolCall(name: string, input: string): string {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
  } catch { /* codex arguments are not always JSON */ }
  if (name === 'Bash' && typeof obj?.command === 'string') return `Bash: ${excerpt(obj.command, 60)}`;
  if ((name === 'Edit' || name === 'Write' || name === 'Read') && typeof obj?.file_path === 'string') {
    return `${name}: ${obj.file_path.split('/').pop()}`;
  }
  return `${name}: ${excerpt(input, 60)}`;
}

// Tail of a message: its last non-empty line, capped at ~80 chars.
function messageTail(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 80 ? `…${last.slice(-80)}` : last;
}

// Markup-ish messages (<local-command-caveat>, Caveat: …) make bad titles.
function cleanTitle(text: string): boolean {
  const t = text.trimStart();
  return !t.startsWith('<') && !t.startsWith('Caveat:');
}

export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionRec>();
  private aliveCwds = new Set<string>();

  apply(agent: AgentKind, fileId: string, parsed: ParsedLine): void {
    if (parsed.events.length === 0 && !parsed.meta) return;
    const key = `${agent}:${fileId}`;
    let rec = this.sessions.get(key);
    if (!rec) {
      rec = { agent, sessionId: null, cwd: null, source: null, title: null, lastActivity: new Date(0).toISOString(), steerable: false, events: [], gitBranch: null };
      this.sessions.set(key, rec);
    }
    if (parsed.meta) {
      rec.sessionId = parsed.meta.sessionId ?? rec.sessionId;
      rec.cwd = parsed.meta.cwd ?? rec.cwd;
      rec.source = parsed.meta.source ?? rec.source;
      rec.gitBranch = parsed.meta.gitBranch ?? rec.gitBranch;
    }
    for (const e of parsed.events) {
      rec.events.push(e);
      if (e.ts > rec.lastActivity) rec.lastActivity = e.ts;
      if (!rec.title && e.kind === 'user_message' && cleanTitle(e.text)) rec.title = e.text.slice(0, 80);
    }
    if (parsed.events.length > 0) this.emit('events', { key, events: parsed.events });
  }

  setAliveCwds(cwds: Set<string>): void { this.aliveCwds = cwds; }

  setSteerable(key: string, on: boolean): void {
    const rec = this.sessions.get(key);
    if (rec) { rec.steerable = on; this.emit('events', { key, events: [] }); }
  }

  findKeyByAgentCwd(agent: AgentKind, cwd: string): string | null {
    let best: { key: string; last: string } | null = null;
    for (const [key, rec] of this.sessions) {
      if (rec.agent === agent && rec.cwd === cwd && (!best || rec.lastActivity > best.last)) {
        best = { key, last: rec.lastActivity };
      }
    }
    return best?.key ?? null;
  }

  summaries(now: Date = new Date()): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const [key, rec] of this.sessions) {
      const age = now.getTime() - new Date(rec.lastActivity).getTime();
      if (age > DAY_MS) continue;
      const last = rec.events[rec.events.length - 1];
      const alive = !!rec.cwd && this.aliveCwds.has(rec.cwd);
      let status: SessionStatus;
      if (age <= WORKING_MS) status = 'working';
      else if (!alive) status = 'ended';
      else if (last?.kind === 'tool_call') status = 'blocked';
      else if (last?.kind === 'assistant_message' || (last?.kind === 'turn_status' && last.status === 'completed')) status = 'needs_input';
      else status = 'idle';
      const lastTool = [...rec.events].reverse().find((e) => e.kind === 'tool_call');
      let nowLine: string | null = null;
      if (status === 'working' && lastTool?.kind === 'tool_call') {
        nowLine = describeToolCall(lastTool.name, lastTool.input);
      } else if (status === 'needs_input') {
        const lastMsg = [...rec.events].reverse().find((e) => e.kind === 'assistant_message');
        if (lastMsg?.kind === 'assistant_message') nowLine = `asked: ${messageTail(lastMsg.text)}`;
      } else if (status === 'blocked' && last?.kind === 'tool_call') {
        nowLine = `wants: ${describeToolCall(last.name, last.input)}`;
      }
      out.push({ key, agent: rec.agent, sessionId: rec.sessionId, cwd: rec.cwd, source: rec.source, title: rec.title, lastActivity: rec.lastActivity, status, steerable: rec.steerable, eventCount: rec.events.length, lastTool: lastTool?.kind === 'tool_call' ? lastTool.name : null, gitBranch: rec.gitBranch, now: nowLine });
    }
    return out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  events(key: string): AgentEvent[] { return this.sessions.get(key)?.events ?? []; }
}
