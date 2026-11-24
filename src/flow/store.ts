// Finds LunaticFlow repositories and agents on disk and keeps their state loaded.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { diffArgs, FileDiff, parseDiff } from './diff';
import {
    AgentRecord, FLOW_DIR, Plan, Round, SprintState, SprintStatus, emptySprintState,
} from './model';

export function git(root: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr.trim() || err.message)); }
            else { resolve(stdout); }
        });
    });
}

function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/** Write through a temporary file so the CLI never reads half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** One repository with a .lunaticflow directory. */
export class FlowRepo {
    plan: Plan = { version: 1, title: '', sprints: [] };
    states = new Map<string, SprintState>();
    agents: AgentRecord[] = [];
    /** Where the repository was found: a workspace folder, or an agent root such as /scr/<user>/agents. */
    origin: 'workspace' | 'agents' = 'workspace';

    constructor(readonly root: string) {}

    get dir() { return path.join(this.root, FLOW_DIR); }
    get name() { return this.plan.title || path.basename(this.root); }

    sprintFile(id: string) { return path.join(this.dir, 'sprints', `${id}.json`); }

    load(): void {
        this.plan = readJson<Plan>(path.join(this.dir, 'plan.json')) ?? { version: 1, title: '', sprints: [] };
        this.plan.sprints = (this.plan.sprints ?? []).map(s => ({ ...s, deps: s.deps ?? [] }));
        this.states.clear();
        for (const s of this.plan.sprints) {
            this.states.set(s.id, readJson<SprintState>(this.sprintFile(s.id)) ?? emptySprintState(s.id));
        }
        this.agents = [];
        const agentsDir = path.join(this.dir, 'agents');
        for (const f of safeReaddir(agentsDir)) {
            if (!f.endsWith('.json')) { continue; }
            const a = readJson<AgentRecord>(path.join(agentsDir, f));
            if (a) { this.agents.push(a); }
        }
    }

    state(id: string): SprintState {
        return this.states.get(id) ?? emptySprintState(id);
    }

    /** Read-modify-write one sprint's state, re-reading it first so the agent's latest writes survive. */
    updateState(id: string, fn: (s: SprintState) => void): SprintState {
        const fresh = readJson<SprintState>(this.sprintFile(id)) ?? emptySprintState(id);
        fn(fresh);
        writeJsonAtomic(this.sprintFile(id), fresh);
        this.states.set(id, fresh);
        return fresh;
    }

    /** Fingerprint of everything on disk, to notice changes made by agents. */
    signature(): string {
        const parts: string[] = [];
        for (const sub of ['', 'sprints', 'agents']) {
            const d = path.join(this.dir, sub);
            for (const f of safeReaddir(d)) {
                if (!f.endsWith('.json')) { continue; }
                try { parts.push(`${sub}/${f}:${fs.statSync(path.join(d, f)).mtimeMs}`); } catch { /* raced */ }
            }
        }
        return parts.sort().join('|');
    }

    sprintStatus(id: string): SprintStatus | 'blocked' {
        const st = this.state(id).status;
        if (st !== 'planned') { return st; }
        const s = this.plan.sprints.find(x => x.id === id);
        const blocked = s?.deps.some(d => this.state(d).status !== 'approved');
        return blocked ? 'blocked' : 'planned';
    }
}

/** A detached research agent started by tools/agents/spawn.sh (briefing-room/registry.tsv). */
export interface ResearchAgent {
    started: string;
    sessionId: string;
    pid: number;
    model: string;
    name: string;
    runDir: string;
    running: boolean;
    done: boolean;
    workspaceRoot: string;
}

function safeReaddir(d: string): string[] {
    try { return fs.readdirSync(d); } catch { return []; }
}

const SKIP = new Set(['node_modules', 'build', 'out', 'dist', '__pycache__', 'venv', '.venv']);

