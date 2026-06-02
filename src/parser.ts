// Pure (no vscode dependency) parser that turns a Claude Code .jsonl session log
// into a flat, render-ready transcript model. Defensive throughout: any field may
// be missing or the wrong shape, and malformed lines are counted, not fatal.

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
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

export interface ImagePayload {
  dataUri: string;
  mediaType: string;
  approxBytes: number;
}

export interface Transcript {
  meta: TranscriptMeta;
  events: TranscriptEvent[];
}

function asArray(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

function num(x: unknown): number {
  return typeof x === "number" && isFinite(x) ? x : 0;
}

function toImage(source: any): ImagePayload | null {
  if (!source || typeof source !== "object") return null;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
  if (source.type === "base64" && typeof source.data === "string") {
    return {
      dataUri: `data:${mediaType};base64,${source.data}`,
      mediaType,
      approxBytes: Math.floor((source.data.length * 3) / 4),
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { dataUri: source.url, mediaType, approxBytes: 0 };
  }
  return null;
}

// Friendly tool label: mcp__server__tool -> "server · tool"; otherwise the raw name.
export function displayToolName(name: string): string {
  if (!name) return "tool";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) {
      return `${parts[1]} · ${parts.slice(2).join("__")}`;
    }
  }
  return name;
}

function classifyUserText(text: string): { flavor: "human" | "command" | "reminder" | "meta"; label?: string } {
  const t = text.trimStart();
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) return { flavor: "command", label: cmd[1].trim().replace(/^\//, "") };
  if (t.startsWith("<command-message>") || t.startsWith("<command-args>")) return { flavor: "command" };
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-stderr>")) return { flavor: "command", label: "command output" };
  if (t.startsWith("<system-reminder>")) return { flavor: "reminder" };
  if (t.startsWith("Caveat:") || t.includes("This session is being continued")) return { flavor: "meta" };
  return { flavor: "human" };
}

function flattenToolResultContent(content: unknown): { text: string; images: ImagePayload[] } {
  const images: ImagePayload[] = [];
  if (typeof content === "string") return { text: content, images };
  const parts: string[] = [];
  for (const block of asArray(content)) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string") parts.push(block);
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const img = toImage(block.source);
      if (img) images.push(img);
    } else if (block.type === "tool_reference") {
      const ref = block.name || block.toolName || block.id || "reference";
      parts.push(`↳ ${ref}`);
    }
  }
  return { text: parts.join("\n"), images };
}

function attachmentLabel(att: any): { label: string; text?: string } {
  const type = att?.type || "context";
  switch (type) {
    case "file":
      return { label: `file: ${att.displayPath || att.filename || ""}`.trim(), text: att.snippet };
    case "new_directory":
    case "directory":
      return { label: `directory context` };
    case "command_output":
    case "hook_output":
      return { label: `hook: ${att.hookName || att.hookEvent || ""}`.trim(), text: att.stdout || att.content };
    case "queued_command":
      return { label: `queued: ${att.prompt || ""}`.slice(0, 120) };
    case "selected_lines_in_ide":
      return { label: `editor selection: ${att.filename || ""}`.trim(), text: att.content };
    case "todo":
      return { label: "todo update", text: typeof att.content === "string" ? att.content : undefined };
    case "nested_memory":
    case "ultramemory":
      return { label: "memory / context", text: att.content };
    default:
      return { label: String(type).replace(/_/g, " "), text: typeof att.content === "string" ? att.content : undefined };
  }
}

