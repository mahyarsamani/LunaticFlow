import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { CommentStore } from './commentStore';

export const REVIEW_VIEW_TYPE = 'mdReview.preview';

/** Messages the webview (media/preview.js) sends to the extension. */
type WebviewMessage =
    | { type: 'ready' | 'copy' | 'copyAll' | 'export' | 'clear' }
    | { type: 'add'; line: number; text: string; quote?: string }
    | { type: 'edit'; id: string; text: string }
    | { type: 'delete'; id: string }
    | { type: 'reveal'; line: number }
    | { type: 'link'; href: string };

/**
 * A webview showing a Markdown file rendered by VS Code's built-in engine, where each block
 * can be commented on. The engine tags blocks with data-line="<0-based source line>".
 */
export class ReviewPreview {
    private readonly disposables: vscode.Disposable[] = [];
    private renderTimer: NodeJS.Timeout | undefined;
    private readonly mdMedia: vscode.Uri | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly store: CommentStore,
        readonly panel: vscode.WebviewPanel,
        readonly uri: vscode.Uri,
        onDispose: () => void,
    ) {
        const mdExt = vscode.extensions.getExtension('vscode.markdown-language-features');
        this.mdMedia = mdExt ? vscode.Uri.joinPath(mdExt.extensionUri, 'media') : undefined;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                ...(this.mdMedia ? [this.mdMedia] : []),
                ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri),
                vscode.Uri.joinPath(uri, '..'),
            ],
        };
        panel.iconPath = new vscode.ThemeIcon('comment-discussion');
        panel.webview.html = this.shell();

        this.disposables.push(
            panel.onDidDispose(() => {
                this.dispose();
                onDispose();
            }),
            panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === this.uri.toString()) { this.scheduleRender(); }
            }),
            store.onDidChange(u => {
                if (!u || u.toString() === this.uri.toString()) { this.postComments(); }
            }),
        );
    }

    dispose(): void {
        clearTimeout(this.renderTimer);
        this.disposables.forEach(d => d.dispose());
    }

    private scheduleRender(): void {
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => this.render(), 250);
    }

    private async render(): Promise<void> {
        let text: string;
        try {
            text = (await vscode.workspace.openTextDocument(this.uri)).getText();
        } catch {
            text = '*This file could not be opened.*';
        }
        this.panel.title = `Review: ${path.basename(this.uri.fsPath)}`;
        let html: unknown;
        try {
            html = await vscode.commands.executeCommand('markdown.api.render', text);
        } catch {
            html = undefined;
        }
        if (typeof html !== 'string') {
            html = '<p><b>Could not render Markdown.</b> The built-in "Markdown Language Features" extension must be enabled.</p>';
        }
        this.panel.webview.postMessage({
            type: 'render',
            html: this.rewriteResources(html as string),
            file: vscode.workspace.asRelativePath(this.uri),
            comments: this.store.get(this.uri),
        });
    }

    private postComments(): void {
        this.panel.webview.postMessage({ type: 'comments', comments: this.store.get(this.uri) });
    }

    /** Point relative image paths at the file on disk via webview URIs. */
    private rewriteResources(html: string): string {
        const dir = vscode.Uri.joinPath(this.uri, '..');
        return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (m, pre: string, src: string, post: string) => {
            if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(src)) { return m; }
            let decoded: string;
            try {
                decoded = decodeURIComponent(src.replace(/&amp;/g, '&'));
            } catch {
                return m;
            }
            const root = vscode.workspace.getWorkspaceFolder(this.uri)?.uri ?? dir;
            const target = decoded.startsWith('/') ? vscode.Uri.joinPath(root, decoded) : vscode.Uri.joinPath(dir, decoded);
            return pre + this.panel.webview.asWebviewUri(target).toString() + post;
        });
    }

    private async onMessage(m: WebviewMessage): Promise<unknown> {
        switch (m.type) {
            case 'ready':
                return this.render();
            case 'add':
                return this.store.add(this.uri, { line: m.line, text: m.text, quote: m.quote || undefined });
            case 'edit':
                return this.store.update(this.uri, m.id, m.text);
            case 'delete':
                return this.store.remove(this.uri, m.id);
            case 'reveal':
                return revealLine(this.uri, m.line);
            case 'copy':
                return vscode.commands.executeCommand('mdReview.copyComments', this.uri);
            case 'copyAll':
                return vscode.commands.executeCommand('mdReview.copyAllComments');
            case 'export':
                return vscode.commands.executeCommand('mdReview.exportComments');
            case 'clear':
                return vscode.commands.executeCommand('mdReview.clearComments', this.uri);
            case 'link':
                return openLink(this.uri, m.href);
        }
    }

    private shell(): string {
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(16).toString('base64');
        const media = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', p));
        const builtinCss = this.mdMedia
            ? ['markdown.css', 'highlight.css']
                .map(f => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(this.mdMedia!, f))}">`)
                .join('\n')
            : '';
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${builtinCss}
<link rel="stylesheet" href="${media('preview.css')}">
</head>
<body class="vscode-body">
<div id="mdr-toolbar" class="mdr-ui"></div>
<div id="mdr-content" class="markdown-body"></div>
<script nonce="${nonce}">window.MDR_URI = ${JSON.stringify(this.uri.toString())};</script>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body>
</html>`;
    }
}

export async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const existing = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
    const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: existing ? existing.viewColumn : vscode.ViewColumn.One,
        preserveFocus: false,
    });
    const pos = new vscode.Position(Math.max(0, Math.min(line - 1, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function openLink(fromUri: vscode.Uri, href: string): Promise<unknown> {
    if (!href || href.startsWith('#')) { return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        return vscode.env.openExternal(vscode.Uri.parse(href));
    }
    const [file] = href.split('#');
    let decoded = file;
    try { decoded = decodeURIComponent(file); } catch { /* keep as written */ }
    return vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(fromUri, '..', decoded));
}
