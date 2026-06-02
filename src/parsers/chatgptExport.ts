// Parser for ChatGPT data exports (conversations.json). Each conversation is a
// tree of message nodes in `mapping`; the visible thread is the path from
// `current_node` back to the root, so we walk parents and reverse.

import { Transcript, TranscriptEvent } from "../types";
import { asArray, toIso, displayToolName } from "../util";
import { ParseCtx } from "./types";

export const id = "chatgpt-export";
export const label = "ChatGPT export";

function looksLikeConversation(o: any): boolean {
  return o && typeof o === "object" && o.mapping && typeof o.mapping === "object" &&
    (typeof o.current_node === "string" || "current_node" in o);
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

function contentToText(content: any): { text: string; isCode: boolean } {
  if (!content || typeof content !== "object") return { text: "", isCode: false };
  switch (content.content_type) {
    case "text":
      return { text: asArray(content.parts).filter((p) => typeof p === "string").join("\n"), isCode: false };
    case "code":
      return { text: typeof content.text === "string" ? content.text : "", isCode: true };
    case "execution_output":
      return { text: typeof content.text === "string" ? content.text : "", isCode: false };
    case "multimodal_text": {
      const bits = asArray(content.parts).map((p) =>
        typeof p === "string" ? p : (p && p.content_type === "image_asset_pointer" ? "[image]" : "")
      );
      return { text: bits.filter(Boolean).join("\n"), isCode: false };
    }
    case "tether_quote":
      return { text: [content.title, content.text].filter(Boolean).join("\n"), isCode: false };
    case "tether_browsing_display":
      return { text: typeof content.result === "string" ? content.result : "", isCode: false };
    default:
      if (Array.isArray(content.parts)) return { text: content.parts.filter((p: any) => typeof p === "string").join("\n"), isCode: false };
      if (typeof content.text === "string") return { text: content.text, isCode: false };
      return { text: "", isCode: false };
  }
}

function linearise(convo: any): any[] {
  const mapping = convo.mapping || {};
  const path: any[] = [];
  let nodeId: string | undefined = convo.current_node;
  // fall back to any leaf if current_node is missing
  if (!nodeId || !mapping[nodeId]) {
    nodeId = Object.keys(mapping).find((k) => !asArray(mapping[k].children).length);
  }
  const guard = new Set<string>();
  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    path.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  return path.reverse();
}

function parseConversation(convo: any): Transcript {
  const events: TranscriptEvent[] = [];
  let firstTs: string | undefined, lastTs: string | undefined;
  const models = new Set<string>();

  for (const node of linearise(convo)) {
    const msg = node.message;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.author?.role;
    const meta = msg.metadata || {};
    if (meta.is_visually_hidden_from_conversation) continue;
    const { text, isCode } = contentToText(msg.content);
    const ts = toIso(msg.create_time);
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const model = typeof meta.model_slug === "string" ? meta.model_slug : undefined;
    if (model) models.add(model);
    const recipient = msg.recipient && msg.recipient !== "all" ? msg.recipient : undefined;

    if (role === "system") {
      if (text.trim()) events.push({ kind: "system", level: "system", text, ts, isError: false });
    } else if (role === "user") {
      if (text.trim()) events.push({ kind: "user", text, ts, flavor: "human" });
    } else if (role === "tool") {
      events.push({ kind: "tool_result", forName: msg.author?.name || recipient || "tool", ok: true, text, images: [], ts });
    } else if (role === "assistant") {
      if (recipient) {
        events.push({ kind: "tool_call", name: recipient, display: displayToolName(recipient), input: isCode ? { code: text } : { input: text }, ts, attribution: undefined });
      } else if (text.trim()) {
        events.push({ kind: "assistant", text: isCode ? "```\n" + text + "\n```" : text, ts, model });
      }
    }
  }

  let durationMs: number | undefined;
  if (firstTs && lastTs) { const a = Date.parse(firstTs), b = Date.parse(lastTs); if (!isNaN(a) && !isNaN(b) && b >= a) durationMs = b - a; }
  const counts = { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, thinking: 0, images: 0, errors: 0 };
  for (const e of events) {
    if (e.kind === "user" && e.flavor === "human") counts.user++;
    else if (e.kind === "assistant") counts.assistant++;
    else if (e.kind === "tool_call") counts.toolCalls++;
    else if (e.kind === "tool_result") counts.toolResults++;
  }
  return {
    meta: {
      title: convo.title || "ChatGPT conversation",
      sessionId: convo.conversation_id || convo.id,
      models: [...models], firstTimestamp: firstTs, lastTimestamp: lastTs, durationMs,
      counts, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, lineCount: 0, parseErrors: 0,
    },
    events,
  };
}

export function parse(ctx: ParseCtx): Transcript[] {
  const d = ctx.doc;
  const convos = (Array.isArray(d) ? d : [d]).filter(looksLikeConversation);
  const out = convos.map(parseConversation);
  out.sort((a, b) => (b.meta.lastTimestamp || "").localeCompare(a.meta.lastTimestamp || ""));
  return out.length ? out : [parseConversation({})];
}
