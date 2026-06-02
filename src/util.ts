import { ImagePayload, Transcript, TranscriptEvent, TranscriptMeta, emptyMeta } from "./types";

export function asArray(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

export function num(x: unknown): number {
  return typeof x === "number" && isFinite(x) ? x : 0;
}

export function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

// Friendly tool label: mcp__server__tool -> "server · tool"; otherwise the raw name.
export function displayToolName(name: string): string {
  if (!name) return "tool";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) return `${parts[1]} · ${parts.slice(2).join("__")}`;
  }
  return name;
}

// Accepts an Anthropic-style image source ({type:"base64"|"url", ...}) or an
// OpenAI-style image_url ({url:"data:..."|"https:..."}).
export function toImage(source: any): ImagePayload | null {
  if (!source || typeof source !== "object") return null;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
  if (source.type === "base64" && typeof source.data === "string") {
    return { dataUri: `data:${mediaType};base64,${source.data}`, mediaType, approxBytes: Math.floor((source.data.length * 3) / 4) };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { dataUri: source.url, mediaType, approxBytes: 0 };
  }
  if (typeof source.url === "string") {
    const m = source.url.match(/^data:([^;]+);base64,(.*)$/);
    if (m) return { dataUri: source.url, mediaType: m[1], approxBytes: Math.floor((m[2].length * 3) / 4) };
    return { dataUri: source.url, mediaType, approxBytes: 0 };
  }
  return null;
}

// Convert an epoch value (seconds or ms) or ISO string into an ISO timestamp.
export function toIso(t: unknown): string | undefined {
  if (typeof t === "string") {
    const d = Date.parse(t);
    return isNaN(d) ? undefined : new Date(d).toISOString();
  }
  if (typeof t === "number" && isFinite(t)) {
    const ms = t > 1e12 ? t : t * 1000; // seconds vs milliseconds
    return new Date(ms).toISOString();
  }
  return undefined;
}

// Build a Transcript from a flat event list, deriving meta (counts, timestamps,
// duration, models, tokens) so individual parsers don't each reimplement it.
export function buildTranscript(
  events: TranscriptEvent[],
  base?: Partial<TranscriptMeta>
): Transcript {
  const meta: TranscriptMeta = { ...emptyMeta(), ...base };
  const models = new Set<string>(meta.models || []);
  let firstTs: string | undefined = meta.firstTimestamp;
  let lastTs: string | undefined = meta.lastTimestamp;

  for (const ev of events) {
    const ts = (ev as any).ts as string | undefined;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    switch (ev.kind) {
      case "user": if (ev.flavor === "human") meta.counts.user++; break;
      case "assistant": meta.counts.assistant++; if (ev.model && !ev.model.startsWith("<")) models.add(ev.model); break;
      case "thinking": meta.counts.thinking++; break;
      case "tool_call": meta.counts.toolCalls++; break;
      case "tool_result": meta.counts.toolResults++; meta.counts.images += ev.images.length; break;
      case "image": meta.counts.images++; break;
      case "system": if (ev.isError) meta.counts.errors++; break;
      case "error": meta.counts.errors++; break;
    }
  }

  meta.models = [...models];
  meta.firstTimestamp = firstTs;
  meta.lastTimestamp = lastTs;
  if (firstTs && lastTs) {
    const a = Date.parse(firstTs), b = Date.parse(lastTs);
    if (!isNaN(a) && !isNaN(b) && b >= a) meta.durationMs = b - a;
  }
  return { meta, events };
}
