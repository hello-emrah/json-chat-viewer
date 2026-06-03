// Parser for Claude.ai data exports (conversations.json). Each conversation has
// a flat `chat_messages` array; newer exports carry structured `content` blocks
// (text / thinking / tool_use / tool_result), older ones just a `text` field.

import { Transcript, TranscriptEvent } from "../types";
import { asArray, toIso, displayToolName, toImage } from "../util";
import { buildTranscript } from "../util";
import { ParseCtx } from "./types";

export const id = "claude-export";
export const label = "Claude.ai export";

function looksLikeConversation(o: any): boolean {
  return o && typeof o === "object" && Array.isArray(o.chat_messages);
}

export function detect(ctx: ParseCtx): number {
  const d = ctx.doc;
  if (d === undefined) return 0;
  if (Array.isArray(d)) {
    if (!d.length) return 0;
    const hit = d.slice(0, 5).filter(looksLikeConversation).length;
    return hit ? Math.min(0.6 + 0.4 * (hit / Math.min(d.length, 5)), 1) : 0;
  }
  return looksLikeConversation(d) ? 0.95 : 0;
}

function parseConversation(convo: any): Transcript {
  const events: TranscriptEvent[] = [];
  for (const msg of asArray(convo.chat_messages)) {
    if (!msg || typeof msg !== "object") continue;
    const ts = toIso(msg.created_at);
    const isHuman = msg.sender === "human";
    const blocks = asArray(msg.content);

    if (blocks.length) {
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") {
          if (isHuman) events.push({ kind: "user", text: b.text, ts, flavor: "human" });
          else if (b.text.trim()) events.push({ kind: "assistant", text: b.text, ts });
        } else if (b.type === "thinking") {
          const t = typeof b.thinking === "string" ? b.thinking : (typeof b.text === "string" ? b.text : "");
          events.push({ kind: "thinking", text: t, ts, redacted: t.trim().length === 0 });
        } else if (b.type === "tool_use") {
          events.push({ kind: "tool_call", name: b.name || "tool", display: displayToolName(b.name || "tool"), input: b.input, id: b.id, ts });
        } else if (b.type === "tool_result") {
          const content = b.content;
          let text = "";
          const images: NonNullable<ReturnType<typeof toImage>>[] = [];
          if (typeof content === "string") text = content;
          else for (const c of asArray(content)) {
            if (c?.type === "text") text += (text ? "\n" : "") + c.text;
            else if (c?.type === "image") { const img = toImage(c.source); if (img) images.push(img); }
          }
          events.push({ kind: "tool_result", forName: b.name, ok: b.is_error !== true, text, images, ts });
        } else if (b.type === "image") {
          const img = toImage(b.source);
          if (img) events.push({ kind: "image", data: img, ts });
        }
      }
    } else if (typeof msg.text === "string" && msg.text.length) {
      if (isHuman) events.push({ kind: "user", text: msg.text, ts, flavor: "human" });
      else events.push({ kind: "assistant", text: msg.text, ts });
    }

    for (const att of asArray(msg.attachments)) {
      events.push({ kind: "attachment", label: `attachment: ${att.file_name || "file"}`, text: typeof att.extracted_content === "string" ? att.extracted_content : undefined, ts });
    }
    for (const f of asArray(msg.files)) {
      events.push({ kind: "attachment", label: `file: ${f.file_name || f.file_kind || "file"}`, ts });
    }
  }

  return buildTranscript(events, {
    title: convo.name || "Claude conversation",
    sessionId: convo.uuid,
    firstTimestamp: toIso(convo.created_at),
    lastTimestamp: toIso(convo.updated_at),
    messageCount: asArray(convo.chat_messages).length,
  });
}

export function parse(ctx: ParseCtx): Transcript[] {
  const d = ctx.doc;
  const convos = (Array.isArray(d) ? d : [d]).filter(looksLikeConversation);
  const out = convos.map(parseConversation);
  out.sort((a, b) => (b.meta.lastTimestamp || "").localeCompare(a.meta.lastTimestamp || ""));
  return out.length ? out : [parseConversation({})];
}
