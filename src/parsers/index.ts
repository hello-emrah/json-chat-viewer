import * as claudeCode from "./claudeCode";
import * as chatgptExport from "./chatgptExport";
import * as claudeExport from "./claudeExport";
import * as openaiApi from "./openaiApi";
import { Parser, ParseCtx } from "./types";
import { TranscriptBundle } from "../types";
import { buildTranscript } from "../util";

// Order is a tie-break only; the highest detect() score wins regardless.
// Specific export formats are listed before the generic API catch-all.
const PARSERS: Parser[] = [claudeCode, chatgptExport, claudeExport, openaiApi];

function prepare(text: string, fileName: string): ParseCtx {
  let doc: any | undefined;
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  if (doc !== undefined) {
    return { text, fileName, doc, docIsArray: Array.isArray(doc), jsonlSample: [], lineCount: 1 };
  }
  const sample: any[] = [];
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    count++;
    if (sample.length < 20) { try { sample.push(JSON.parse(t)); } catch { /* skip */ } }
  }
  return { text, fileName, doc: undefined, docIsArray: false, jsonlSample: sample, lineCount: count };
}

function noticeBundle(format: string, label: string, message: string): TranscriptBundle {
  return {
    format,
    formatLabel: label,
    conversations: [buildTranscript([{ kind: "system", level: "info", text: message, isError: false }], { title: label })],
  };
}

export function parseAny(text: string, fileName: string): TranscriptBundle {
  if (!text.trim()) return noticeBundle("empty", "Empty file", "This file is empty.");
  const ctx = prepare(text, fileName);

  let best: { p: Parser; score: number } | null = null;
  for (const p of PARSERS) {
    let s = 0;
    try { s = p.detect(ctx); } catch { s = 0; }
    if (s > 0 && (!best || s > best.score)) best = { p, score: s };
  }

  if (!best) {
    return noticeBundle(
      "unknown",
      "Unrecognised format",
      "This doesn't look like a supported chat log.\n\nSupported: Claude Code sessions (.jsonl), ChatGPT and Claude.ai data exports (conversations.json), and raw OpenAI / Anthropic API logs (messages array, JSON or JSONL)."
    );
  }

  let conversations;
  try { conversations = best.p.parse(ctx); } catch (e) {
    return noticeBundle(best.p.id, best.p.label, `Detected ${best.p.label}, but parsing failed: ${String(e)}`);
  }
  // Keep every well-formed conversation, including ones with no events. Exports
  // (Claude.ai / ChatGPT) routinely return blank conversation shells — messages
  // with empty text and content. Dropping them silently makes the viewer look
  // like it's "missing chats"; instead we list them and flag them as empty.
  conversations = (conversations || []).filter((c) => c && Array.isArray(c.events));
  if (!conversations.length) return noticeBundle(best.p.id, best.p.label, `Detected ${best.p.label}, but found no messages.`);
  // A single empty conversation (e.g. one blank session file) is genuinely
  // nothing to show — fall back to the notice. Multi-conversation files always
  // list everything so the count matches what the user expects.
  if (conversations.length === 1 && conversations[0].events.length === 0) {
    return noticeBundle(best.p.id, best.p.label, `Detected ${best.p.label}, but found no messages.`);
  }

  return { format: best.p.id, formatLabel: best.p.label, conversations };
}
