export type AgentKind = 'claude' | 'codex';
export type SourceKind = 'terminal' | 'desktop' | 'codex';

export type AgentEvent =
  | { kind: 'user_message'; ts: string; text: string }
  | { kind: 'assistant_message'; ts: string; text: string }
  | { kind: 'thinking'; ts: string; text: string }
  | { kind: 'tool_call'; ts: string; name: string; input: string }
  | { kind: 'tool_result'; ts: string; output: string; isError: boolean }
  | { kind: 'turn_status'; ts: string; status: 'started' | 'completed' | 'interrupted' };

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  source: SourceKind;
  gitBranch: string | null;
}

export interface ParsedLine {
  events: AgentEvent[];
  meta?: Partial<SessionMeta>;
}
