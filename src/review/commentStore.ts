import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { renamedPath } from './format';

export interface ReviewComment {
    id: string;
    /** 1-based source line. */
    line: number;
    text: string;
    /** Text the user selected in the preview, if the comment was made on a selection. */
    quote?: string;
    created: number;
}

const STATE_KEY = 'mdReview.comments';

/** Review comments keyed by document URI string, kept in workspace state. */
export class CommentStore {
    private data: Record<string, ReviewComment[]>;
    private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
    /** Fires with the changed document, or undefined when many changed at once. */
    readonly onDidChange = this.emitter.event;

    constructor(private readonly memento: vscode.Memento) {
        this.data = memento.get<Record<string, ReviewComment[]>>(STATE_KEY) ?? {};
    }

    get(uri: vscode.Uri): ReviewComment[] {
        return this.data[uri.toString()] ?? [];
    }

    count(uri: vscode.Uri): number {
        return this.get(uri).length;
    }

    files(): { uri: vscode.Uri; comments: ReviewComment[] }[] {
        return Object.keys(this.data)
            .filter(k => this.data[k].length)
            .map(k => ({ uri: vscode.Uri.parse(k), comments: this.data[k] }));
    }

    total(): number {
        return Object.values(this.data).reduce((n, list) => n + list.length, 0);
    }

    set(uri: vscode.Uri, comments: ReviewComment[]): void {
        const key = uri.toString();
        if (comments.length) { this.data[key] = comments; }
        else { delete this.data[key]; }
        this.persist();
        this.emitter.fire(uri);
    }

    add(uri: vscode.Uri, comment: Omit<ReviewComment, 'id' | 'created'>): void {
        this.set(uri, [...this.get(uri), { id: crypto.randomUUID(), created: Date.now(), ...comment }]);
    }

    update(uri: vscode.Uri, id: string, text: string): void {
        this.set(uri, this.get(uri).map(c => (c.id === id ? { ...c, text } : c)));
    }

    remove(uri: vscode.Uri, id: string): void {
        this.set(uri, this.get(uri).filter(c => c.id !== id));
    }

    clearAll(): void {
        this.data = {};
        this.persist();
        this.emitter.fire(undefined);
    }

    /** Keep comments attached to files (or files inside folders) that were renamed or moved. */
    rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        let changed = false;
        for (const key of Object.keys(this.data)) {
            const next = renamedPath(key, oldUri.toString(), newUri.toString());
            if (next && next !== key) {
                this.data[next] = [...(this.data[next] ?? []), ...this.data[key]];
                delete this.data[key];
                changed = true;
            }
        }
        if (changed) {
            this.persist();
            this.emitter.fire(undefined);
        }
    }

    private persist(): void {
        this.memento.update(STATE_KEY, this.data);
    }
}
