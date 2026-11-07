import * as vscode from 'vscode';
import * as path from 'path';
import { CommentStore } from './commentStore';
import { CommentsViewProvider, ReviewNode } from './commentsView';
import { formatComments, shiftLines } from './format';
import { ReviewPreview, REVIEW_VIEW_TYPE, revealLine } from './reviewPreview';

/** What the rest of the extension (tab groups) uses from the review feature. */
export interface ReviewApi {
    store: CommentStore;
    /** Export text for the given files, in the configured format. */
    format(uris: vscode.Uri[]): string;
    copyToClipboard(text: string, scope: string): Promise<void>;
}

export function activateReview(context: vscode.ExtensionContext): ReviewApi {
    const store = new CommentStore(context.workspaceState);
    const previews = new Map<string, ReviewPreview>();
    let lastActive: string | undefined;

    const config = () => vscode.workspace.getConfiguration('mdReview');
    const displayPath = (uri: vscode.Uri) =>
        config().get<boolean>('absolutePaths') ? uri.fsPath : vscode.workspace.asRelativePath(uri);
    const formatFiles = (files: { uri: vscode.Uri; comments: { line: number; text: string; quote?: string }[] }[]) =>
        formatComments(
            files.map(f => ({ path: displayPath(f.uri), comments: f.comments })),
            { separator: config().get<string>('separator'), includeQuote: config().get<boolean>('includeQuote') },
        );

    async function copyToClipboard(text: string, scope: string): Promise<void> {
        if (!text) {
            vscode.window.showInformationMessage(`No review comments ${scope}.`);
            return;
        }
        await vscode.env.clipboard.writeText(text);
        const n = text.split('\n').length;
        vscode.window.showInformationMessage(`Copied ${n} review comment line${n === 1 ? '' : 's'} ${scope}.`);
    }

    function makePreview(panel: vscode.WebviewPanel, uri: vscode.Uri): ReviewPreview {
        const key = uri.toString();
        const preview = new ReviewPreview(context.extensionUri, store, panel, uri, () => {
            previews.delete(key);
            if (lastActive === key) { lastActive = undefined; }
        });
        previews.set(key, preview);
        lastActive = key;
        panel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) { lastActive = key; }
        });
        return preview;
    }

    /** Which document a command applies to: explicit arg, focused review panel, or active editor. */
    function targetUri(arg?: unknown): vscode.Uri | undefined {
        if (arg instanceof vscode.Uri) { return arg; }
        if (arg && typeof arg === 'object') {
            const a = arg as { uri?: unknown; filePath?: unknown };
            if (a.uri instanceof vscode.Uri) { return a.uri; }
            if (typeof a.filePath === 'string') { return vscode.Uri.file(a.filePath); }
        }
        const activePanel = [...previews.values()].find(p => p.panel.active);
        if (activePanel) { return activePanel.uri; }
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'markdown') { return editor.document.uri; }
        return lastActive ? vscode.Uri.parse(lastActive) : undefined;
    }

    // Editor decorations showing which source lines have comments.
    const decoration = vscode.window.createTextEditorDecorationType({
        after: { margin: '0 0 0 1.5em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
        overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    function decorate(editor: vscode.TextEditor): void {
        const byLine = new Map<number, string[]>();
        for (const c of store.get(editor.document.uri)) {
            if (!byLine.has(c.line)) { byLine.set(c.line, []); }
            byLine.get(c.line)!.push(c.text);
        }
        const decos: vscode.DecorationOptions[] = [];
        for (const [line, texts] of byLine) {
            if (line - 1 >= editor.document.lineCount) { continue; }
            const end = editor.document.lineAt(line - 1).range.end;
            decos.push({
                range: new vscode.Range(end, end),
                hoverMessage: new vscode.MarkdownString(texts.map(t => `- ${t.replace(/\n/g, ' ')}`).join('\n')),
                renderOptions: {
                    after: { contentText: `💬 ${texts.length === 1 ? truncate(texts[0], 60) : `${texts.length} comments`}` },
                },
            });
        }
        editor.setDecorations(decoration, decos);
    }
    const decorateAll = () => vscode.window.visibleTextEditors.forEach(decorate);

    const commentsView = vscode.window.createTreeView('reviewCommentsView', {
        treeDataProvider: new CommentsViewProvider(store),
        showCollapseAll: true,
    });
    const updateBadge = () => {
        const total = store.total();
        commentsView.badge = total ? { value: total, tooltip: `${total} review comment${total === 1 ? '' : 's'}` } : undefined;
    };

    context.subscriptions.push(
        decoration,
        commentsView,
        store.onDidChange(() => {
            decorateAll();
            updateBadge();
        }),
        vscode.window.onDidChangeVisibleTextEditors(decorateAll),

        // Keep comments on the same text as lines are inserted or deleted above them.
        vscode.workspace.onDidChangeTextDocument(e => {
            const comments = store.get(e.document.uri);
            if (!comments.length || !e.contentChanges.length) { return; }
            const copy = comments.map(c => ({ ...c }));
            const moved = shiftLines(copy, e.contentChanges.map(ch => ({
                startLine: ch.range.start.line,
                startChar: ch.range.start.character,
                endLine: ch.range.end.line,
                rangeLength: ch.rangeLength,
                text: ch.text,
            })));
            if (moved) { store.set(e.document.uri, copy); }
        }),

        vscode.workspace.onDidRenameFiles(e => {
            for (const f of e.files) { store.rename(f.oldUri, f.newUri); }
        }),

        vscode.commands.registerCommand('mdReview.openPreview', async (arg?: unknown) => {
            const uri = targetUri(arg);
            if (!uri) {
                vscode.window.showWarningMessage('Open a Markdown file first.');
                return;
            }
            const existing = previews.get(uri.toString());
            if (existing) {
                existing.panel.reveal(undefined, false);
                return;
            }
            const panel = vscode.window.createWebviewPanel(
                REVIEW_VIEW_TYPE,
                `Review: ${path.basename(uri.fsPath)}`,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                { enableScripts: true, retainContextWhenHidden: true },
            );
            makePreview(panel, uri);
        }),

        vscode.commands.registerCommand('mdReview.copyComments', async (arg?: unknown) => {
            const uri = targetUri(arg);
            if (!uri) { return; }
            await copyToClipboard(formatFiles([{ uri, comments: store.get(uri) }]), `for ${path.basename(uri.fsPath)}`);
        }),

        vscode.commands.registerCommand('mdReview.copyAllComments', async () => {
            await copyToClipboard(formatFiles(store.files()), 'across all files');
        }),

        vscode.commands.registerCommand('mdReview.exportComments', async () => {
            const text = formatFiles(store.files());
            if (!text) {
                vscode.window.showInformationMessage('No review comments to export.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: text + '\n', language: 'plaintext' });
            await vscode.window.showTextDocument(doc, { preview: false });
        }),

        vscode.commands.registerCommand('mdReview.clearComments', async (arg?: unknown) => {
            const uri = targetUri(arg);
            if (!uri || !store.count(uri)) { return; }
            const ok = await vscode.window.showWarningMessage(
                `Delete all ${store.count(uri)} comment(s) on ${path.basename(uri.fsPath)}?`,
                { modal: true },
                'Delete',
            );
            if (ok === 'Delete') { store.set(uri, []); }
        }),

        vscode.commands.registerCommand('mdReview.clearAllComments', async () => {
            const total = store.total();
            if (!total) { return; }
            const ok = await vscode.window.showWarningMessage(
                `Delete all ${total} review comment(s) in this workspace?`,
                { modal: true },
                'Delete',
            );
            if (ok === 'Delete') { store.clearAll(); }
        }),

        vscode.commands.registerCommand('mdReview.revealComment', (node: ReviewNode) => {
            if (node?.kind === 'comment') { return revealLine(node.uri, node.comment.line); }
        }),

        vscode.commands.registerCommand('mdReview.editComment', async (node: ReviewNode) => {
            if (node?.kind !== 'comment') { return; }
            const text = await vscode.window.showInputBox({
                prompt: `Edit comment on line ${node.comment.line}`,
                value: node.comment.text,
                validateInput: v => (v.trim() ? undefined : 'Comment cannot be empty'),
            });
            if (text !== undefined) { store.update(node.uri, node.comment.id, text.trim()); }
        }),

        vscode.commands.registerCommand('mdReview.deleteComment', (node: ReviewNode) => {
            if (node?.kind === 'comment') { store.remove(node.uri, node.comment.id); }
        }),

        vscode.window.registerWebviewPanelSerializer(REVIEW_VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { uri?: string } | undefined) {
                if (!state?.uri) {
                    panel.dispose();
                    return;
                }
                makePreview(panel, vscode.Uri.parse(state.uri));
            },
        }),
    );

    decorateAll();
    updateBadge();

    return {
        store,
        format: uris => formatFiles(uris.map(uri => ({ uri, comments: store.get(uri) }))),
        copyToClipboard,
    };
}

function truncate(s: string, n: number): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}
