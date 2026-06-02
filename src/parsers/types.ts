import { Transcript } from "../types";

// Prepared, parse-once context handed to every parser's detect()/parse().
export interface ParseCtx {
  text: string;
  fileName: string;
  doc: any | undefined;        // JSON.parse(text) if the whole file is one JSON document, else undefined
  docIsArray: boolean;
  jsonlSample: any[];          // first N successfully-parsed lines (for JSONL detection)
  lineCount: number;
}

export interface Parser {
  id: string;
  label: string;
  detect(ctx: ParseCtx): number;       // confidence 0..1
  parse(ctx: ParseCtx): Transcript[];  // one entry per conversation in the file
}
