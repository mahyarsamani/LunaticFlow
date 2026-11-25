// A small stand-in for the `vscode` module, enough to run the Flow code end to end in plain Node.
// It records what the extension asks VS Code to do so tests can check it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from 'path';
import { URL } from 'url';

export const calls = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    executed: [] as { command: string; args: any[] }[],
    openedExternal: [] as string[],
    commentThreads: [] as any[],
    trees: [] as any[],
};
export const answers = { info: undefined as string | undefined, warn: undefined as string | undefined, input: '' as string | undefined };
const commandMap = new Map<string, (...a: any[]) => any>();
const contentProviders = new Map<string, any>();
const codeLensProviders: any[] = [];
const config: Record<string, any> = {};

export class EventEmitter<T> {
    private ls: ((e: T) => any)[] = [];
    event = (l: (e: T) => any) => { this.ls.push(l); return { dispose: () => { this.ls = this.ls.filter(x => x !== l); } }; };
    fire(e?: T) { for (const l of [...this.ls]) { l(e as T); } }
    dispose() { this.ls = []; }
}
export class Disposable {
    constructor(private fn: () => void = () => {}) {}
    static from(...ds: { dispose(): any }[]) { return new Disposable(() => ds.forEach(d => d.dispose())); }
    dispose() { this.fn(); }
}
export class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query: string, readonly fragment = '') {}
    static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }) {
        return new Uri(c.scheme, c.authority ?? '', c.path ?? '', c.query ?? '', c.fragment ?? '');
    }
    static file(p: string) { return new Uri('file', '', p, ''); }
    static parse(s: string) {
        const u = new URL(s);
        return new Uri(u.protocol.replace(':', ''), u.host, decodeURIComponent(u.pathname), u.search.replace(/^\?/, ''));
    }
    static joinPath(u: Uri, ...p: string[]) { return new Uri(u.scheme, u.authority, path.join(u.path, ...p), u.query); }
    get fsPath() { return this.path; }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}`; }
}
export class Position { constructor(readonly line: number, readonly character: number) {} }
export class Range {
    readonly start: Position; readonly end: Position;
    constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
        if (typeof a === 'number') { this.start = new Position(a, b as number); this.end = new Position(c!, d!); }
        else { this.start = a; this.end = b as Position; }
    }
}
export class Selection extends Range { get active() { return this.start; } }
export class CodeLens { constructor(readonly range: Range, readonly command?: any) {} }
export class ThemeIcon { static File = new ThemeIcon('file'); constructor(readonly id: string, readonly color?: any) {} }
export class ThemeColor { constructor(readonly id: string) {} }
export class MarkdownString {
    value = '';
    constructor(v = '') { this.value = v; }
    appendMarkdown(s: string) { this.value += s; return this; }
}
export class TreeItem {
    description?: string; iconPath?: any; contextValue?: string; tooltip?: any; command?: any; resourceUri?: any;
    constructor(readonly label: string, readonly collapsibleState?: number) {}
}
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
export enum CommentMode { Editing = 0, Preview = 1 }
export enum CommentThreadCollapsibleState { Collapsed = 0, Expanded = 1 }
export enum CommentThreadState { Unresolved = 0, Resolved = 1 }
export enum ConfigurationTarget { Global = 1, Workspace = 2 }
export enum TextEditorRevealType { Default = 0, InCenter = 1 }

export const workspace = {
    workspaceFolders: [] as { uri: Uri }[],
    textDocuments: [] as any[],
    getConfiguration: (section: string) => ({
        get: (k: string, d?: any) => (`${section}.${k}` in config ? config[`${section}.${k}`] : d),
        update: async (k: string, v: any) => { config[`${section}.${k}`] = v; },
        inspect: (k: string) => ({ key: `${section}.${k}`, globalValue: config[`${section}.${k}`] }),
    }),
    registerTextDocumentContentProvider: (scheme: string, p: any) => { contentProviders.set(scheme, p); return new Disposable(); },
    onDidOpenTextDocument: new EventEmitter<any>().event,
    onDidChangeWorkspaceFolders: new EventEmitter<any>().event,
    onDidChangeConfiguration: new EventEmitter<any>().event,
    asRelativePath: (p: string) => p,
};
export const window = {
    activeTextEditor: undefined as any,
    visibleTextEditors: [] as any[],
    onDidChangeVisibleTextEditors: new EventEmitter<any>().event,
    createTreeView: (id: string, o: any) => { const v = { id, ...o, badge: undefined, dispose() {} }; calls.trees.push(v); return v; },
    createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    showInformationMessage: async (m: string) => { calls.info.push(m); return answers.info; },
    showWarningMessage: async (m: string) => { calls.warn.push(m); return answers.warn; },
    showErrorMessage: async (m: string) => { calls.error.push(m); return undefined; },
    showInputBox: async () => answers.input,
    showQuickPick: async (items: any[]) => items[0],
    showTextDocument: async () => undefined,
};
export const languages = {
    registerCodeLensProvider: (_sel: any, p: any) => { codeLensProviders.push(p); return new Disposable(); },
};
export const comments = {
    createCommentController: (id: string, label: string) => ({
        id, label, options: undefined as any, commentingRangeProvider: undefined as any,
        createCommentThread: (uri: Uri, range: Range, cs: any[]) => {
            const t = { uri, range, comments: cs, contextValue: '', label: undefined, canReply: true, state: 0, collapsibleState: 0,
                disposed: false, dispose() { this.disposed = true; } };
            calls.commentThreads.push(t);
            return t;
        },
        dispose() {},
    }),
};
export const commands = {
    registerCommand: (id: string, fn: (...a: any[]) => any) => { commandMap.set(id, fn); return new Disposable(() => commandMap.delete(id)); },
    executeCommand: async (id: string, ...args: any[]) => {
        calls.executed.push({ command: id, args });
        const fn = commandMap.get(id);
        return fn ? fn(...args) : undefined;
    },
};
export const env = {
    uriScheme: 'vscode',
    clipboard: { writeText: async (_t: string) => {} },
    openExternal: async (u: Uri) => { calls.openedExternal.push(u.toString()); return true; },
};

// Test helpers.
export const mock = {
    command: (id: string) => commandMap.get(id),
    content: (uri: Uri) => contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri),
    codeLenses: (doc: any) => Promise.all(codeLensProviders.map(p => p.provideCodeLenses(doc))).then(x => x.flat()),
    setConfig: (k: string, v: any) => { config[k] = v; },
};
