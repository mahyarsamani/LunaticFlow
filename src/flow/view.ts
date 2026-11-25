// The Flow view: repositories → plans → sprints → files → hunks, plus the agents working on them.
import * as vscode from 'vscode';
import * as path from 'path';
import { FileDiff, Hunk, hunkNewRange } from './diff';
import { FlowRepo, FlowStore, ResearchAgent } from './store';
import { AgentRecord, PlanSprint, Thread, currentRound, topoOrder } from './model';
import { ReviewController } from './review';

type Node =
    | { kind: 'repo'; repo: FlowRepo }
    | { kind: 'agents'; repo: FlowRepo }
    | { kind: 'agent'; repo: FlowRepo; agent: AgentRecord }
    | { kind: 'research' }
    | { kind: 'researchAgent'; agent: ResearchAgent }
    | { kind: 'sprint'; repo: FlowRepo; sprint: PlanSprint }
    | { kind: 'file'; repo: FlowRepo; sprint: string; file: FileDiff }
    | { kind: 'hunk'; repo: FlowRepo; sprint: string; file: FileDiff; hunk: Hunk }
    | { kind: 'threads'; repo: FlowRepo; sprint: string }
    | { kind: 'thread'; repo: FlowRepo; sprint: string; thread: Thread };

const STATUS: Record<string, { icon: string; color?: string; label: string }> = {
    planned: { icon: 'circle-large-outline', label: 'ready' },
    blocked: { icon: 'lock', label: 'waiting on dependencies' },
    working: { icon: 'sync~spin', color: 'charts.blue', label: 'agent working' },
    in_review: { icon: 'eye', color: 'charts.yellow', label: 'waiting for you' },
    revising: { icon: 'edit', color: 'charts.blue', label: 'agent revising' },
    approved: { icon: 'pass-filled', color: 'charts.green', label: 'approved' },
};

