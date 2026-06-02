import * as vscode from "vscode";
import { parseTranscript } from "./parser";

const VIEW_TYPE = "claudeSessionViewer.transcript";

export function activate(context: vscode.ExtensionContext) {
  const provider = new TranscriptEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  // Open the active (or a chosen) .jsonl file in the readable transcript editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessionViewer.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage("Open a .jsonl session file first, or run this from the file explorer.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    })
  );

  // Reopen the current transcript as raw JSONL text.
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSessionViewer.openText", async (uri?: vscode.Uri) => {
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

    const post = () => {
      let payload;
      try {
        payload = parseTranscript(document.getText());
      } catch (err) {
        webview.postMessage({ type: "error", message: String(err) });
        return;
      }
      webview.postMessage({ type: "transcript", data: payload, fileName: baseName(document.uri) });
    };

    // Re-render when the underlying file changes (live sessions append to disk).
    let timer: NodeJS.Timeout | undefined;
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(post, 150);
    });

    const focusSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.activeUri = document.uri;
    });

    const msgSub = webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") {
        post();
      } else if (msg?.type === "openExternal" && typeof msg.url === "string") {
        const ok = /^(https?:\/\/|mailto:)/i.test(msg.url);
        if (ok) vscode.env.openExternal(vscode.Uri.parse(msg.url));
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
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
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
  <title>Claude Session</title>
</head>
<body>
  <div id="app">
    <div id="loading" class="loading">Parsing session…</div>
  </div>
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
