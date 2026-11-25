// Reviewing a sprint round in VS Code's diff editor: approve or reject each hunk,
// comment on lines with native comment threads, move between changes and files, and send
// the review to the agent.
import * as vscode from 'vscode';
import * as path from 'path';
import { FileDiff, Hunk, hunkNewRange, mapLine } from './diff';
import { NavFile, NavFrom, NavMove, hunkAt, isSpot, navigate, positionOf } from './navigate';
import { FlowRepo, FlowStore, git } from './store';
import {
    AgentRecord, HunkDecision, Round, SprintState, Thread, currentRound, readySprints, tally, verdictOf,
} from './model';

export const SCHEME = 'lunaticflow';

export interface RevRef {
    root: string;
    sprint: string;
    round: number;
    rev: string;
    path: string;
    side: 'old' | 'new';
}

export function revUri(r: RevRef): vscode.Uri {
    const q = new URLSearchParams({ root: r.root, sprint: r.sprint, round: String(r.round), rev: r.rev, side: r.side });
    return vscode.Uri.from({ scheme: SCHEME, path: '/' + r.path, query: q.toString() });
}

export function parseRevUri(uri: vscode.Uri): RevRef | undefined {
    if (uri.scheme !== SCHEME) { return undefined; }
    const q = new URLSearchParams(uri.query);
    const side = q.get('side');
    return {
        root: q.get('root') ?? '',
        sprint: q.get('sprint') ?? '',
        round: Number(q.get('round') ?? 0),
        rev: q.get('rev') ?? '',
        path: uri.path.replace(/^\//, ''),
        side: side === 'old' ? 'old' : 'new',
    };
}

/** Where a hunk command came from: a tree item, a CodeLens, or nothing (the cursor). */
export interface HunkArg { root: string; sprint: string; path: string; key: string }

interface Target {
    repo: FlowRepo;
    state: SprintState;
    round: Round;
    files: FileDiff[];
    /** The round still waits for a review, so decisions can change. */
    open: boolean;
}

const NAME_AGENT = 'Claude';

/** The navigation commands and the move each one makes. */
const NAV_COMMANDS: Record<string, NavMove> = {
    'lunaticflow.nextChange': 'next',
    'lunaticflow.previousChange': 'previous',
    'lunaticflow.nextFile': 'nextFile',
    'lunaticflow.previousFile': 'previousFile',
    'lunaticflow.nextUndecided': 'nextUndecided',
};

/** A hunk the reviewer moved to, for the Flow view to select. */
export interface NavigatedTo { repo: FlowRepo; sprint: string; file: FileDiff; hunk: Hunk }

export class ReviewController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly comments: vscode.CommentController;
    private readonly lensEmitter = new vscode.EventEmitter<void>();
    private readonly navEmitter = new vscode.EventEmitter<NavigatedTo>();
    /** Fires when navigation lands on a hunk, so the Flow view can select it. */
    readonly onDidNavigate = this.navEmitter.event;
    /** "Change 3/5 · File 2/7" while a review diff has focus. */
    private readonly position = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    /** Our comment threads, keyed by document URI and thread id. */
    private readonly threads = new Map<string, vscode.CommentThread>();
    private readonly threadIds = new WeakMap<vscode.CommentThread, { root: string; sprint: string; id: string }>();
    private readonly decoApproved = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: 'rgba(63,185,80,0.10)',
        overviewRulerColor: 'rgba(63,185,80,0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        gutterIconSize: 'contain',
    });
    private readonly decoRejected = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: 'rgba(248,81,73,0.12)',
        textDecoration: 'line-through',
        overviewRulerColor: 'rgba(248,81,73,0.9)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    private readonly decoUndecided = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: 'rgba(227,179,65,0.7)',
        overviewRulerColor: 'rgba(227,179,65,0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    constructor(private readonly context: vscode.ExtensionContext, private readonly store: FlowStore) {
        this.comments = vscode.comments.createCommentController('lunaticflow', 'LunaticFlow review');
        this.comments.options = { prompt: 'Comment for the agent', placeHolder: 'What should change here?' };
        this.comments.commentingRangeProvider = {
            provideCommentingRanges: async (doc: vscode.TextDocument) => {
                const ref = parseRevUri(doc.uri);
                if (!ref || ref.side !== 'new') { return []; }
                const t = await this.target(ref.root, ref.sprint);
                if (!t || !t.open || t.round.n !== ref.round) { return []; }
                return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)];
            },
        };

        this.disposables.push(
            this.comments, this.lensEmitter, this.navEmitter, this.position,
            this.decoApproved, this.decoRejected, this.decoUndecided,
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
                provideTextDocumentContent: async (uri: vscode.Uri) => {
                    const ref = parseRevUri(uri);
                    if (!ref || !ref.rev) { return ''; }
                    try { return await git(ref.root, ['show', `${ref.rev}:${ref.path}`]); } catch { return ''; }
                },
            }),
            vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, {
                onDidChangeCodeLenses: this.lensEmitter.event,
                provideCodeLenses: doc => this.codeLenses(doc),
            }),
            vscode.languages.registerHoverProvider({ scheme: SCHEME }, {
                provideHover: (doc, pos) => this.hover(doc, pos),
            }),
            store.onDidChange(() => { this.refreshEditors(); void this.updatePosition(); }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshEditors()),
            vscode.window.onDidChangeActiveTextEditor(() => void this.updatePosition()),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor === vscode.window.activeTextEditor) { void this.updatePosition(); }
            }),
            ...Object.entries(NAV_COMMANDS).map(([id, move]) =>
                vscode.commands.registerCommand(id, (a?: HunkArg) => this.navigate(move, a))),
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.uri.scheme === SCHEME) { void this.syncThreads(); }
            }),

            vscode.commands.registerCommand('lunaticflow.approveHunk', (a?: HunkArg) => this.decide(a, 'approved')),
            vscode.commands.registerCommand('lunaticflow.rejectHunk', (a?: HunkArg) => this.decide(a, 'rejected')),
            vscode.commands.registerCommand('lunaticflow.clearHunk', (a?: HunkArg) => this.decide(a, undefined)),
            vscode.commands.registerCommand('lunaticflow.commentHunk', (a?: HunkArg) => this.commentOnHunk(a)),
            vscode.commands.registerCommand('lunaticflow.approveFile', (a?: { root: string; sprint: string; path: string }) =>
                this.approveFile(a)),
            vscode.commands.registerCommand('lunaticflow.openRound', (a: { root: string; sprint: string; path?: string; key?: string }) =>
                this.open(a.root, a.sprint, a.path, a.key)),
            vscode.commands.registerCommand('lunaticflow.submitReview', (a?: { root: string; sprint: string }) => this.submit(a)),
            vscode.commands.registerCommand('lunaticflow.revealThread', (a: { root: string; sprint: string; id: string }) =>
                this.revealThread(a)),
            vscode.commands.registerCommand('lunaticflow.resolveThreadItem', (a: { root: string; sprint: string; id: string }) =>
                this.setThreadStatus(a.root, a.sprint, a.id, 'resolved')),
            vscode.commands.registerCommand('lunaticflow.reopenThreadItem', (a: { root: string; sprint: string; id: string }) =>
                this.setThreadStatus(a.root, a.sprint, a.id, 'open')),

            vscode.commands.registerCommand('lunaticflow.comment.create', (r: vscode.CommentReply) => this.createComment(r)),
            vscode.commands.registerCommand('lunaticflow.comment.reply', (r: vscode.CommentReply) => this.replyComment(r)),
            vscode.commands.registerCommand('lunaticflow.comment.resolve', (t: vscode.CommentThread) => this.setStatusOf(t, 'resolved')),
            vscode.commands.registerCommand('lunaticflow.comment.reopen', (t: vscode.CommentThread) => this.setStatusOf(t, 'open')),
            vscode.commands.registerCommand('lunaticflow.comment.delete', (t: vscode.CommentThread) => this.deleteDraft(t)),
            vscode.commands.registerCommand('lunaticflow.comment.cancel', (r: vscode.CommentReply) => {
                if (!this.threadIds.has(r.thread)) { r.thread.dispose(); }
            }),
        );
        this.refreshEditors();
    }

    dispose() {
        for (const t of this.threads.values()) { t.dispose(); }
        this.disposables.forEach(d => d.dispose());
    }

    // ── state ────────────────────────────────────────────────────────────────

    async target(root: string, sprint: string): Promise<Target | undefined> {
        const repo = this.store.repo(root);
        if (!repo) { return undefined; }
        const state = repo.state(sprint);
        const round = currentRound(state);
        if (!round) { return undefined; }
        const files = await this.store.roundDiff(repo, round);
        return { repo, state, round, files, open: state.status === 'in_review' && !round.review };
    }

    decisionsOf(round: Round): Record<string, HunkDecision> {
        return round.review?.decisions ?? round.draft ?? {};
    }

    /** Threads to show in a round's view: every thread, its line carried forward to this round's head. */
    async threadsFor(t: Target, filePath: string): Promise<{ thread: Thread; line: number }[]> {
        const out: { thread: Thread; line: number }[] = [];
        for (const th of t.state.threads) {
            if (th.path !== filePath || th.round > t.round.n) { continue; }
            let line = th.line;
            for (let k = th.round + 1; k <= t.round.n; k++) {
                const r = t.state.rounds[k - 1];
                if (!r) { break; }
                const files = await this.store.roundDiff(t.repo, r);
                const f = files.find(x => x.path === filePath || x.oldPath === filePath);
                if (f) { line = mapLine(line, f.hunks); }
            }
            out.push({ thread: th, line });
        }
        return out;
    }

    // ── opening rounds ──────────────────────────────────────────────────────

    async open(root: string, sprint: string, filePath?: string, key?: string): Promise<void> {
        const t = await this.target(root, sprint);
        if (!t) {
            vscode.window.showInformationMessage(`Sprint ${sprint} has nothing to review yet.`);
            return;
        }
        await this.offerCodeLens();
        const decisions = this.decisionsOf(t.round);
        let file = filePath ? t.files.find(f => f.path === filePath) : undefined;
        file ??= t.files.find(f => f.hunks.some(h => !decisions[h.key])) ?? t.files[0];
        if (!file) {
            vscode.window.showInformationMessage(`Round ${t.round.n} of ${sprint} changes no files.`);
            return;
        }
        const hunk = key ? file.hunks.find(h => h.key === key) : undefined;
        const left = revUri({
            root, sprint, round: t.round.n, side: 'old', path: file.oldPath,
            rev: file.status === 'added' ? '' : t.round.base,
        });
        const right = revUri({
            root, sprint, round: t.round.n, side: 'new', path: file.path,
            rev: file.status === 'deleted' ? '' : t.round.head,
        });
        const title = `${path.basename(file.path)} · ${sprint} round ${t.round.n}`;
        const line = hunk ? hunkNewRange(hunk).start - 1 : 0;
        await vscode.commands.executeCommand('vscode.diff', left, right, title, {
            preview: false,
            selection: new vscode.Range(Math.max(line, 0), 0, Math.max(line, 0), 0),
        });
        void this.syncThreads();
    }

    /** CodeLenses in diff editors are off by default in VS Code; ask once to turn them on. */
    private async offerCodeLens(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('diffEditor');
        if (cfg.get<boolean>('codeLens')) { return; }
        const KEY = 'lunaticflow.askedCodeLens';
        if (this.context.globalState.get<boolean>(KEY)) { return; }
        await this.context.globalState.update(KEY, true);
        const pick = await vscode.window.showInformationMessage(
            'Show Approve / Reject / Comment above each change in the diff editor? This turns on VS Code\'s "diffEditor.codeLens" setting.',
            'Turn On', 'Not Now',
        );
        if (pick === 'Turn On') { await cfg.update('codeLens', true, vscode.ConfigurationTarget.Global); }
    }

    // ── decisions ───────────────────────────────────────────────────────────

    /** The hunk a command applies to: its argument, or the one under the cursor in a review diff. */
    private async resolveHunk(a?: HunkArg): Promise<{ t: Target; file: FileDiff; hunk: Hunk } | undefined> {
        let root = a?.root, sprint = a?.sprint, filePath = a?.path, key = a?.key, cursorLine: number | undefined;
        if (!root) {
            const ed = vscode.window.activeTextEditor;
            const ref = ed && parseRevUri(ed.document.uri);
            if (!ed || !ref) {
                vscode.window.showWarningMessage('Put the cursor on a change in a LunaticFlow review diff.');
                return undefined;
            }
            root = ref.root; sprint = ref.sprint; filePath = ref.path;
            cursorLine = ed.selection.active.line + 1;
        }
        const t = await this.target(root, sprint!);
        if (!t) { return undefined; }
        const file = t.files.find(f => f.path === filePath);
        if (!file) { return undefined; }
        let hunk = key ? file.hunks.find(h => h.key === key) : undefined;
        if (!hunk && cursorLine !== undefined) {
            let best: Hunk | undefined;
            let dist = Infinity;
            for (const h of file.hunks) {
                const r = hunkNewRange(h);
                const d = cursorLine < r.start ? r.start - cursorLine : cursorLine > r.end ? cursorLine - r.end : 0;
                if (d < dist) { dist = d; best = h; }
            }
            hunk = best;
        }
        if (!hunk) { return undefined; }
        return { t, file, hunk };
    }

    private ensureOpen(t: Target): boolean {
        if (t.open) { return true; }
        const why = t.round.review ? `round ${t.round.n} was already reviewed` : `the sprint is ${t.state.status}`;
        vscode.window.showInformationMessage(`Can't change this review: ${why}.`);
        return false;
    }

    private async decide(a: HunkArg | undefined, decision: 'approved' | 'rejected' | undefined): Promise<void> {
        const r = await this.resolveHunk(a);
        if (!r || !this.ensureOpen(r.t)) { return; }
        let reason: string | undefined;
        if (decision === 'rejected') {
            reason = await vscode.window.showInputBox({
                prompt: `Reject this change in ${path.basename(r.file.path)}`,
                placeHolder: 'Why? (optional; the agent sees it)',
            });
            if (reason === undefined) { return; }
        }
        r.t.repo.updateState(r.t.state.id, s => {
            const round = s.rounds[s.rounds.length - 1];
            round.draft ??= {};
            if (decision) {
                round.draft[r.hunk.key] = { path: r.file.path, decision, ...(reason ? { reason } : {}) };
            } else {
                delete round.draft[r.hunk.key];
            }
        });
        this.store.refresh();
    }

    private async approveFile(a?: { root: string; sprint: string; path: string }): Promise<void> {
        let root = a?.root, sprint = a?.sprint, filePath = a?.path;
        if (!root) {
            const ref = vscode.window.activeTextEditor && parseRevUri(vscode.window.activeTextEditor.document.uri);
            if (!ref) { return; }
            root = ref.root; sprint = ref.sprint; filePath = ref.path;
        }
        const t = await this.target(root, sprint!);
        if (!t || !this.ensureOpen(t)) { return; }
        const file = t.files.find(f => f.path === filePath);
        if (!file) { return; }
        t.repo.updateState(t.state.id, s => {
            const round = s.rounds[s.rounds.length - 1];
            round.draft ??= {};
            for (const h of file.hunks) {
                if (round.draft[h.key]?.decision !== 'rejected') {
                    round.draft[h.key] = { path: file.path, decision: 'approved' };
                }
            }
        });
        this.store.refresh();
        // Move on to the next file that still needs a look.
        const next = await this.target(root, sprint!);
        if (next) {
            const d = this.decisionsOf(next.round);
            const pending = next.files.find(f => f.hunks.some(h => !d[h.key]));
            if (pending) { await this.open(root, sprint!, pending.path); }
            else {
                const go = await vscode.window.showInformationMessage(
                    `Every change in ${sprint} has a decision.`, 'Send Review');
                if (go) { await this.submit({ root, sprint: sprint! }); }
            }
        }
    }

    // ── navigation ──────────────────────────────────────────────────────────

    private navFiles(t: Target): NavFile[] {
        return t.files.map(f => ({ path: f.path, hunks: f.hunks.map(h => ({ key: h.key, ...hunkNewRange(h) })) }));
    }

    /** The round's file a review document shows; the old side names the file by its old path. */
    private fileIndex(t: Target, ref: RevRef): number {
        return t.files.findIndex(f => (ref.side === 'old' ? f.oldPath : f.path) === ref.path);
    }

    /** The cursor's line on the new side (1-based); a cursor on the old side is carried across the hunks. */
    private cursorLine(ed: vscode.TextEditor, ref: RevRef, file: FileDiff): number {
        const line = ed.selection.active.line + 1;
        return ref.side === 'new' ? line : mapLine(line, file.hunks);
    }

    /** Where a move starts: the hunk an argument names (a lens or hover link), else the cursor in the review diff. */
    private async navOrigin(a?: HunkArg): Promise<{ t: Target; files: NavFile[]; from?: NavFrom } | undefined> {
        if (a?.root) {
            const t = await this.target(a.root, a.sprint);
            if (!t) { return undefined; }
            const files = this.navFiles(t);
            const file = files.findIndex(f => f.path === a.path);
            const h = file >= 0 ? files[file].hunks.find(x => x.key === a.key) : undefined;
            return { t, files, from: h ? { file, line: h.start } : undefined };
        }
        const ed = vscode.window.activeTextEditor;
        const ref = ed && parseRevUri(ed.document.uri);
        if (!ed || !ref) { return undefined; }
        const t = await this.target(ref.root, ref.sprint);
        if (!t) { return undefined; }
        const files = this.navFiles(t);
        // A diff of an earlier round: its lines mean nothing in this round, so start from the top.
        const file = t.round.n === ref.round ? this.fileIndex(t, ref) : -1;
        return { t, files, from: file >= 0 ? { file, line: this.cursorLine(ed, ref, t.files[file]) } : undefined };
    }

    private async navigate(move: NavMove, a?: HunkArg): Promise<void> {
        const o = await this.navOrigin(a);
        if (!o) {
            vscode.window.showWarningMessage('Open a LunaticFlow review diff first.');
            return;
        }
        const { t, files } = o;
        const decided = (k: string) => !!this.decisionsOf(t.round)[k];
        const r = navigate(files, o.from, move, decided);
        if (isSpot(r)) {
            await this.goTo(t, r.file, r.hunk);
            return;
        }
        const sprint = t.state.id;
        if (r.edge === 'start') {
            vscode.window.showInformationMessage(move === 'previousFile' ? 'This is the first changed file.' : 'This is the first change.');
            return;
        }
        if (!t.open) {
            vscode.window.showInformationMessage(r.edge === 'none'
                ? `Round ${t.round.n} of ${sprint} is already reviewed.`
                : `That was the last ${move === 'nextFile' ? 'file' : 'change'}.`);
            return;
        }
        // Past the end, or nothing left: point at what still needs a decision, or offer to send.
        const left = navigate(files, undefined, 'nextUndecided', decided);
        if (isSpot(left)) {
            const n = files.reduce((k, f) => k + f.hunks.filter(h => !decided(h.key)).length, 0);
            const pick = await vscode.window.showInformationMessage(
                `That was the last ${move === 'nextFile' ? 'file' : 'change'}; ${n} change${n === 1 ? ' has' : 's have'} no decision yet.`,
                'Go to First Undecided');
            if (pick) { await this.goTo(t, left.file, left.hunk); }
            return;
        }
        const pick = await vscode.window.showInformationMessage(`Every change in ${sprint} has a decision.`, 'Send Review');
        if (pick) { await this.submit({ root: t.repo.root, sprint }); }
    }

    /** Put the cursor on a hunk's first line, centred, opening its file's diff if another one is showing. */
    private async goTo(t: Target, fileIndex: number, hunkIndex: number): Promise<void> {
        const file = t.files[fileIndex];
        const hunk = file.hunks[hunkIndex];
        const line = Math.max(hunkNewRange(hunk).start - 1, 0);
        const pos = new vscode.Position(line, 0);
        const ed = vscode.window.activeTextEditor;
        const ref = ed && parseRevUri(ed.document.uri);
        const showing = ref && ref.side === 'new' && ref.root === t.repo.root && ref.sprint === t.state.id
            && ref.round === t.round.n && ref.path === file.path;
        if (ed && showing) {
            ed.selection = new vscode.Selection(pos, pos);
        } else {
            await this.open(t.repo.root, t.state.id, file.path, hunk.key);
        }
        vscode.window.activeTextEditor?.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        this.navEmitter.fire({ repo: t.repo, sprint: t.state.id, file, hunk });
        void this.updatePosition();
    }

    /** Keep the status bar's "Change 3/5 · File 2/7" in step with the cursor. */
    private positionSeq = 0;
    private async updatePosition(): Promise<void> {
        const seq = ++this.positionSeq;
        const ed = vscode.window.activeTextEditor;
        const ref = ed && parseRevUri(ed.document.uri);
        const t = ref ? await this.target(ref.root, ref.sprint) : undefined;
        if (seq !== this.positionSeq) { return; }  // the cursor moved again meanwhile
        const file = t && ref && t.round.n === ref.round ? this.fileIndex(t, ref) : -1;
        if (!ed || !ref || !t || file < 0) { this.position.hide(); return; }
        const decided = (k: string) => !!this.decisionsOf(t.round)[k];
        const p = positionOf(this.navFiles(t), { file, line: this.cursorLine(ed, ref, t.files[file]) }, decided);
        if (!p) { this.position.hide(); return; }
        this.position.text = `$(diff) Change ${p.change}/${p.changes} · File ${p.file}/${p.files}`;
        if (t.open && p.undecidedInRound) {
            this.position.tooltip = `${p.undecidedInRound} change${p.undecidedInRound === 1 ? '' : 's'} in ${ref.sprint} without a decision. Click for the next one.`;
            this.position.command = 'lunaticflow.nextUndecided';
        } else {
            this.position.tooltip = t.open ? `Every change in ${ref.sprint} has a decision.` : `Round ${t.round.n} of ${ref.sprint}, reviewed.`;
            this.position.command = 'lunaticflow.nextChange';
        }
        this.position.show();
    }

    /** The bubble over a change: where it is in the sprint, links to move on, and the decisions. */
    private async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
        const ref = parseRevUri(doc.uri);
        if (!ref || ref.side !== 'new') { return undefined; }
        const t = await this.target(ref.root, ref.sprint);
        if (!t || t.round.n !== ref.round) { return undefined; }
        const files = this.navFiles(t);
        const fi = this.fileIndex(t, ref);
        const line = pos.line + 1;
        const hi = fi < 0 ? -1 : files[fi].hunks.findIndex(h => line >= h.start && line <= h.end);
        if (hi < 0) { return undefined; }
        const decisions = this.decisionsOf(t.round);
        const p = positionOf(files, { file: fi, line }, k => !!decisions[k])!;
        const file = t.files[fi];
        const hunk = file.hunks[hi];
        const arg: HunkArg = { root: ref.root, sprint: ref.sprint, path: file.path, key: hunk.key };
        const link = (label: string, command: string, tip: string) =>
            `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([arg]))} "${tip}")`;
        const d = decisions[hunk.key];
        const state = d?.decision === 'approved' ? '$(pass-filled) approved'
            : d?.decision === 'rejected' ? '$(error) rejected' : '$(circle-large-outline) undecided';
        const left = !t.open ? `round ${t.round.n} is reviewed`
            : p.undecidedInRound ? `${p.undecidedInFile} undecided in this file, ${p.undecidedInRound} in the sprint`
            : 'every change has a decision';
        const next = t.files[fi + 1];
        const rows = [
            `**Change ${p.change} of ${p.changes}** · File ${p.file} of ${p.files} · \`${path.basename(file.path)}\``,
            `${state} · ${left}`,
            [
                link('$(arrow-up) Previous', 'lunaticflow.previousChange', 'Previous change'),
                link('$(arrow-down) Next', 'lunaticflow.nextChange', 'Next change'),
                ...(t.open ? [link('$(debug-step-over) Next undecided', 'lunaticflow.nextUndecided', 'Next change without a decision')] : []),
            ].join(' · '),
            [
                link('$(arrow-left) Previous file', 'lunaticflow.previousFile', 'Previous changed file'),
                link(`$(arrow-right) Next file${next ? `: ${path.basename(next.path)}` : ''}`, 'lunaticflow.nextFile', 'Next changed file'),
            ].join(' · '),
        ];
        if (t.open) {
            rows.push('---', [
                link('$(check) Approve', 'lunaticflow.approveHunk', 'Approve this change'),
                link('$(close) Reject', 'lunaticflow.rejectHunk', 'Reject this change'),
                link('$(comment) Comment', 'lunaticflow.commentHunk', 'Comment on this change'),
            ].join(' · '));
        }
        const md = new vscode.MarkdownString(rows.join('\n\n'), true);
        md.isTrusted = {
            enabledCommands: [...Object.keys(NAV_COMMANDS), 'lunaticflow.approveHunk', 'lunaticflow.rejectHunk', 'lunaticflow.commentHunk'],
        };
        const h = files[fi].hunks[hi];
        return new vscode.Hover(md, new vscode.Range(h.start - 1, 0, h.end - 1, 0));
    }

    // ── CodeLens and decorations ────────────────────────────────────────────

    private async codeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const ref = parseRevUri(doc.uri);
        if (!ref || ref.side !== 'new') { return []; }
        const t = await this.target(ref.root, ref.sprint);
        if (!t || t.round.n !== ref.round) { return []; }
        const file = t.files.find(f => f.path === ref.path);
        if (!file) { return []; }
        const decisions = this.decisionsOf(t.round);
        const lenses: vscode.CodeLens[] = [];
        file.hunks.forEach((h, i) => {
            const r = hunkNewRange(h);
            const line = Math.min(Math.max(r.start - 1, 0), Math.max(doc.lineCount - 1, 0));
            const range = new vscode.Range(line, 0, line, 0);
            const arg: HunkArg = { root: ref.root, sprint: ref.sprint, path: file.path, key: h.key };
            const d = decisions[h.key];
            const status = d?.decision === 'approved' ? '$(pass-filled) approved'
                : d?.decision === 'rejected' ? `$(error) rejected${d.reason ? `: ${d.reason}` : ''}`
                : '$(circle-large-outline) undecided';
            lenses.push(new vscode.CodeLens(range, { title: `${status}  (+${h.added} −${h.removed})`, command: '' }));
            // Navigation goes last on the row, and stays once the round is reviewed.
            const nav = [
                new vscode.CodeLens(range, { title: '$(arrow-up)', tooltip: 'Previous change', command: 'lunaticflow.previousChange', arguments: [arg] }),
                new vscode.CodeLens(range, { title: '$(arrow-down)', tooltip: 'Next change', command: 'lunaticflow.nextChange', arguments: [arg] }),
                new vscode.CodeLens(range, { title: `${i + 1}/${file.hunks.length}`, tooltip: `Change ${i + 1} of ${file.hunks.length} in this file`, command: '' }),
            ];
            if (!t.open) { lenses.push(...nav); return; }
            if (d?.decision !== 'approved') {
                lenses.push(new vscode.CodeLens(range, { title: '$(check) Approve', command: 'lunaticflow.approveHunk', arguments: [arg] }));
            }
            if (d?.decision !== 'rejected') {
                lenses.push(new vscode.CodeLens(range, { title: '$(close) Reject', command: 'lunaticflow.rejectHunk', arguments: [arg] }));
            }
            lenses.push(new vscode.CodeLens(range, { title: '$(comment) Comment', command: 'lunaticflow.commentHunk', arguments: [arg] }));
            if (d) {
                lenses.push(new vscode.CodeLens(range, { title: '$(discard) Undo', command: 'lunaticflow.clearHunk', arguments: [arg] }));
            }
            lenses.push(...nav);
        });
        return lenses;
    }

    private async decorate(editor: vscode.TextEditor): Promise<void> {
        const ref = parseRevUri(editor.document.uri);
        if (!ref || ref.side !== 'new') { return; }
        const t = await this.target(ref.root, ref.sprint);
        const file = t?.files.find(f => f.path === ref.path);
        if (!t || !file || t.round.n !== ref.round) { return; }
        const decisions = this.decisionsOf(t.round);
        const sets: Record<'approved' | 'rejected' | 'undecided', vscode.Range[]> = { approved: [], rejected: [], undecided: [] };
        for (const h of file.hunks) {
            const r = hunkNewRange(h);
            if (!h.added) { continue; }  // pure deletions have no lines on this side
            const range = new vscode.Range(r.start - 1, 0, r.end - 1, 0);
            sets[decisions[h.key]?.decision ?? 'undecided'].push(range);
        }
        editor.setDecorations(this.decoApproved, sets.approved);
        editor.setDecorations(this.decoRejected, sets.rejected);
        editor.setDecorations(this.decoUndecided, t.open ? sets.undecided : []);
    }

    private refreshEditors(): void {
        this.lensEmitter.fire();
        for (const e of vscode.window.visibleTextEditors) { void this.decorate(e); }
        void this.syncThreads();
    }

    // ── comment threads ─────────────────────────────────────────────────────

    private reviewerName(): string {
        return vscode.workspace.getConfiguration('lunaticflow').get<string>('reviewerName', 'You');
    }

    private toComments(th: Thread): vscode.Comment[] {
        return th.messages.map(m => ({
            body: new vscode.MarkdownString(m.body),
            mode: vscode.CommentMode.Preview,
            author: { name: m.author === 'agent' ? NAME_AGENT : this.reviewerName() },
            label: `round ${m.round}${th.submitted || m.author === 'agent' ? '' : ' · draft'}`,
        }));
    }

    private contextOf(th: Thread): string {
        return th.status === 'resolved' ? 'resolved' : th.submitted ? 'open' : 'open-draft';
    }

    /** Make the comment threads in open review documents match the sprint files. */
    private syncing = false;
    private async syncThreads(): Promise<void> {
        if (this.syncing) { return; }
        this.syncing = true;
        try {
            const wanted = new Set<string>();
            for (const doc of vscode.workspace.textDocuments) {
                const ref = parseRevUri(doc.uri);
                if (!ref || ref.side !== 'new') { continue; }
                const t = await this.target(ref.root, ref.sprint);
                if (!t || t.round.n !== ref.round) { continue; }
                for (const { thread, line } of await this.threadsFor(t, ref.path)) {
                    const key = `${doc.uri.toString()}#${thread.id}`;
                    wanted.add(key);
                    const l = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
                    let ct = this.threads.get(key);
                    if (!ct) {
                        ct = this.comments.createCommentThread(doc.uri, new vscode.Range(l, 0, l, 0), []);
                        this.threads.set(key, ct);
                        this.threadIds.set(ct, { root: ref.root, sprint: ref.sprint, id: thread.id });
                        ct.collapsibleState = thread.status === 'open'
                            ? vscode.CommentThreadCollapsibleState.Expanded
                            : vscode.CommentThreadCollapsibleState.Collapsed;
                    }
                    ct.comments = this.toComments(thread);
                    ct.contextValue = this.contextOf(thread);
                    ct.label = thread.round < t.round.n ? `from round ${thread.round}` : undefined;
                    ct.canReply = t.open;
                    ct.state = thread.status === 'resolved'
                        ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
                }
            }
            for (const [key, ct] of this.threads) {
                if (!wanted.has(key)) { ct.dispose(); this.threads.delete(key); }
            }
        } finally {
            this.syncing = false;
        }
    }

    private async commentOnHunk(a?: HunkArg): Promise<void> {
        const r = await this.resolveHunk(a);
        if (!r || !this.ensureOpen(r.t)) { return; }
        // Make sure the diff is showing, then open an empty thread on the hunk's first line.
        const right = revUri({
            root: r.t.repo.root, sprint: r.t.state.id, round: r.t.round.n, side: 'new', path: r.file.path,
            rev: r.file.status === 'deleted' ? '' : r.t.round.head,
        });
        if (!vscode.workspace.textDocuments.some(d => d.uri.toString() === right.toString())) {
            await this.open(r.t.repo.root, r.t.state.id, r.file.path, r.hunk.key);
        }
        const line = Math.max(hunkNewRange(r.hunk).start - 1, 0);
        const ct = this.comments.createCommentThread(right, new vscode.Range(line, 0, line, 0), []);
        ct.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        ct.canReply = true;
    }

    private async createComment(reply: vscode.CommentReply): Promise<void> {
        const ref = parseRevUri(reply.thread.uri);
        const text = reply.text.trim();
        if (!ref || !text) { return; }
        const t = await this.target(ref.root, ref.sprint);
        if (!t || !this.ensureOpen(t)) { reply.thread.dispose(); return; }
        const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const line = (reply.thread.range?.start.line ?? 0) + 1;
        const th: Thread = {
            id, round: t.round.n, path: ref.path, line, status: 'open', submitted: false,
            messages: [{ author: 'user', body: text, at: new Date().toISOString(), round: t.round.n }],
        };
        t.repo.updateState(t.state.id, s => { s.threads.push(th); });
        // Adopt the thread VS Code created for the gutter "+".
        const key = `${reply.thread.uri.toString()}#${id}`;
        this.threads.set(key, reply.thread);
        this.threadIds.set(reply.thread, { root: ref.root, sprint: ref.sprint, id });
        reply.thread.comments = this.toComments(th);
        reply.thread.contextValue = this.contextOf(th);
        this.store.refresh();
    }

    private async replyComment(reply: vscode.CommentReply): Promise<void> {
        const ids = this.threadIds.get(reply.thread);
        const text = reply.text.trim();
        if (!ids || !text) { return; }
        const t = await this.target(ids.root, ids.sprint);
        if (!t || !this.ensureOpen(t)) { return; }
        t.repo.updateState(ids.sprint, s => {
            const th = s.threads.find(x => x.id === ids.id);
            th?.messages.push({ author: 'user', body: text, at: new Date().toISOString(), round: t.round.n });
            // A new message on a resolved thread reopens it.
            if (th) { th.status = 'open'; }
        });
        this.store.refresh();
    }

    private async setStatusOf(ct: vscode.CommentThread, status: 'open' | 'resolved'): Promise<void> {
        const ids = this.threadIds.get(ct);
        if (ids) { await this.setThreadStatus(ids.root, ids.sprint, ids.id, status); }
    }

    private async setThreadStatus(root: string, sprint: string, id: string, status: 'open' | 'resolved'): Promise<void> {
        const t = await this.target(root, sprint);
        if (!t || !this.ensureOpen(t)) { return; }
        t.repo.updateState(sprint, s => {
            const th = s.threads.find(x => x.id === id);
            if (th) { th.status = status; }
        });
        this.store.refresh();
    }

    private async deleteDraft(ct: vscode.CommentThread): Promise<void> {
        const ids = this.threadIds.get(ct);
        if (!ids) { ct.dispose(); return; }
        const repo = this.store.repo(ids.root);
        repo?.updateState(ids.sprint, s => {
            s.threads = s.threads.filter(x => !(x.id === ids.id && !x.submitted));
        });
        this.store.refresh();
    }

    private async revealThread(a: { root: string; sprint: string; id: string }): Promise<void> {
        const t = await this.target(a.root, a.sprint);
        const th = t?.state.threads.find(x => x.id === a.id);
        if (!t || !th) { return; }
        await this.open(a.root, a.sprint, th.path);
        const mapped = (await this.threadsFor(t, th.path)).find(x => x.thread.id === a.id);
        const ed = vscode.window.activeTextEditor;
        if (ed && mapped) {
            const pos = new vscode.Position(Math.max(mapped.line - 1, 0), 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    }

    // ── sending the review ──────────────────────────────────────────────────

    async submit(a?: { root: string; sprint: string }): Promise<void> {
        let root = a?.root, sprint = a?.sprint;
        if (!root) {
            const ref = vscode.window.activeTextEditor && parseRevUri(vscode.window.activeTextEditor.document.uri);
            if (!ref) {
                vscode.window.showWarningMessage('Open a sprint review first, or use Send Review on the sprint in the Flow view.');
                return;
            }
            root = ref.root; sprint = ref.sprint;
        }
        const t = await this.target(root, sprint!);
        if (!t || !this.ensureOpen(t)) { return; }
        const decisions = { ...(t.round.draft ?? {}) };
        // A hunk with a comment from this round counts as answered: the comment asks for the change.
        const commented = new Set<string>();
        for (const f of t.files) {
            const mine = t.state.threads.filter(th => th.path === f.path && th.round === t.round.n && th.status === 'open');
            for (const h of f.hunks) {
                const r = hunkNewRange(h);
                if (mine.some(th => th.line >= r.start - 3 && th.line <= r.end + 3)) { commented.add(h.key); }
            }
        }
        let tl = tally(t.files, decisions, t.state.threads);
        const silent = tl.undecided.filter(k => !commented.has(k));
        if (silent.length) {
            const pick = await vscode.window.showWarningMessage(
                `${silent.length} change${silent.length === 1 ? ' has' : 's have'} no decision and no comment.`,
                { modal: true }, 'Approve Them', 'Keep Reviewing');
            if (pick !== 'Approve Them') { return; }
            for (const f of t.files) {
                for (const h of f.hunks) {
                    if (silent.includes(h.key)) { decisions[h.key] = { path: f.path, decision: 'approved' }; }
                }
            }
            tl = tally(t.files, decisions, t.state.threads);
        }
        const verdict = verdictOf(tl);
        const now = new Date().toISOString();
        const fresh = t.repo.updateState(t.state.id, s => {
            const round = s.rounds[s.rounds.length - 1];
            round.review = { submittedAt: now, decisions, verdict };
            delete round.draft;
            for (const th of s.threads) { th.submitted = true; }
            s.status = verdict === 'approved' ? 'approved' : 'revising';
            if (verdict === 'approved') { s.approvedAt = now; }
        });
        this.store.refresh();

        if (verdict === 'approved') {
            const ready = readySprints(t.repo.plan, t.repo.states).map(s => s.id);
            vscode.window.showInformationMessage(
                `Sprint ${sprint} approved.` + (ready.length ? ` Ready next: ${ready.join(', ')}.` : ' The plan is complete.'));
        } else {
            vscode.window.showInformationMessage(
                `Review sent for ${sprint}: ${tl.approved} approved, ${tl.rejected} rejected, ${tl.openThreads.length} open thread(s).`);
        }
        if (!fresh.awaiting) { await this.nudgeAgent(t.repo, fresh); }
    }

    /** The agent is not blocked in `lf await`: offer to open its session with a prompt ready to send. */
    private async nudgeAgent(repo: FlowRepo, s: SprintState): Promise<void> {
        const prompt = s.status === 'approved'
            ? `LunaticFlow: sprint ${s.id} is approved. Run \`lf next\` and start the next ready sprint.`
            : `LunaticFlow: the review of sprint ${s.id} is in. Run \`lf show ${s.id}\` and address it.`;
        const session = sessionFor(repo, s);
        const actions = session ? ['Open Agent Session', 'Copy Prompt'] : ['Copy Prompt'];
        const pick = await vscode.window.showInformationMessage(
            `The agent for ${s.id} isn't waiting in \`lf await\`.`, ...actions);
        if (pick === 'Open Agent Session' && session) { await openClaudeSession(session, prompt); }
        if (pick === 'Copy Prompt') { await vscode.env.clipboard.writeText(prompt); }
    }
}

/** The Claude Code session that owns a sprint: recorded by `lf start --session`, else the newest live session in the repo. */
export function sessionFor(repo: FlowRepo, s: SprintState): string | undefined {
    if (s.sessionId) { return s.sessionId; }
    const live = repo.agents
        .filter((a: AgentRecord) => a.kind === 'session' && !a.endedAt)
        .sort((x, y) => (y.updatedAt ?? '').localeCompare(x.updatedAt ?? ''));
    return live[0]?.sessionId;
}

/** Open (or focus) a Claude Code tab on a session, with a prompt filled in but not sent. */
export async function openClaudeSession(sessionId: string, prompt?: string): Promise<void> {
    const q = `session=${encodeURIComponent(sessionId)}` + (prompt ? `&prompt=${encodeURIComponent(prompt)}` : '');
    await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?${q}`));
}