export function parseTranscript(raw: string): Transcript {
  const lines = raw.split(/\r?\n/);
  const events: TranscriptEvent[] = [];
  const models = new Set<string>();
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const counts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, thinking: 0, images: 0, errors: 0 };
  const toolNameById = new Map<string, string>();
  let parseErrors = 0;
  let lineCount = 0;
  let title: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let lastMode: string | undefined;

  // First pass: map tool_use ids to names so results can name their call.
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type === "assistant" && Array.isArray(rec?.message?.content)) {
      for (const b of rec.message.content) {
        if (b?.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name);
      }
    }
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    lineCount++;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }

    const ts: string | undefined = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    if (typeof rec.gitBranch === "string") gitBranch = rec.gitBranch;
    if (typeof rec.version === "string") version = rec.version;

    switch (rec.type) {
      case "ai-title":
        if (typeof rec.aiTitle === "string") title = rec.aiTitle;
        break;

      case "mode":
        if (typeof rec.mode === "string" && rec.mode !== lastMode) {
          lastMode = rec.mode;
          events.push({ kind: "mode", mode: rec.mode });
        }
        break;

      case "queue-operation":
        if (rec.operation === "enqueue" && typeof rec.content === "string") {
          events.push({ kind: "queued", text: rec.content, ts });
        }
        break;

      case "last-prompt":
        break; // bookkeeping only

      case "attachment": {
        const { label, text } = attachmentLabel(rec.attachment);
        events.push({ kind: "attachment", label, text, ts });
        break;
      }

      case "system": {
        const isError = rec.subtype === "api_error" || rec.level === "error" || rec.isApiErrorMessage === true;
        const text =
          (typeof rec.content === "string" && rec.content) ||
          (typeof rec.error === "string" && rec.error) ||
          (typeof rec.stopReason === "string" && `stop: ${rec.stopReason}`) ||
          (typeof rec.subtype === "string" && rec.subtype.replace(/_/g, " ")) ||
          "system event";
        if (isError) counts.errors++;
        events.push({ kind: "system", level: rec.level || rec.subtype || "info", text, ts, isError });
        break;
      }

      case "user": {
        counts.user++;
        const content = rec?.message?.content;
        if (typeof content === "string") {
          const { flavor, label } = classifyUserText(content);
          events.push({ kind: "user", text: content, ts, uuid: rec.uuid, flavor, label });
          break;
        }
        for (const block of asArray(content)) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            const { flavor, label } = classifyUserText(block.text);
            events.push({ kind: "user", text: block.text, ts, uuid: rec.uuid, flavor, label });
          } else if (block.type === "tool_result") {
            counts.toolResults++;
            const { text, images } = flattenToolResultContent(block.content);
            counts.images += images.length;
            const forName = block.tool_use_id ? toolNameById.get(block.tool_use_id) : undefined;
            events.push({
              kind: "tool_result",
              forId: block.tool_use_id,
              forName,
              ok: block.is_error !== true,
              text,
              images,
              ts,
            });
          } else if (block.type === "image") {
            const img = toImage(block.source);
            if (img) {
              counts.images++;
              events.push({ kind: "image", data: img, ts });
            }
          }
        }
        break;
      }

      case "assistant": {
        counts.assistant++;
        const model = typeof rec?.message?.model === "string" ? rec.message.model : undefined;
        if (model && !model.startsWith("<")) models.add(model);
        const usage = rec?.message?.usage;
        if (usage && typeof usage === "object") {
          tokens.input += num(usage.input_tokens);
          tokens.output += num(usage.output_tokens);
          tokens.cacheRead += num(usage.cache_read_input_tokens);
          tokens.cacheCreate += num(usage.cache_creation_input_tokens);
        }
        for (const block of asArray(rec?.message?.content)) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.trim()) events.push({ kind: "assistant", text: block.text, ts, model });
          } else if (block.type === "thinking") {
            const thinking = typeof block.thinking === "string" ? block.thinking : "";
            const redacted = thinking.trim().length === 0;
            counts.thinking++;
            events.push({ kind: "thinking", text: thinking, ts, redacted });
          } else if (block.type === "tool_use") {
            counts.toolCalls++;
            const attribution =
              rec.attributionSkill ? `skill: ${rec.attributionSkill}` :
              rec.attributionMcpServer ? `mcp: ${rec.attributionMcpServer}` : undefined;
            events.push({
              kind: "tool_call",
              name: block.name || "tool",
              display: displayToolName(block.name || "tool"),
              input: block.input,
              id: block.id,
              ts,
              attribution,
            });
          }
        }
        break;
      }

      default:
        if (rec.isApiErrorMessage || rec.error) {
          counts.errors++;
          events.push({ kind: "error", text: typeof rec.error === "string" ? rec.error : "error", ts });
        }
        break;
    }
  }

  let durationMs: number | undefined;
  if (firstTs && lastTs) {
    const a = Date.parse(firstTs);
    const b = Date.parse(lastTs);
    if (!isNaN(a) && !isNaN(b) && b >= a) durationMs = b - a;
  }

  return {
    meta: {
      sessionId,
      title,
      cwd,
      gitBranch,
      version,
      models: [...models],
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      durationMs,
      counts,
      tokens,
      lineCount,
      parseErrors,
    },
    events,
  };
}
