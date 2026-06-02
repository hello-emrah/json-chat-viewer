// Shared, platform-neutral transcript model. Every parser maps its source
// format onto these types; the webview renders only these types and knows
// nothing about any specific platform.

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface ImagePayload {
  dataUri: string;
  mediaType: string;
  approxBytes: number;
}

export interface TranscriptMeta {
  sessionId?: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  models: string[];
  firstTimestamp?: string;
  lastTimestamp?: string;
  durationMs?: number;
  counts: {
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    thinking: number;
    images: number;
    errors: number;
  };
  tokens: TokenTotals;
  lineCount: number;
  parseErrors: number;
}

export type TranscriptEvent =
  | { kind: "user"; text: string; ts?: string; uuid?: string; flavor: "human" | "command" | "reminder" | "meta"; label?: string }
  | { kind: "assistant"; text: string; ts?: string; model?: string }
  | { kind: "thinking"; text: string; ts?: string; redacted: boolean }
  | { kind: "tool_call"; name: string; display: string; input: unknown; id?: string; ts?: string; attribution?: string }
  | { kind: "tool_result"; forId?: string; forName?: string; ok: boolean; text: string; images: ImagePayload[]; ts?: string }
  | { kind: "image"; data: ImagePayload; ts?: string }
  | { kind: "system"; level: string; text: string; ts?: string; isError: boolean }
  | { kind: "mode"; mode: string }
  | { kind: "queued"; text: string; ts?: string }
  | { kind: "attachment"; label: string; text?: string; ts?: string }
  | { kind: "error"; text: string; ts?: string };

export interface Transcript {
  meta: TranscriptMeta;
  events: TranscriptEvent[];
}

// A file may contain one conversation (a Claude Code session, an API log) or
// many (a ChatGPT / Claude.ai data export). The bundle is what a parser returns
// and what the webview receives.
export interface TranscriptBundle {
  format: string;       // machine id, e.g. "claude-code"
  formatLabel: string;  // human label, e.g. "Claude Code session"
  conversations: Transcript[];
}

export function emptyMeta(): TranscriptMeta {
  return {
    models: [],
    counts: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, thinking: 0, images: 0, errors: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    lineCount: 0,
    parseErrors: 0,
  };
}
