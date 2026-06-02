# Claude Session Viewer

A VS Code extension that turns Claude Code `.jsonl` session logs into a clean, readable transcript.

Claude Code stores every session as a JSON Lines file under `~/.claude/projects/<project>/<session-id>.jsonl`. Opened as raw text these are an unreadable wall of nested JSON. This extension renders them as a proper conversation: prompts, replies, reasoning, tool calls, results and images, all laid out and navigable.

## Features

- **Conversation layout.** Each turn becomes a colour-accented card: your prompts, Claude's replies (rendered as Markdown), thinking, tool calls, and tool results.
- **Tool-aware rendering.** `Bash` shows the command as a shell block, `Edit` shows a red/green diff, `Read`/`Write`/`Glob`/`Grep` show the file path and arguments, `TodoWrite` shows the checklist, MCP tools show tidy key/value input. Everything else falls back to formatted JSON.
- **Inline images.** Screenshots and pasted images render directly in the transcript.
- **Session header.** Title, working directory, git branch, model, version, duration, message counts and approximate token usage at a glance.
- **Filter and search.** Toggle thinking, tool calls, results, images, and system noise on or off. Live full-text search with a match count.
- **Collapsible detail.** Long output, reasoning, and large tool inputs collapse by default. Expand all / collapse all in one click.
- **Clickable paths and links.** File paths open in the editor; links open in your browser.
- **Live updating.** If you open the log of a session that is still running, the view refreshes as the file grows.
- **Theme-aware.** Uses your current VS Code colour theme.

## Usage

Open any `.jsonl` Claude session in one of these ways:

- Right-click the file in the Explorer and choose **Claude Session: Open as Readable Transcript**.
- With the file open, run the same command from the Command Palette, or click the book icon in the editor title bar.
- Right-click the editor tab and choose **Reopen Editor With...** then **Claude Session Transcript**.

To get back to the raw JSON, use **Claude Session: Reopen as Raw JSONL** (the `{}` icon in the title bar), or **Reopen Editor With... > Text Editor**.

The custom editor is registered with `option` priority, so it never hijacks `.jsonl` files you open for other reasons. You always choose when to use it.

## Install

### Run from source (development)

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host with the extension loaded, and open a `.jsonl` session there.

### Package and install locally

```bash
npm install
npx @vscode/vsce package
code --install-extension claude-session-viewer-0.1.0.vsix
```

(`vsce` is only needed for packaging; it is fetched on demand by `npx`.)

## How it works

`src/parser.ts` is a dependency-free parser that reads the JSONL line by line and flattens it into an ordered list of render events, tolerating malformed lines, missing fields, and every record type Claude Code emits (`user`, `assistant`, `system`, `attachment`, `mode`, `ai-title`, `queue-operation`, and more). It also separates genuine human prompts from the synthetic `user` records that carry tool results, so the transcript reads the way the conversation actually happened.

`media/main.js` renders that model in the webview, including a small self-contained Markdown renderer (no runtime dependencies). All message content is HTML-escaped before rendering, and only `http(s)` and `mailto` links are ever followed, so opening an untrusted session log is safe.

## Layout

```
src/extension.ts   Custom editor provider, commands, live reload, link handling
src/parser.ts      JSONL -> transcript model (pure, testable, no vscode import)
media/style.css    Theme-aware styles
media/main.js      Webview renderer + mini Markdown engine
```

## Licence

MIT