export class FlowTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly emitter = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly store: FlowStore, private readonly review: ReviewController) {}

    refresh() { this.emitter.fire(undefined); }

    /** Sprints waiting for the reviewer, across every repository. */
    waiting(): { repo: FlowRepo; sprint: PlanSprint }[] {
        const out: { repo: FlowRepo; sprint: PlanSprint }[] = [];
        for (const repo of this.store.repos) {
            for (const s of repo.plan.sprints) {
                if (repo.state(s.id).status === 'in_review') { out.push({ repo, sprint: s }); }
            }
        }
        return out;
    }

    async getChildren(n?: Node): Promise<Node[]> {
        if (!n) {
            const out: Node[] = this.store.repos.map(repo => ({ kind: 'repo' as const, repo }));
            if (this.store.research.length) { out.push({ kind: 'research' }); }
            return out;
        }
        switch (n.kind) {
            case 'repo': {
                const out: Node[] = [];
                if (n.repo.agents.length) { out.push({ kind: 'agents', repo: n.repo }); }
                for (const sprint of topoOrder(n.repo.plan)) { out.push({ kind: 'sprint', repo: n.repo, sprint }); }
                return out;
            }
            case 'agents':
                return n.repo.agents
                    .filter(a => a.kind === 'session')
                    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
                    .map(agent => ({ kind: 'agent' as const, repo: n.repo, agent }));
            case 'agent':
                return n.repo.agents
                    .filter(a => a.kind === 'subagent' && a.parentSessionId === n.agent.sessionId)
                    .map(agent => ({ kind: 'agent' as const, repo: n.repo, agent }));
            case 'research':
                return this.store.research.map(agent => ({ kind: 'researchAgent' as const, agent }));
            case 'sprint': {
                const st = n.repo.state(n.sprint.id);
                const round = currentRound(st);
                if (!round) { return []; }
                const files = await this.store.roundDiff(n.repo, round).catch(() => [] as FileDiff[]);
                const out: Node[] = files.map(file => ({ kind: 'file' as const, repo: n.repo, sprint: n.sprint.id, file }));
                if (st.threads.length) { out.push({ kind: 'threads', repo: n.repo, sprint: n.sprint.id }); }
                return out;
            }
            case 'file':
                return n.file.hunks.map(hunk => ({ ...n, kind: 'hunk' as const, hunk }));
            case 'threads':
                return n.repo.state(n.sprint).threads.map(thread => ({ kind: 'thread' as const, repo: n.repo, sprint: n.sprint, thread }));
            default:
                return [];
        }
    }

    /** The hunk node for a change, for selecting it with `TreeView.reveal`. */
    hunkNode(repo: FlowRepo, sprint: string, file: FileDiff, hunk: Hunk): Node {
        return { kind: 'hunk', repo, sprint, file, hunk };
    }

    /** Parents along the path that `reveal` walks: hunk → file → sprint → repository. */
    getParent(n: Node): Node | undefined {
        switch (n.kind) {
            case 'hunk': return { kind: 'file', repo: n.repo, sprint: n.sprint, file: n.file };
            case 'file':
            case 'threads': {
                const sprint = n.repo.plan.sprints.find(s => s.id === n.sprint);
                return sprint ? { kind: 'sprint', repo: n.repo, sprint } : undefined;
            }
            case 'thread': return { kind: 'threads', repo: n.repo, sprint: n.sprint };
            case 'sprint':
            case 'agents': return { kind: 'repo', repo: n.repo };
            default: return undefined;
        }
    }

    getTreeItem(n: Node): vscode.TreeItem {
        const it = this.item(n);
        // Stable ids let `reveal` find a node built anew, and keep expansion across refreshes.
        const id = nodeId(n);
        if (id) { it.id = id; }
        return it;
    }

    private item(n: Node): vscode.TreeItem {
        switch (n.kind) {
            case 'repo': {
                const it = new vscode.TreeItem(n.repo.name, vscode.TreeItemCollapsibleState.Expanded);
                const total = n.repo.plan.sprints.length;
                const done = n.repo.plan.sprints.filter(s => n.repo.state(s.id).status === 'approved').length;
                it.description = `${done}/${total} approved · ${n.repo.origin === 'agents' ? n.repo.root : relative(n.repo.root)}`;
                it.iconPath = new vscode.ThemeIcon(n.repo.origin === 'agents' ? 'robot' : 'repo');
                it.contextValue = 'flowRepo';
                it.tooltip = n.repo.root;
                return it;
            }
            case 'agents': {
                const live = n.repo.agents.filter(a => !a.endedAt).length;
                const it = new vscode.TreeItem('Agents', vscode.TreeItemCollapsibleState.Collapsed);
                it.description = `${live} active`;
                it.iconPath = new vscode.ThemeIcon('organization');
                return it;
            }
            case 'agent': {
                const a = n.agent;
                const subs = n.repo.agents.filter(x => x.kind === 'subagent' && x.parentSessionId === a.sessionId);
                const it = new vscode.TreeItem(
                    a.kind === 'session' ? (a.name ?? `session ${a.sessionId.slice(0, 8)}`) : (a.agentType ?? 'subagent'),
                    subs.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
                it.description = `${a.endedAt ? 'ended' : 'active'}${a.updatedAt ? ' · ' + ago(a.updatedAt) : ''}`;
                it.iconPath = new vscode.ThemeIcon(a.kind === 'session' ? 'comment-discussion' : 'symbol-event',
                    a.endedAt ? undefined : new vscode.ThemeColor('charts.blue'));
                it.tooltip = `${a.kind} ${a.sessionId}${a.cwd ? '\n' + a.cwd : ''}`;
                if (a.kind === 'session') {
                    it.contextValue = 'flowSession';
                    it.command = { command: 'lunaticflow.openSession', title: 'Open Session', arguments: [a.sessionId] };
                }
                return it;
            }
            case 'research': {
                const running = this.store.research.filter(a => a.running).length;
                const it = new vscode.TreeItem('Research agents (spawn.sh)', vscode.TreeItemCollapsibleState.Collapsed);
                it.description = `${running} running`;
                it.iconPath = new vscode.ThemeIcon('beaker');
                return it;
            }
            case 'researchAgent': {
                const a = n.agent;
                const it = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None);
                it.description = `${a.running ? 'running' : a.done ? 'done' : 'stopped'} · ${a.model} · ${a.started.slice(0, 16).replace('T', ' ')}`;
                it.iconPath = new vscode.ThemeIcon(a.running ? 'loading~spin' : a.done ? 'pass' : 'circle-slash');
                it.contextValue = 'flowResearch';
                it.tooltip = `${a.runDir}\nsession ${a.sessionId}`;
                it.command = { command: 'lunaticflow.openResearch', title: 'Open', arguments: [a] };
                return it;
            }
            case 'sprint': {
                const st = n.repo.state(n.sprint.id);
                const status = n.repo.sprintStatus(n.sprint.id);
                const meta = STATUS[status];
                const round = currentRound(st);
                const it = new vscode.TreeItem(`${n.sprint.id} · ${n.sprint.title}`,
                    round ? (status === 'in_review' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
                        : vscode.TreeItemCollapsibleState.None);
                const bits = [meta.label];
                if (round) { bits.push(`round ${round.n}`); }
                if (n.sprint.deps.length) { bits.push(`after ${n.sprint.deps.join(', ')}`); }
                if (status === 'in_review' && st.awaiting) { bits.push('agent waiting'); }
                it.description = bits.join(' · ');
                it.iconPath = new vscode.ThemeIcon(meta.icon, meta.color ? new vscode.ThemeColor(meta.color) : undefined);
                it.contextValue = `sprint-${status}`;
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`**${n.sprint.id} · ${n.sprint.title}**\n\n`);
                if (n.sprint.goal) { md.appendMarkdown(`${n.sprint.goal}\n\n`); }
                if (n.sprint.scope?.length) { md.appendMarkdown(`Scope: ${n.sprint.scope.map(s => '`' + s + '`').join(', ')}\n\n`); }
                if (round?.summary) { md.appendMarkdown(`Round ${round.n}: ${round.summary}\n\n`); }
                if (round?.tests) { md.appendMarkdown(`Tests: ${round.tests}\n\n`); }
                it.tooltip = md;
                if (round) {
                    it.command = { command: 'lunaticflow.openRound', title: 'Review', arguments: [{ root: n.repo.root, sprint: n.sprint.id }] };
                }
                return it;
            }
            case 'file': {
                const st = n.repo.state(n.sprint);
                const round = currentRound(st)!;
                const d = this.review.decisionsOf(round);
                const decided = n.file.hunks.filter(h => d[h.key]).length;
                const rejected = n.file.hunks.filter(h => d[h.key]?.decision === 'rejected').length;
                const it = new vscode.TreeItem(path.basename(n.file.path), vscode.TreeItemCollapsibleState.Collapsed);
                it.resourceUri = vscode.Uri.file(path.join(n.repo.root, n.file.path));
                const dir = path.dirname(n.file.path);
                it.description = `${dir === '.' ? '' : dir + ' · '}${n.file.status === 'modified' ? '' : n.file.status + ' · '}${decided}/${n.file.hunks.length}`
                    + (rejected ? ` · ${rejected} rejected` : '');
                it.iconPath = decided === n.file.hunks.length
                    ? new vscode.ThemeIcon(rejected ? 'error' : 'pass-filled', new vscode.ThemeColor(rejected ? 'charts.red' : 'charts.green'))
                    : vscode.ThemeIcon.File;
                it.contextValue = st.status === 'in_review' && !round.review ? 'flowFile-open' : 'flowFile';
                it.command = { command: 'lunaticflow.openRound', title: 'Open', arguments: [{ root: n.repo.root, sprint: n.sprint, path: n.file.path }] };
                return it;
            }
            case 'hunk': {
                const st = n.repo.state(n.sprint);
                const round = currentRound(st)!;
                const d = this.review.decisionsOf(round)[n.hunk.key];
                const r = hunkNewRange(n.hunk);
                const it = new vscode.TreeItem(n.hunk.lines.length ? `lines ${r.start}–${r.end}` : n.hunk.header,
                    vscode.TreeItemCollapsibleState.None);
                it.description = `+${n.hunk.added} −${n.hunk.removed}` + (d ? ` · ${d.decision}${d.reason ? ': ' + d.reason : ''}` : '');
                it.iconPath = d?.decision === 'approved' ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
                    : d?.decision === 'rejected' ? new vscode.ThemeIcon('close', new vscode.ThemeColor('charts.red'))
                    : new vscode.ThemeIcon('circle-small');
                const open = st.status === 'in_review' && !round.review;
                it.contextValue = open ? `flowHunk-${d?.decision ?? 'undecided'}` : 'flowHunk';
                it.tooltip = new vscode.MarkdownString('```diff\n' + n.hunk.lines.slice(0, 40).join('\n') + '\n```');
                it.command = {
                    command: 'lunaticflow.openRound', title: 'Show',
                    arguments: [{ root: n.repo.root, sprint: n.sprint, path: n.file.path, key: n.hunk.key }],
                };
                return it;
            }
            case 'threads': {
                const ths = n.repo.state(n.sprint).threads;
                const open = ths.filter(t => t.status === 'open').length;
                const it = new vscode.TreeItem('Threads', vscode.TreeItemCollapsibleState.Collapsed);
                it.description = `${open} open · ${ths.length - open} resolved`;
                it.iconPath = new vscode.ThemeIcon('comment-discussion');
                return it;
            }
            case 'thread': {
                const th = n.thread;
                const first = th.messages[0]?.body ?? '';
                const it = new vscode.TreeItem(first.replace(/\s+/g, ' ').slice(0, 70), vscode.TreeItemCollapsibleState.None);
                const replies = th.messages.filter(m => m.author === 'agent').length;
                it.description = `${th.path}:${th.line} · round ${th.round}${replies ? ` · ${replies} repl${replies === 1 ? 'y' : 'ies'}` : ''}${th.submitted ? '' : ' · draft'}`;
                it.iconPath = new vscode.ThemeIcon(th.status === 'open' ? 'comment-unresolved' : 'comment',
                    th.status === 'open' ? new vscode.ThemeColor('charts.yellow') : undefined);
                it.tooltip = new vscode.MarkdownString(th.messages.map(m => `**${m.author === 'agent' ? 'Claude' : 'You'}** (round ${m.round}): ${m.body}`).join('\n\n'));
                it.contextValue = `flowThread-${th.status}`;
                it.command = { command: 'lunaticflow.revealThread', title: 'Show', arguments: [{ root: n.repo.root, sprint: n.sprint, id: th.id }] };
                return it;
            }
        }
    }
}

