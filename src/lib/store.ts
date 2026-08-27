import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentKind, ParsedLine, SourceKind } from './types';
import { describeToolCall } from './describe';

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
  spinner: string | null;  // the CLI's live in-terminal spinner line, bridged sessions only
}

interface SessionRec {
  agent: AgentKind; sessionId: string | null; cwd: string | null;
  source: SourceKind | null; title: string | null; lastActivity: string;
  steerable: boolean; events: AgentEvent[]; gitBranch: string | null;
  spinner: string | null;
}

// Head of a message: its first meaningful line, cut at a word boundary near 120
// chars with a trailing ellipsis. The start of a question carries the request.
function messageHead(text: string): string {
  const lines = text.trim().split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/<[^>\n]{0,80}>/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const line = lines.find((l) => l.length >= 10 || l.includes('?')) ?? lines[0] ?? '';
  if (line.length <= 120) return line;
  const cut = line.slice(0, 121);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > 60 ? sp : 120).trimEnd()}…`;
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
      rec = { agent, sessionId: null, cwd: null, source: null, title: null, lastActivity: new Date(0).toISOString(), steerable: false, events: [], gitBranch: null, spinner: null };
      this.sessions.set(key, rec);
    }
    if (parsed.meta) {
      rec.sessionId = parsed.meta.sessionId ?? rec.sessionId;
      // First cwd wins: it is the launch directory and the session's identity.
      // Later lines carry the agent's `cd` excursions, which must not re-home
      // the session (and would break process/bridge matching by launch dir).
      rec.cwd = rec.cwd ?? parsed.meta.cwd ?? null;
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

  setSpinner(key: string, text: string | null): void {
    const rec = this.sessions.get(key);
    if (!rec || rec.spinner === text) return;
    rec.spinner = text;
    this.emit('events', { key, events: [] });
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
    // A live process in a cwd belongs to the MOST RECENT session there; older
    // sessions in the same directory must not ride along as alive.
    const latestByHome = new Map<string, string>();
    for (const rec of this.sessions.values()) {
      if (!rec.cwd) continue;
      const home = `${rec.agent}:${rec.cwd}`;
      const cur = latestByHome.get(home);
      if (!cur || rec.lastActivity > cur) latestByHome.set(home, rec.lastActivity);
    }
    for (const [key, rec] of this.sessions) {
      const age = now.getTime() - new Date(rec.lastActivity).getTime();
      if (age > DAY_MS) continue;
      const last = rec.events[rec.events.length - 1];
      const alive = !!rec.cwd && this.aliveCwds.has(rec.cwd)
        && latestByHome.get(`${rec.agent}:${rec.cwd}`) === rec.lastActivity;
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
        if (lastMsg?.kind === 'assistant_message') {
          const head = messageHead(lastMsg.text);
          // "asked:" only when it is a question; a statement gets an honest label
          nowLine = `${head.includes('?') ? 'asked' : 'said'}: ${head}`;
        }
      } else if (status === 'blocked' && last?.kind === 'tool_call') {
        // A pending tool_call only proves the tool did not return yet. It can be
        // a long-running approved tool or a permission prompt; present elapsed
        // truth ("running X"), never a hard approval claim.
        nowLine = `running ${describeToolCall(last.name, last.input)}`;
      }
      out.push({ key, agent: rec.agent, sessionId: rec.sessionId, cwd: rec.cwd, source: rec.source, title: rec.title, lastActivity: rec.lastActivity, status, steerable: rec.steerable, eventCount: rec.events.length, lastTool: lastTool?.kind === 'tool_call' ? lastTool.name : null, gitBranch: rec.gitBranch, now: nowLine, spinner: rec.spinner });
    }
    // Triage order: needs_input is the only confirmed "needs you" and pins the
    // top. A pending tool call (blocked) is working state, not an alarm, so it
    // shares the working band. Recency breaks ties inside each band.
    const RANK: Record<SessionStatus, number> = { needs_input: 0, working: 1, blocked: 1, idle: 2, ended: 3 };
    return out.sort((a, b) =>
      RANK[a.status] - RANK[b.status] || (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  events(key: string): AgentEvent[] { return this.sessions.get(key)?.events ?? []; }
}
