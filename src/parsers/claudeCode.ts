// Parser for Claude Code session logs: one JSON object per line (.jsonl),
// typically under ~/.claude/projects/<project>/<session-id>.jsonl.

import { Transcript, TranscriptEvent, TokenTotals } from "../types";
import { asArray, num, displayToolName, toImage } from "../util";
import { ParseCtx } from "./types";

const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "attachment", "mode", "ai-title", "last-prompt", "queue-operation",
]);

export const id = "claude-code";
export const label = "Claude Code session";

export function detect(ctx: ParseCtx): number {
  if (ctx.doc !== undefined) return 0; // Claude Code is JSONL, not a single JSON doc
  const sample = ctx.jsonlSample;
  if (!sample.length) return 0;
  let hits = 0;
  for (const r of sample) {
    if (r && typeof r === "object" && typeof r.type === "string" && KNOWN_TYPES.has(r.type) &&
        (typeof r.sessionId === "string" || typeof r.uuid === "string")) hits++;
  }
  const ratio = hits / sample.length;
  let score = ratio * 0.9;
  if (/\.claude\/projects\//.test(ctx.fileName)) score += 0.1;
  return Math.min(score, 1);
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

function flattenToolResultContent(content: unknown) {
  const images = [] as ReturnType<typeof toImage>[];
  const out: { text: string; images: NonNullable<ReturnType<typeof toImage>>[] } = { text: "", images: [] };
  if (typeof content === "string") { out.text = content; return out; }
  const parts: string[] = [];
  for (const block of asArray(content)) {
    if (typeof block === "string") { parts.push(block); continue; }
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") { const img = toImage(block.source); if (img) out.images.push(img); }
    else if (block.type === "tool_reference") parts.push(`↳ ${block.name || block.toolName || block.id || "reference"}`);
  }
  out.text = parts.join("\n");
  return out;
}

function attachmentLabel(att: any): { label: string; text?: string } {
  const type = att?.type || "context";
  switch (type) {
    case "file": return { label: `file: ${att.displayPath || att.filename || ""}`.trim(), text: att.snippet };
    case "command_output":
    case "hook_output": return { label: `hook: ${att.hookName || att.hookEvent || ""}`.trim(), text: att.stdout || att.content };
    case "selected_lines_in_ide": return { label: `editor selection: ${att.filename || ""}`.trim(), text: att.content };
    case "todo": return { label: "todo update", text: typeof att.content === "string" ? att.content : undefined };
    case "nested_memory":
    case "ultramemory": return { label: "memory / context", text: att.content };
    default: return { label: String(type).replace(/_/g, " "), text: typeof att.content === "string" ? att.content : undefined };
  }
}

export function parse(ctx: ParseCtx): Transcript[] {
  const lines = ctx.text.split(/\r?\n/);
  const events: TranscriptEvent[] = [];
  const models = new Set<string>();
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const counts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, thinking: 0, images: 0, errors: 0 };
  const toolNameById = new Map<string, string>();
  let parseErrors = 0, lineCount = 0;
  let title, sessionId, cwd, gitBranch, version, firstTs, lastTs: string | undefined;
  let lastMode: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any; try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type === "assistant" && Array.isArray(rec?.message?.content)) {
      for (const b of rec.message.content) if (b?.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name);
    }
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    lineCount++;
    let rec: any; try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
    const ts: string | undefined = typeof rec.timestamp === "string" ? rec.timestamp : undefined;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    if (typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    if (typeof rec.gitBranch === "string") gitBranch = rec.gitBranch;
    if (typeof rec.version === "string") version = rec.version;

    switch (rec.type) {
      case "ai-title": if (typeof rec.aiTitle === "string") title = rec.aiTitle; break;
      case "mode": if (typeof rec.mode === "string" && rec.mode !== lastMode) { lastMode = rec.mode; events.push({ kind: "mode", mode: rec.mode }); } break;
      case "queue-operation": if (rec.operation === "enqueue" && typeof rec.content === "string") events.push({ kind: "queued", text: rec.content, ts }); break;
      case "last-prompt": break;
      case "attachment": { const { label, text } = attachmentLabel(rec.attachment); events.push({ kind: "attachment", label, text, ts }); break; }
      case "system": {
        const isError = rec.subtype === "api_error" || rec.level === "error" || rec.isApiErrorMessage === true;
        const text = (typeof rec.content === "string" && rec.content) || (typeof rec.error === "string" && rec.error) ||
          (typeof rec.stopReason === "string" && `stop: ${rec.stopReason}`) || (typeof rec.subtype === "string" && rec.subtype.replace(/_/g, " ")) || "system event";
        if (isError) counts.errors++;
        events.push({ kind: "system", level: rec.level || rec.subtype || "info", text, ts, isError });
        break;
      }
      case "user": {
        counts.user++;
        const content = rec?.message?.content;
        if (typeof content === "string") { const { flavor, label } = classifyUserText(content); events.push({ kind: "user", text: content, ts, uuid: rec.uuid, flavor, label }); break; }
        for (const block of asArray(content)) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") { const { flavor, label } = classifyUserText(block.text); events.push({ kind: "user", text: block.text, ts, uuid: rec.uuid, flavor, label }); }
          else if (block.type === "tool_result") {
            counts.toolResults++;
            const { text, images } = flattenToolResultContent(block.content);
            counts.images += images.length;
            const forName = block.tool_use_id ? toolNameById.get(block.tool_use_id) : undefined;
            events.push({ kind: "tool_result", forId: block.tool_use_id, forName, ok: block.is_error !== true, text, images, ts });
          } else if (block.type === "image") { const img = toImage(block.source); if (img) { counts.images++; events.push({ kind: "image", data: img, ts }); } }
        }
        break;
      }
      case "assistant": {
        counts.assistant++;
        const model = typeof rec?.message?.model === "string" ? rec.message.model : undefined;
        if (model && !model.startsWith("<")) models.add(model);
        const usage = rec?.message?.usage;
        if (usage && typeof usage === "object") {
          tokens.input += num(usage.input_tokens); tokens.output += num(usage.output_tokens);
          tokens.cacheRead += num(usage.cache_read_input_tokens); tokens.cacheCreate += num(usage.cache_creation_input_tokens);
        }
        for (const block of asArray(rec?.message?.content)) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") { if (block.text.trim()) events.push({ kind: "assistant", text: block.text, ts, model }); }
          else if (block.type === "thinking") { const thinking = typeof block.thinking === "string" ? block.thinking : ""; counts.thinking++; events.push({ kind: "thinking", text: thinking, ts, redacted: thinking.trim().length === 0 }); }
          else if (block.type === "tool_use") {
            counts.toolCalls++;
            const attribution = rec.attributionSkill ? `skill: ${rec.attributionSkill}` : rec.attributionMcpServer ? `mcp: ${rec.attributionMcpServer}` : undefined;
            events.push({ kind: "tool_call", name: block.name || "tool", display: displayToolName(block.name || "tool"), input: block.input, id: block.id, ts, attribution });
          }
        }
        break;
      }
      default: if (rec.isApiErrorMessage || rec.error) { counts.errors++; events.push({ kind: "error", text: typeof rec.error === "string" ? rec.error : "error", ts }); } break;
    }
  }

  let durationMs: number | undefined;
  if (firstTs && lastTs) { const a = Date.parse(firstTs), b = Date.parse(lastTs); if (!isNaN(a) && !isNaN(b) && b >= a) durationMs = b - a; }

  return [{
    meta: { sessionId, title, cwd, gitBranch, version, models: [...models], firstTimestamp: firstTs, lastTimestamp: lastTs, durationMs, counts, tokens, lineCount, parseErrors },
    events,
  }];
}
