import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentKind, ParsedLine, SourceKind } from './types';
import { describeToolCall } from './describe';

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKING_MS = 30 * 1000;
// A steerable session with a pending tool and a dead spinner this long is
// almost certainly sitting at a permission prompt.
const APPROVAL_ESCALATE_MS = 90 * 1000;

export type SessionStatus = 'working' | 'needs_input' | 'waiting' | 'blocked' | 'idle' | 'ended';

// Clear ask phrasing near the end of a message.
const ASK_RE = /\b(want me to|should i|shall i|which (one|option)|confirm|approve|let me know|do you want|prefer)\b/i;

// Does the message end by asking the user something? Yes when the last
// non-empty line ends with '?', or the final two sentences carry clear ask
// phrasing. A trailing statement ("I'll continue automatically…") is not
// an ask; it must not raise the alarm.
export function asksQuestion(text: string): boolean {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1].replace(/[*_`)\]\s]+$/, '');
  if (last.endsWith('?')) return true;
  const sentences = lines.join(' ').split(/(?<=[.!?])\s+/).filter(Boolean);
  return ASK_RE.test(sentences.slice(-2).join(' '));
}

export interface SessionSummary {
  key: string; agent: AgentKind; sessionId: string | null; cwd: string | null;
  source: SourceKind | null; title: string | null; lastActivity: string;
  status: SessionStatus; steerable: boolean; wrapperOutdated: boolean; eventCount: number;
  approvalLikely: boolean;  // pending tool + dead spinner on a steerable session: likely a permission prompt
  lastTool: string | null;  // name of the most recent tool_call, for the working ticker
  gitBranch: string | null;
  now: string | null;  // status-aware one-liner: what the agent does or waits on
  spinner: string | null;  // the CLI's live in-terminal spinner line, bridged sessions only
}

interface SessionRec {
  agent: AgentKind; sessionId: string | null; cwd: string | null;
  source: SourceKind | null; title: string | null; lastActivity: string;
  steerable: boolean; wrapperOutdated: boolean; events: AgentEvent[]; gitBranch: string | null;
  spinner: string | null;
  spinnerClearedAt: number | null;  // when the live spinner last went null
  boot?: boolean;  // bridge-only session: the wrapper is up, no transcript yet
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
  // `${agent}:${cwd}` -> number of live agent processes launched from that cwd
  private aliveCounts = new Map<string, number>();

  apply(agent: AgentKind, fileId: string, parsed: ParsedLine): void {
    if (parsed.events.length === 0 && !parsed.meta) return;
    const key = `${agent}:${fileId}`;
    let rec = this.sessions.get(key);
    if (!rec) {
      rec = { agent, sessionId: null, cwd: null, source: null, title: null, lastActivity: new Date(0).toISOString(), steerable: false, wrapperOutdated: false, events: [], gitBranch: null, spinner: null, spinnerClearedAt: null };
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

  setAliveCounts(counts: Map<string, number>): void { this.aliveCounts = counts; }

  setWrapperOutdated(key: string, on: boolean): void {
    const rec = this.sessions.get(key);
    if (rec && rec.wrapperOutdated !== on) {
      rec.wrapperOutdated = on;
      this.emit('events', { key, events: [] });
    }
  }

  setSteerable(key: string, on: boolean): void {
    const rec = this.sessions.get(key);
    if (rec) { rec.steerable = on; this.emit('events', { key, events: [] }); }
  }

  setSpinner(key: string, text: string | null, at: Date = new Date()): void {
    const rec = this.sessions.get(key);
    if (!rec || rec.spinner === text) return;
    // Track when the spinner dies: a pending tool with a long-dead spinner
    // on a steerable session is the permission-prompt signal.
    rec.spinnerClearedAt = text === null ? at.getTime() : null;
    rec.spinner = text;
    this.emit('events', { key, events: [] });
  }

  // A fresh `av claude` writes no transcript until after its startup
  // prompts, so the session's FIRST question would be invisible. The
  // bridge registers a boot session from its hello alone; the row
  // disappears when the real transcript appears or the wrapper dies.
  registerBoot(key: string, agent: AgentKind, cwd: string): void {
    if (this.sessions.has(key)) return;
    this.sessions.set(key, {
      agent, sessionId: null, cwd, source: 'terminal', title: null,
      lastActivity: new Date().toISOString(), steerable: false,
      wrapperOutdated: false, events: [], gitBranch: null,
      spinner: null, spinnerClearedAt: null, boot: true,
    });
    this.emit('events', { key, events: [] });
  }

  removeBoot(key: string): void {
    const rec = this.sessions.get(key);
    if (rec?.boot) {
      this.sessions.delete(key);
      this.emit('events', { key, events: [] });
    }
  }

  findKeyByAgentCwd(agent: AgentKind, cwd: string): string | null {
    let best: { key: string; last: string } | null = null;
    for (const [key, rec] of this.sessions) {
      // boot sessions are bridge-private placeholders, never a pairing target
      if (rec.boot) continue;
      if (rec.agent === agent && rec.cwd === cwd && (!best || rec.lastActivity > best.last)) {
        best = { key, last: rec.lastActivity };
      }
    }
    return best?.key ?? null;
  }

  summaries(now: Date = new Date()): SessionSummary[] {
    const out: SessionSummary[] = [];
    // The N live processes launched from a cwd belong to the N MOST RECENT
    // sessions there; older sessions in the same directory must not ride
    // along as alive, but a second concurrent agent in one repo must.
    const stampsByHome = new Map<string, string[]>();
    for (const rec of this.sessions.values()) {
      if (!rec.cwd) continue;
      const home = `${rec.agent}:${rec.cwd}`;
      const arr = stampsByHome.get(home);
      if (arr) arr.push(rec.lastActivity);
      else stampsByHome.set(home, [rec.lastActivity]);
    }
    for (const arr of stampsByHome.values()) arr.sort((a, b) => (a < b ? 1 : -1));
    for (const [key, rec] of this.sessions) {
      const age = now.getTime() - new Date(rec.lastActivity).getTime();
      if (age > DAY_MS) continue;
      if (rec.boot) {
        // Bridge-only session: the wrapper is up, the transcript is not.
        // Its startup prompt lives only in the terminal; say so.
        out.push({
          key, agent: rec.agent, sessionId: null, cwd: rec.cwd, source: rec.source,
          title: null, lastActivity: rec.lastActivity, status: 'waiting',
          steerable: rec.steerable, wrapperOutdated: rec.wrapperOutdated,
          eventCount: 0, approvalLikely: false, lastTool: null, gitBranch: null,
          now: 'starting up — its first prompt shows only in the Terminal tab',
          spinner: rec.spinner,
        });
        continue;
      }
      const last = rec.events[rec.events.length - 1];
      const home = rec.cwd ? `${rec.agent}:${rec.cwd}` : null;
      const liveN = home ? this.aliveCounts.get(home) ?? 0 : 0;
      const alive = !!home && liveN > 0
        && (stampsByHome.get(home)?.indexOf(rec.lastActivity) ?? Infinity) < liveN;
      const lastMsg = [...rec.events].reverse().find((e) => e.kind === 'assistant_message');
      let status: SessionStatus;
      if (age <= WORKING_MS) status = 'working';
      else if (!alive) status = 'ended';
      else if (last?.kind === 'tool_call') status = 'blocked';
      else if (last?.kind === 'assistant_message' || (last?.kind === 'turn_status' && last.status === 'completed')) {
        // The alarm tier is earned only by an actual ask. A turn that ends on
        // a statement is a calm "waiting", not a NEEDS YOU.
        status = lastMsg?.kind === 'assistant_message' && asksQuestion(lastMsg.text) ? 'needs_input' : 'waiting';
      }
      else status = 'idle';
      // A pending tool with a LIVE spinner is real work: stay calm. The same
      // pending tool on a steerable session whose spinner has been dead for
      // APPROVAL_ESCALATE_MS is almost certainly a permission prompt: alarm.
      // Non-steerable sessions have no spinner signal, so they stay calm.
      let approvalLikely = false;
      if (status === 'blocked' && rec.steerable && rec.spinner === null) {
        const since = Math.max(new Date(rec.lastActivity).getTime(), rec.spinnerClearedAt ?? 0);
        approvalLikely = now.getTime() - since >= APPROVAL_ESCALATE_MS;
      }
      const lastTool = [...rec.events].reverse().find((e) => e.kind === 'tool_call');
      let nowLine: string | null = null;
      if (status === 'working' && lastTool?.kind === 'tool_call') {
        nowLine = describeToolCall(lastTool.name, lastTool.input);
      } else if (status === 'needs_input' || status === 'waiting') {
        if (lastMsg?.kind === 'assistant_message') {
          // "asked:" only for a detected question; a statement gets an honest label
          nowLine = `${status === 'needs_input' ? 'asked' : 'said'}: ${messageHead(lastMsg.text)}`;
        }
      } else if (status === 'blocked' && last?.kind === 'tool_call') {
        // A pending tool_call only proves the tool did not return yet. It can be
        // a long-running approved tool or a permission prompt; present elapsed
        // truth ("running X"), never a hard approval claim.
        nowLine = `running ${describeToolCall(last.name, last.input)}`;
      }
      out.push({ key, agent: rec.agent, sessionId: rec.sessionId, cwd: rec.cwd, source: rec.source, title: rec.title, lastActivity: rec.lastActivity, status, steerable: rec.steerable, wrapperOutdated: rec.wrapperOutdated, eventCount: rec.events.length, approvalLikely, lastTool: lastTool?.kind === 'tool_call' ? lastTool.name : null, gitBranch: rec.gitBranch === 'HEAD' ? null : rec.gitBranch, now: nowLine, spinner: rec.spinner });
    }
    // Triage order: a confirmed ask pins the top; a likely permission prompt
    // sits just under it; a calm turn-ended "waiting" comes next. A pending
    // tool call (blocked, spinner live or fresh) is working state, not an
    // alarm, so it shares the working band. Recency breaks ties in each band.
    const rankOf = (s: SessionSummary): number =>
      s.status === 'needs_input' ? 0 :
      s.approvalLikely ? 1 :
      s.status === 'waiting' ? 2 :
      s.status === 'working' || s.status === 'blocked' ? 3 :
      s.status === 'idle' ? 4 : 5;
    return out.sort((a, b) =>
      rankOf(a) - rankOf(b) || (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  events(key: string): AgentEvent[] { return this.sessions.get(key)?.events ?? []; }
}
