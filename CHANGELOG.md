# Changelog

## 0.3.1

- Fixed a **blank transcript** when a log carried a non-string attachment payload (e.g. a nested memory/context object). One bad attachment no longer stops the whole body from rendering; the render primitives now coerce any value to text.
- Fixed the **prompt count** for Claude Code sessions. Tool results are recorded as `user` turns, so they were being counted as prompts; the header now counts only real prompts.

## 0.3.0

- Files with many conversations (Claude.ai and ChatGPT exports) now open with a **searchable chat list** down the side instead of a cramped dropdown. Type to filter by title or date.
- **Every conversation is listed**, including ones the export returned with no body. Those are flagged "empty in export" rather than silently dropped, so the count matches what's actually in your account. (Claude.ai exports routinely return blank shells for some chats; that is an export-side quirk, not a missing chat.)
- Conversations now **load on demand**, so large exports (tens of MB, hundreds of chats) open fast instead of shipping everything up front.
- Your **filter choices are remembered** across files and window reloads.

## 0.2.3

- Whole header (title, stats, toolbar) now stays pinned while you scroll, not just the search row.
- Added **Top** / **End** buttons to jump to the start or end of a transcript.
- **Expand all** / **Collapse all** now carry chevron icons and tooltips that spell out what they act on (reasoning, tool input, long output).

## 0.2.2

- Stats restyled as a flat readout instead of pill buttons (they no longer look clickable).
- Replaced the inline filter toggles with a **Filter** dropdown beside the search, with an active-count badge and a colour swatch per event type.
- Clearer, bordered Expand / Collapse buttons.

## 0.2.1

- New logo and editor icon: a tarot Ace of Cups seal (hand, chalice, dove) in the house terracotta.
- Added a Buy Me a Coffee badge, `FUNDING.yml`, and a minimal README header.

## 0.2.0

- Now LLM-agnostic. Auto-detects and renders Claude Code sessions, ChatGPT and Claude.ai data exports, and raw OpenAI / Anthropic API logs (JSON or JSONL).
- Conversation picker for files that hold more than one conversation.

## 0.1.0

- Initial release: a readable transcript view for Claude Code `.jsonl` session logs.
