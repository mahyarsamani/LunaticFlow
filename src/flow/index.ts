// LunaticFlow: sprint plans for agents, reviewed in VS Code.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { FlowStore, ResearchAgent } from './store';
import { ReviewController, openClaudeSession } from './review';
import { FlowNode, FlowTreeProvider, nodeArg } from './view';
import { PlanGraphPanel, downstream } from './graph';
import { validatePlan } from './model';
import { playgroundFor, syncPlaygroundConfig } from './playground';

export function activateFlow(context: vscode.ExtensionContext) {
    syncPlaygroundConfig();
    const store = new FlowStore();
    const review = new ReviewController(context, store);
    const tree = new FlowTreeProvider(store, review);
    const view = vscode.window.createTreeView('lunaticflowView', { treeDataProvider: tree, showCollapseAll: true });
    // Moving between changes selects the change in the Flow view, without taking focus from the diff.
    context.subscriptions.push(review.onDidNavigate(e => {
        if (!view.visible) { return; }
        view.reveal(tree.hunkNode(e.repo, e.sprint, e.file, e.hunk), { select: true, focus: false, expand: true })
            .then(undefined, () => { /* the sprint may have changed under us; selection is a nicety */ });
    }));

    // ── Waiting-for-review badge, status bar and notifications ──────────────
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    status.command = 'lunaticflow.nextReview';
    const seen = new Map<string, string>();
    let first = true;
    const update = () => {
        tree.refresh();
        const waiting = tree.waiting();
        view.badge = waiting.length ? { value: waiting.length, tooltip: `${waiting.length} sprint(s) waiting for your review` } : undefined;
        if (waiting.length) {
            status.text = `$(eye) ${waiting.length} to review`;
            status.tooltip = waiting.map(w => `${w.repo.name}: ${w.sprint.id} · ${w.sprint.title}`).join('\n');
            status.show();
        } else {
            status.hide();
        }
        const notify = vscode.workspace.getConfiguration('lunaticflow').get<boolean>('notify', true);
        for (const repo of store.repos) {
            for (const s of repo.plan.sprints) {
                const key = `${repo.root}#${s.id}`;
                const now = repo.state(s.id).status;
                const before = seen.get(key);
                seen.set(key, now);
                if (!first && notify && now === 'in_review' && before !== 'in_review') {
                    void vscode.window.showInformationMessage(
                        `${repo.name}: sprint ${s.id} (${s.title}) is ready for your review.`, 'Review',
                    ).then(pick => {
                        if (pick) { void vscode.commands.executeCommand('lunaticflow.openRound', { root: repo.root, sprint: s.id }); }
                    });
                }
            }
        }
        first = false;
    };
    update();

    // Commands from tree items get the node; translate it into the argument the review commands take.
    const viaNode = (command: string) => (n?: FlowNode) => vscode.commands.executeCommand(command, nodeArg(n));

    const bundledCli = path.join(context.extensionPath, 'cli', 'lf.py');

    context.subscriptions.push(
        store, review, view, status,
        store.onDidChange(update),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { syncPlaygroundConfig(); store.refresh(true); }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lunaticflow')) { syncPlaygroundConfig(); store.refresh(true); }
        }),

        vscode.commands.registerCommand('lunaticflow.openPlayground', async () => {
            const p = playgroundFor(vscode.workspace.workspaceFolders?.[0]);
            if (!p) {
                const pick = await vscode.window.showInformationMessage(
                    'No agent playground is set. Agents make their clones there, one folder per work package.', 'Set It');
                if (pick) { await vscode.commands.executeCommand('workbench.action.openSettings', 'lunaticflow.agentPlayground'); }
                return;
            }
            fs.mkdirSync(p, { recursive: true });
            const pick = await vscode.window.showInformationMessage(`Agent playground: ${p}`, 'Open in New Window', 'Copy Path');
            if (pick === 'Open in New Window') {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
            } else if (pick === 'Copy Path') {
                await vscode.env.clipboard.writeText(p);
            }
        }),

        vscode.commands.registerCommand('lunaticflow.node.approveHunk', viaNode('lunaticflow.approveHunk')),
        vscode.commands.registerCommand('lunaticflow.node.rejectHunk', viaNode('lunaticflow.rejectHunk')),
        vscode.commands.registerCommand('lunaticflow.node.clearHunk', viaNode('lunaticflow.clearHunk')),
        vscode.commands.registerCommand('lunaticflow.node.commentHunk', viaNode('lunaticflow.commentHunk')),
        vscode.commands.registerCommand('lunaticflow.node.approveFile', viaNode('lunaticflow.approveFile')),
        vscode.commands.registerCommand('lunaticflow.node.submitReview', viaNode('lunaticflow.submitReview')),
        vscode.commands.registerCommand('lunaticflow.node.openRound', viaNode('lunaticflow.openRound')),
        vscode.commands.registerCommand('lunaticflow.node.resolveThread', viaNode('lunaticflow.resolveThreadItem')),
        vscode.commands.registerCommand('lunaticflow.node.reopenThread', viaNode('lunaticflow.reopenThreadItem')),

        vscode.commands.registerCommand('lunaticflow.refresh', () => store.refresh(true)),

        vscode.commands.registerCommand('lunaticflow.nextReview', async () => {
            // Review first what unblocks the most work downstream.
            const waiting = tree.waiting()
                .map(w => ({ ...w, unblocks: downstream(w.repo.plan, w.sprint.id).size }))
                .sort((a, b) => b.unblocks - a.unblocks);
            if (!waiting.length) { vscode.window.showInformationMessage('Nothing is waiting for your review.'); return; }
            const pick = waiting.length === 1 ? waiting[0] : (await vscode.window.showQuickPick(
                waiting.map(w => ({
                    label: `$(eye) ${w.sprint.id} · ${w.sprint.title}`,
                    description: w.repo.name,
                    detail: w.unblocks ? `unblocks ${w.unblocks} sprint(s)` : 'unblocks nothing else yet',
                    w,
                })), { placeHolder: 'Sprints waiting for review, most downstream work first' }))?.w;
            if (pick) { await vscode.commands.executeCommand('lunaticflow.openRound', { root: pick.repo.root, sprint: pick.sprint.id }); }
        }),

        vscode.commands.registerCommand('lunaticflow.showPlan', async (n?: FlowNode) => {
            const root = nodeArg(n)?.root;
            const repo = root ? store.repo(root) : store.repos.length === 1 ? store.repos[0]
                : (await vscode.window.showQuickPick(store.repos.map(r => ({ label: r.name, description: r.root, r }))))?.r;
            if (!repo) { return; }
            const problems = validatePlan(repo.plan);
            if (problems.length) { void vscode.window.showWarningMessage(`Plan ${repo.name}: ${problems.join('; ')}`); }
            PlanGraphPanel.show(context, store, repo);
        }),

        vscode.commands.registerCommand('lunaticflow.openSession', async (sessionId?: string) => {
            if (typeof sessionId === 'string') { await openClaudeSession(sessionId); }
        }),

        vscode.commands.registerCommand('lunaticflow.openResearch', async (a?: ResearchAgent) => {
            if (!a) { return; }
            const summary = path.join(a.runDir, 'summary.md');
            const target = fs.existsSync(summary) ? summary : path.join(a.runDir, 'brief.md');
            if (fs.existsSync(target)) { await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true }); }
        }),
        vscode.commands.registerCommand('lunaticflow.resumeResearch', async (n?: FlowNode) => {
            if (n?.kind === 'researchAgent') { await openClaudeSession(n.agent.sessionId); }
        }),

        vscode.commands.registerCommand('lunaticflow.initRepo', async () => {
            const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri
                : (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this repository' }))?.[0];
            if (!folder) { return; }
            execFile('python3', [bundledCli, '-C', folder.fsPath, 'init'], (err, _out, stderr) => {
                if (err) { void vscode.window.showErrorMessage(`lf init failed: ${stderr || err.message}`); return; }
                store.refresh(true);
                void vscode.window.showInformationMessage(`LunaticFlow is set up in ${folder.fsPath}.`);
            });
        }),

        vscode.commands.registerCommand('lunaticflow.installCli', async () => {
            const dir = path.join(os.homedir(), '.local', 'bin');
            const target = path.join(dir, 'lf');
            fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(bundledCli, target);
            fs.chmodSync(target, 0o755);
            const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
            void vscode.window.showInformationMessage(
                `Installed the lf CLI at ${target}` + (onPath ? '.' : `; add ${dir} to your PATH.`));
        }),
    );
}
