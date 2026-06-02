// Catch-all parser for raw LLM API logs, making the viewer genuinely
// vendor-neutral. Handles:
//   - OpenAI Chat Completions: {messages:[{role,content,tool_calls,...}]} or a bare array
//   - Anthropic Messages: {messages:[...]} with content blocks, or a single response object
//   - fine-tune JSONL: one {messages:[...]} per line (each line is a conversation)
//   - simple JSONL: one {role,content} per line (the whole file is one conversation)

import { Transcript, TranscriptEvent, ImagePayload } from "../types";
import { asArray, displayToolName, toImage, buildTranscript } from "../util";
import { ParseCtx } from "./types";

export const id = "api-log";
export const label = "LLM API log";

function isMessage(o: any): boolean {
  return o && typeof o === "object" && typeof o.role === "string" && ("content" in o || "tool_calls" in o || "function_call" in o);
}
function messagesOf(o: any): any[] | null {
  if (Array.isArray(o) && o.length && o.every((x) => isMessage(x) || (x && typeof x === "object"))) {
    return o.some(isMessage) ? o : null;
  }
  if (o && typeof o === "object" && Array.isArray(o.messages)) return o.messages;
  return null;
}

export function detect(ctx: ParseCtx): number {
  if (ctx.doc !== undefined) {
    if (messagesOf(ctx.doc)) return 0.55;
    if (isMessage(ctx.doc)) return 0.5;
    if (ctx.doc?.type === "message" && Array.isArray(ctx.doc.content)) return 0.5; // Anthropic response
    return 0;
  }
  // JSONL forms
  const s = ctx.jsonlSample;
  if (!s.length) return 0;
  if (s.every((l) => Array.isArray(l.messages))) return 0.5;
  if (s.filter(isMessage).length / s.length > 0.6) return 0.45;
  return 0;
}

function flattenContent(content: any): { text: string; images: ImagePayload[] } {
  const images: ImagePayload[] = [];
  if (typeof content === "string") return { text: content, images };
  const parts: string[] = [];
  for (const b of asArray(content)) {
    if (typeof b === "string") { parts.push(b); continue; }
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" || b.type === "input_text" || b.type === "output_text") parts.push(b.text || "");
    else if (b.type === "image") { const i = toImage(b.source); if (i) images.push(i); }
    else if (b.type === "image_url") { const i = toImage(b.image_url || b); if (i) images.push(i); }
    else if (typeof b.text === "string") parts.push(b.text);
  }
  return { text: parts.join("\n"), images };
}

function parseArgs(a: any): unknown {
  if (typeof a !== "string") return a;
  try { return JSON.parse(a); } catch { return { arguments: a }; }
}

function emitText(events: TranscriptEvent[], role: string, text: string, model?: string, ts?: string) {
  if (!text.trim()) return;
  if (role === "system" || role === "developer") events.push({ kind: "system", level: "system", text, ts, isError: false });
  else if (role === "user") events.push({ kind: "user", text, ts, flavor: "human" });
  else events.push({ kind: "assistant", text, ts, model });
}

function messageToEvents(events: TranscriptEvent[], msg: any, model?: string, ts?: string) {
  if (!msg || typeof msg !== "object") return;
  const role = msg.role || (msg.type === "message" ? "assistant" : "assistant");

  if (role === "tool" || role === "function") {
    const { text, images } = flattenContent(msg.content);
    events.push({ kind: "tool_result", forId: msg.tool_call_id, forName: msg.name, ok: true, text, images, ts });
    return;
  }

  for (const tc of asArray(msg.tool_calls)) {
    const fn = tc.function || {};
    events.push({ kind: "tool_call", name: fn.name || tc.type || "tool", display: displayToolName(fn.name || "tool"), input: parseArgs(fn.arguments), id: tc.id, ts });
  }
  if (msg.function_call) {
    const fn = msg.function_call;
    events.push({ kind: "tool_call", name: fn.name || "function", display: displayToolName(fn.name || "function"), input: parseArgs(fn.arguments), ts });
  }

  const content = msg.content;
  if (typeof content === "string") { emitText(events, role, content, model, ts); return; }
  for (const b of asArray(content)) {
    if (typeof b === "string") { emitText(events, role, b, model, ts); continue; }
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text": case "input_text": case "output_text": emitText(events, role, b.text || "", model, ts); break;
      case "image": { const i = toImage(b.source); if (i) events.push({ kind: "image", data: i, ts }); break; }
      case "image_url": { const i = toImage(b.image_url || b); if (i) events.push({ kind: "image", data: i, ts }); break; }
      case "thinking": case "reasoning": { const t = b.thinking || b.text || ""; events.push({ kind: "thinking", text: t, ts, redacted: !String(t).trim() }); break; }
      case "tool_use": events.push({ kind: "tool_call", name: b.name || "tool", display: displayToolName(b.name || "tool"), input: b.input, id: b.id, ts }); break;
      case "tool_result": { const f = flattenContent(b.content); events.push({ kind: "tool_result", forId: b.tool_use_id, ok: b.is_error !== true, text: f.text, images: f.images, ts }); break; }
      default: if (typeof b.text === "string") emitText(events, role, b.text, model, ts);
    }
  }
}

function buildFromMessages(messages: any[], topModel?: string, title?: string): Transcript {
  const events: TranscriptEvent[] = [];
  for (const m of messages) messageToEvents(events, m, topModel);
  return buildTranscript(events, { title, models: topModel ? [topModel] : [] });
}

export function parse(ctx: ParseCtx): Transcript[] {
  // Single JSON document
  if (ctx.doc !== undefined) {
    const d = ctx.doc;
    const msgs = messagesOf(d);
    if (msgs) return [buildFromMessages(msgs, typeof d.model === "string" ? d.model : undefined)];
    if (isMessage(d) || (d?.type === "message" && Array.isArray(d.content))) {
      const events: TranscriptEvent[] = [];
      messageToEvents(events, d, typeof d.model === "string" ? d.model : undefined);
      return [buildTranscript(events, { models: typeof d.model === "string" ? [d.model] : [] })];
    }
    return [buildTranscript([])];
  }
  // JSONL
  const lines = ctx.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const recs: any[] = [];
  for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* skip */ } }

  if (recs.length && recs.every((r) => Array.isArray(r.messages))) {
    // fine-tune style: each line is its own conversation
    return recs.map((r, i) => buildFromMessages(r.messages, undefined, `Conversation ${i + 1}`));
  }
  // otherwise treat every line as a message in one conversation
  const events: TranscriptEvent[] = [];
  for (const r of recs) messageToEvents(events, r);
  return [buildTranscript(events)];
}
