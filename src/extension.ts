import * as vscode from "vscode";
import { parseAny } from "./parsers";
import { TranscriptBundle } from "./types";

const VIEW_TYPE = "jsonChatViewer.transcript";

// Persisted, file-independent view preferences (which event kinds to show).
// Stored in globalState so the choice carries across every transcript and
// across window reloads.
const PREFS_KEY = "jsonChatViewer.prefs";
interface ViewPrefs {
  filters: { thinking: boolean; tools: boolean; results: boolean; system: boolean; images: boolean };
}
const DEFAULT_PREFS: ViewPrefs = {
  filters: { thinking: true, tools: true, results: true, system: true, images: true },
};
function loadPrefs(context: vscode.ExtensionContext): ViewPrefs {
  const saved = context.globalState.get<Partial<ViewPrefs>>(PREFS_KEY);
  return { filters: { ...DEFAULT_PREFS.filters, ...(saved?.filters || {}) } };
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new TranscriptEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jsonChatViewer.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage("Open a chat log (.json / .jsonl) first, or run this from the file explorer.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jsonChatViewer.openText", async (uri?: vscode.Uri) => {
      const target = uri ?? provider.activeUri;
      if (!target) return;
      await vscode.commands.executeCommand("vscode.openWith", target, "default");
    })
  );
}

export function deactivate() {}

class TranscriptEditorProvider implements vscode.CustomTextEditorProvider {
  public activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.activeUri = document.uri;
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.getHtml(webview);

    // Parsed bundle is held here in the host and sliced on demand. Only a light
    // index (per-conversation meta, no events) is sent up front; a conversation's
    // events are shipped when the webview asks for them. This keeps the payload
    // small even for 50MB+ exports that hold hundreds of conversations.
    let bundle: TranscriptBundle | undefined;

    const sendIndex = () => {
      try {
        bundle = parseAny(document.getText(), document.uri.fsPath);
        webview.postMessage({
          type: "index",
          fileName: baseName(document.uri),
          format: bundle.format,
          formatLabel: bundle.formatLabel,
          conversations: bundle.conversations.map((c) => ({ meta: c.meta, eventCount: c.events.length })),
        });
      } catch (err) {
        bundle = undefined;
        webview.postMessage({ type: "error", message: String(err) });
      }
    };

    let timer: NodeJS.Timeout | undefined;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sendIndex, 200);
    });

    const focusSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.activeUri = document.uri;
    });

    const msgSub = webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        webview.postMessage({ type: "prefs", data: loadPrefs(this.context) });
        sendIndex();
      } else if (msg?.type === "requestConversation" && typeof msg.index === "number") {
        const convo = bundle?.conversations[msg.index];
        if (convo) webview.postMessage({ type: "conversation", index: msg.index, events: convo.events });
      } else if (msg?.type === "savePrefs" && msg.prefs) {
        await this.context.globalState.update(PREFS_KEY, msg.prefs as ViewPrefs);
      } else if (msg?.type === "openExternal" && typeof msg.url === "string") {
        if (/^(https?:\/\/|mailto:)/i.test(msg.url)) vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg?.type === "openFile" && typeof msg.path === "string") {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          vscode.window.showWarningMessage(`Could not open: ${msg.path}`);
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      focusSub.dispose();
      msgSub.dispose();
      if (timer) clearTimeout(timer);
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Chat Transcript</title>
</head>
<body>
  <div id="app"><div id="loading" class="loading">Parsing…</div></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function baseName(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf("/") + 1);
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
