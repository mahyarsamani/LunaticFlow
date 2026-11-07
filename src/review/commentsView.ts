import * as vscode from 'vscode';
import * as path from 'path';
import { CommentStore, ReviewComment } from './commentStore';

export type ReviewNode =
    | { kind: 'file'; uri: vscode.Uri; count: number }
    | { kind: 'comment'; uri: vscode.Uri; comment: ReviewComment };

/** Sidebar tree: commented files, each with its comments in line order. */
export class CommentsViewProvider implements vscode.TreeDataProvider<ReviewNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly store: CommentStore) {
        store.onDidChange(() => this.emitter.fire());
    }

    getChildren(element?: ReviewNode): ReviewNode[] {
        if (!element) {
            return this.store.files()
                .map(f => ({ kind: 'file' as const, uri: f.uri, count: f.comments.length }))
                .sort((a, b) => vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri)));
        }
        if (element.kind === 'file') {
            return [...this.store.get(element.uri)]
                .sort((a, b) => a.line - b.line || a.created - b.created)
                .map(comment => ({ kind: 'comment' as const, uri: element.uri, comment }));
        }
        return [];
    }

    getTreeItem(node: ReviewNode): vscode.TreeItem {
        if (node.kind === 'file') {
            const item = new vscode.TreeItem(path.basename(node.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
            item.id = `review:${node.uri.toString()}`;
            item.resourceUri = node.uri;
            const rel = vscode.workspace.asRelativePath(node.uri);
            const dir = path.dirname(rel);
            item.description = `${node.count} · ${dir === '.' ? '' : dir}`.replace(/ · $/, '');
            item.tooltip = rel;
            item.contextValue = 'reviewFile';
            return item;
        }
        const c = node.comment;
        const item = new vscode.TreeItem(c.text.replace(/\s+/g, ' ').trim(), vscode.TreeItemCollapsibleState.None);
        item.id = `review:${node.uri.toString()}:${c.id}`;
        item.description = `L${c.line}`;
        item.iconPath = new vscode.ThemeIcon('comment');
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**@${vscode.workspace.asRelativePath(node.uri)}#${c.line}**\n\n`);
        if (c.quote) { tip.appendMarkdown(`> ${c.quote.replace(/\n/g, ' ')}\n\n`); }
        tip.appendText(c.text);
        item.tooltip = tip;
        item.contextValue = 'reviewComment';
        item.command = { command: 'mdReview.revealComment', title: 'Go to Comment', arguments: [node] };
        return item;
    }
}
