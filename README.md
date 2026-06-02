# JSON Chat Viewer

[![Latest release](https://img.shields.io/github/v/release/hello-emrah/json-chat-viewer?label=download)](https://github.com/hello-emrah/json-chat-viewer/releases/latest)
[![Build](https://github.com/hello-emrah/json-chat-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/hello-emrah/json-chat-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A VS Code extension that turns raw LLM chat logs into a clean, readable transcript. One renderer, many formats: Claude Code sessions, ChatGPT and Claude.ai data exports, and raw OpenAI / Anthropic API logs all open as a proper conversation instead of a wall of JSON.

> **Install in 30 seconds:** grab the latest `.vsix` from the **[Releases page](https://github.com/hello-emrah/json-chat-viewer/releases/latest)**, then in VS Code: Extensions view → `…` menu → **Install from VSIX…**. Full steps [below](#install).

## Supported formats

The extension sniffs the file and picks the right parser automatically.

| Source | What it is | Notes |
|---|---|---|
| **Claude Code** | `~/.claude/projects/<project>/<id>.jsonl` | Full fidelity: thinking, tool calls, results, images, model, branch, tokens |
| **ChatGPT export** | `conversations.json` from a ChatGPT data export | Walks the message tree to the active branch; one file holds many chats |
| **Claude.ai export** | `conversations.json` from a Claude data export | Text, thinking, tool use/results, attachments |
| **OpenAI API log** | `{ "messages": [...] }` (Chat Completions) or a bare array | `tool_calls`, `function_call`, `role: "tool"`, multimodal content |
| **Anthropic API log** | `{ "messages": [...] }` with content blocks | `tool_use`, `tool_result`, `thinking`, `image` |
| **Fine-tune JSONL** | one `{ "messages": [...] }` per line | each line is a separate conversation |

Files that hold more than one conversation (the exports) get a dropdown to switch between them.

## Features

- **Conversation layout.** Each turn becomes a colour-accented card: prompts, replies (rendered as Markdown), thinking, tool calls, and results. The assistant is labelled per source (Claude / ChatGPT / Assistant).
- **Tool-aware rendering.** `Bash` shows the command as a shell block, `Edit` shows a red/green diff, `Read`/`Write`/`Glob`/`Grep` show the file path and arguments, `TodoWrite` shows the checklist, MCP and function tools show tidy key/value input. Everything else falls back to formatted JSON.
- **Inline images.** Screenshots and pasted images render directly in the transcript.
- **Session header.** Title, source format, working directory, git branch, model, duration, message counts and approximate token usage at a glance.
- **Filter and search.** Toggle thinking, tool calls, results, images, and system noise. Live full-text search with a match count.
- **Collapsible detail.** Long output, reasoning, and large tool inputs collapse by default. Expand all / collapse all in one click.
- **Clickable paths and links.** File paths open in the editor; links open in your browser.
- **Live updating.** Open the log of a session that is still running and the view refreshes as the file grows.
- **Theme-aware.** Uses your current VS Code colour theme.

## Usage

Open any supported `.json` or `.jsonl` file in one of these ways:

- Right-click the file in the Explorer and choose **Chat Viewer: Open as Readable Transcript**.
- With the file open, run the same command from the Command Palette, or click the icon in the editor title bar.
- Right-click the editor tab and choose **Reopen Editor With...** then **Chat Transcript**.

To get back to the raw JSON, use **Chat Viewer: Reopen as Raw JSON**, or **Reopen Editor With... > Text Editor**.

The custom editor is registered at `option` priority, so it never hijacks `.json`/`.jsonl` files you open for other reasons. You always choose when to use it.

## Install

### From a release (easiest)

1. Download the latest `json-chat-viewer-<version>.vsix` from the [Releases page](https://github.com/hello-emrah/json-chat-viewer/releases).
2. In VS Code: open the Extensions view, click the `…` menu (top-right), choose **Install from VSIX…**, and pick the file.
3. Reload the window if prompted.

If the `code` CLI is on your PATH, this is the one-liner equivalent:

```bash
code --install-extension json-chat-viewer-0.2.0.vsix
```

(Not on your PATH? In VS Code run **Shell Command: Install 'code' command in PATH** from the Command Palette first, or just use the Install from VSIX menu above.)

### Build from source

```bash
git clone https://github.com/hello-emrah/json-chat-viewer.git
cd json-chat-viewer
npm install
npx @vscode/vsce package          # produces json-chat-viewer-<version>.vsix
```

Then install the generated `.vsix` as above. While developing, press `F5` in VS Code to run it in an Extension Development Host instead.

## How it works

The architecture is a strict split between **parsing** and **rendering**, which is what makes it format-agnostic:

```
src/types.ts        The shared, platform-neutral Transcript model
src/parsers/        One module per format: detect() + parse() -> Transcript[]
  index.ts          Registry: sniffs the file, runs detectors, returns a bundle
  claudeCode.ts     Claude Code .jsonl
  chatgptExport.ts  ChatGPT conversations.json (tree walk)
  claudeExport.ts   Claude.ai conversations.json
  openaiApi.ts      OpenAI / Anthropic API logs + fine-tune JSONL
src/extension.ts    Custom editor, commands, live reload, link handling
media/main.js       Webview renderer + self-contained Markdown engine
media/style.css     Theme-aware styling
```

Every parser maps its source onto the same `Transcript` model, so the renderer never needs to know which platform a log came from. Adding a new platform is one new parser module plus one line in the registry.

All message content is HTML-escaped before rendering, and only `http(s)` / `mailto` links are ever followed, so opening an untrusted log is safe.

## Licence

MIT