function expandHome(p: string): string {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function pidAlive(pid: number): boolean {
    if (!pid) { return false; }
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class FlowStore implements vscode.Disposable {
    repos: FlowRepo[] = [];
    research: ResearchAgent[] = [];
    private sig = '';
    private timer: NodeJS.Timeout | undefined;
    private lastScan = 0;
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;
    private readonly diffCache = new Map<string, Promise<FileDiff[]>>();

    constructor() {
        this.scan();
        this.timer = setInterval(() => this.poll(), 2500);
    }

    dispose() {
        if (this.timer) { clearInterval(this.timer); }
        this.emitter.dispose();
    }

    private config() { return vscode.workspace.getConfiguration('lunaticflow'); }

    /** Look for .lunaticflow directories under the workspace folders and the agent roots. */
    scan(): void {
        const depth = this.config().get<number>('scanDepth', 2);
        const found = new Map<string, 'workspace' | 'agents'>();
        const walk = (dir: string, d: number, origin: 'workspace' | 'agents') => {
            if (fs.existsSync(path.join(dir, FLOW_DIR, 'plan.json'))) {
                if (!found.has(dir)) { found.set(dir, origin); }
            }
            if (d >= depth) { return; }
            for (const name of safeReaddir(dir)) {
                if (name.startsWith('.') || SKIP.has(name) || name === 'gem5') { continue; }
                const child = path.join(dir, name);
                let isDir = false;
                try { isDir = fs.statSync(child).isDirectory(); } catch { /* broken link */ }
                if (isDir) { walk(child, d + 1, origin); }
            }
        };
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            if (f.uri.scheme === 'file') { walk(f.uri.fsPath, 0, 'workspace'); }
        }
        for (const r of this.config().get<string[]>('agentRoots', [])) {
            const root = expandHome(r);
            if (fs.existsSync(root)) { walk(root, 0, 'agents'); }
        }
        const old = new Map(this.repos.map(r => [r.root, r]));
        this.repos = [...found].map(([root, origin]) => {
            const repo = old.get(root) ?? new FlowRepo(root);
            repo.origin = origin;
            repo.load();
            return repo;
        });
        this.research = this.loadResearch();
        this.lastScan = Date.now();
        this.sig = this.signature();
    }

    private loadResearch(): ResearchAgent[] {
        const out: ResearchAgent[] = [];
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            const reg = path.join(f.uri.fsPath, 'briefing-room', 'registry.tsv');
            let text = '';
            try { text = fs.readFileSync(reg, 'utf8'); } catch { continue; }
            for (const line of text.split('\n')) {
                const c = line.split('\t');
                if (c.length < 7) { continue; }
                const [started, sessionId, pid, model, , name, run] = c;
                const runDir = path.join(f.uri.fsPath, 'briefing-room', run);
                out.push({
                    started, sessionId, pid: +pid, model, name, runDir,
                    running: pidAlive(+pid),
                    done: fs.existsSync(path.join(runDir, 'summary.md')),
                    workspaceRoot: f.uri.fsPath,
                });
            }
        }
        return out.reverse();
    }

    private signature(): string {
        const regs = (vscode.workspace.workspaceFolders ?? []).map(f => {
            try { return fs.statSync(path.join(f.uri.fsPath, 'briefing-room', 'registry.tsv')).mtimeMs; } catch { return 0; }
        });
        return this.repos.map(r => r.root + '#' + r.signature()).join('\n') + '\n' + regs.join(',')
            + '\n' + this.research.map(a => +a.running).join('');
    }

    private poll(): void {
        if (Date.now() - this.lastScan > 30_000) {
            const before = this.repos.map(r => r.root).join('\n');
            this.scan();
            if (this.repos.map(r => r.root).join('\n') !== before) {
                this.emitter.fire();
                return;
            }
        }
        for (const a of this.research) { a.running = pidAlive(a.pid); }
        const sig = this.signature();
        if (sig !== this.sig) {
            this.sig = sig;
            for (const r of this.repos) { r.load(); }
            this.research = this.loadResearch();
            this.emitter.fire();
        }
    }

    /** Reload now, after the extension itself wrote something. */
    refresh(rescan = false): void {
        if (rescan) { this.scan(); }
        else {
            for (const r of this.repos) { r.load(); }
            this.sig = this.signature();
        }
        this.emitter.fire();
    }

    repo(root: string): FlowRepo | undefined {
        return this.repos.find(r => r.root === root);
    }

    /** The files and hunks of a round, from git; cached, since a round's commits never change. */
    roundDiff(repo: FlowRepo, round: Round): Promise<FileDiff[]> {
        const key = `${repo.root}|${round.base}|${round.head}`;
        let p = this.diffCache.get(key);
        if (!p) {
            p = git(repo.root, diffArgs(round.base, round.head)).then(parseDiff);
            p.catch(() => this.diffCache.delete(key));
            this.diffCache.set(key, p);
        }
        return p;
    }
}