function relative(p: string): string {
    const rel = vscode.workspace.asRelativePath(p, true);
    return rel === p ? p : rel;
}

function ago(iso: string): string {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!isFinite(s)) { return ''; }
    if (s < 90) { return 'just now'; }
    if (s < 5400) { return `${Math.round(s / 60)} min ago`; }
    if (s < 129600) { return `${Math.round(s / 3600)} h ago`; }
    return `${Math.round(s / 86400)} d ago`;
}

/**
 * A node's tree id, for the nodes `reveal` walks and their siblings; agents keep VS Code's own
 * handles. A hunk's key can repeat within a file (two identical edits), so its index is part of the id.
 */
function nodeId(n: Node): string | undefined {
    switch (n.kind) {
        case 'repo': return `repo:${n.repo.root}`;
        case 'agents': return `agents:${n.repo.root}`;
        case 'sprint': return `sprint:${n.repo.root}#${n.sprint.id}`;
        case 'file': return `file:${n.repo.root}#${n.sprint}#${n.file.path}`;
        case 'hunk': {
            const i = n.file.hunks.indexOf(n.hunk);
            const index = i >= 0 ? i : n.file.hunks.findIndex(h => h.key === n.hunk.key);
            return `hunk:${n.repo.root}#${n.sprint}#${n.file.path}#${index}#${n.hunk.key}`;
        }
        case 'threads': return `threads:${n.repo.root}#${n.sprint}`;
        case 'thread': return `thread:${n.repo.root}#${n.sprint}#${n.thread.id}`;
        default: return undefined;
    }
}

/** Convert a tree node into the argument the hunk and file commands take. */
export function nodeArg(n: Node | undefined): Record<string, string> | undefined {
    if (!n) { return undefined; }
    switch (n.kind) {
        case 'hunk': return { root: n.repo.root, sprint: n.sprint, path: n.file.path, key: n.hunk.key };
        case 'file': return { root: n.repo.root, sprint: n.sprint, path: n.file.path };
        case 'sprint': return { root: n.repo.root, sprint: n.sprint.id };
        case 'thread': return { root: n.repo.root, sprint: n.sprint, id: n.thread.id };
        case 'repo': return { root: n.repo.root };
        default: return undefined;
    }
}

export type FlowNode = Node;
