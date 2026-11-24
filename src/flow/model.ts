// The LunaticFlow data model: plans, sprints, review rounds and threads.
// Pure: no dependency on the vscode module. cli/lf.py reads and writes the same JSON.
//
// Layout, in each repository (git-ignored through .git/info/exclude):
//   .lunaticflow/plan.json            the plan: sprints and their dependencies
//   .lunaticflow/sprints/<id>.json    one sprint's state, rounds, reviews and threads
//   .lunaticflow/agents/<id>.json     Claude Code sessions and subagents, written by hooks

import { FileDiff } from './diff';

export const FLOW_DIR = '.lunaticflow';
export const SCHEMA_VERSION = 1;

export interface PlanSprint {
    id: string;
    title: string;
    goal?: string;
    /** Sprints that must be approved before this one starts. */
    deps: string[];
    /** Paths the sprint expects to touch; used to warn about parallel branches that overlap. */
    scope?: string[];
    /** Rough agent hours, for the timeline of sprints not started yet. */
    estimateHours?: number;
    /** Which agent owns the sprint (a session name or a clone's work package). */
    agent?: string;
}

export interface Plan {
    version: number;
    title: string;
    created?: string;
    sprints: PlanSprint[];
}

export type SprintStatus = 'planned' | 'working' | 'in_review' | 'revising' | 'approved';
export type Decision = 'approved' | 'rejected';

export interface HunkDecision {
    path: string;
    decision: Decision;
    reason?: string;
}

export interface Review {
    submittedAt: string;
    decisions: Record<string, HunkDecision>;
    verdict: 'approved' | 'changes';
}

export interface Round {
    n: number;
    /** The diff of this round runs from `base` to `head`: the sprint's base for round 1, the last head after. */
    base: string;
    head: string;
    submittedAt: string;
    summary?: string;
    tests?: string;
    /** Decisions the reviewer has made but not sent yet. */
    draft?: Record<string, HunkDecision>;
    review?: Review;
}

export interface ThreadMessage {
    author: 'user' | 'agent';
    body: string;
    at: string;
    /** The round the message belongs to: a reply written while revising round n carries n + 1. */
    round: number;
}

export interface Thread {
    id: string;
    /** Round whose head the line refers to. */
    round: number;
    path: string;
    /** 1-based line in that round's head. */
    line: number;
    status: 'open' | 'resolved';
    /** False while the comment is still a draft the agent must not act on. */
    submitted: boolean;
    messages: ThreadMessage[];
}

export interface SprintState {
    version: number;
    id: string;
    status: SprintStatus;
    base?: string;
    branch?: string;
    sessionId?: string;
    startedAt?: string;
    approvedAt?: string;
    /** Set by `lf await` while an agent is blocked waiting for the review. */
    awaiting?: { pid: number; since: string } | null;
    rounds: Round[];
    threads: Thread[];
}

export interface AgentRecord {
    id: string;
    kind: 'session' | 'subagent';
    sessionId: string;
    parentSessionId?: string;
    agentType?: string;
    name?: string;
    cwd?: string;
    transcriptPath?: string;
    startedAt?: string;
    updatedAt?: string;
    endedAt?: string;
}

export function emptySprintState(id: string): SprintState {
    return { version: SCHEMA_VERSION, id, status: 'planned', rounds: [], threads: [] };
}

export function currentRound(s: SprintState): Round | undefined {
    return s.rounds[s.rounds.length - 1];
}

/** Sprints whose dependencies are all approved and that are not approved themselves. */
export function readySprints(plan: Plan, states: Map<string, SprintState>): PlanSprint[] {
    const approved = (id: string) => states.get(id)?.status === 'approved';
    return plan.sprints.filter(s => !approved(s.id) && s.deps.every(approved));
}

/** Dependencies first; ties keep the plan's order. Unknown dependencies are ignored. */
export function topoOrder(plan: Plan): PlanSprint[] {
    const byId = new Map(plan.sprints.map(s => [s.id, s]));
    const out: PlanSprint[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (s: PlanSprint) => {
        if (seen.has(s.id) || visiting.has(s.id)) { return; }
        visiting.add(s.id);
        for (const d of s.deps) {
            const dep = byId.get(d);
            if (dep) { visit(dep); }
        }
        visiting.delete(s.id);
        seen.add(s.id);
        out.push(s);
    };
    plan.sprints.forEach(visit);
    return out;
}

/** Problems with a plan: unknown dependencies, cycles, and parallel sprints whose scopes overlap. */
export function validatePlan(plan: Plan): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const s of plan.sprints) {
        if (ids.has(s.id)) { problems.push(`duplicate sprint id ${s.id}`); }
        ids.add(s.id);
    }
    for (const s of plan.sprints) {
        for (const d of s.deps) {
            if (!ids.has(d)) { problems.push(`${s.id} depends on unknown sprint ${d}`); }
        }
    }
    const ancestors = ancestorSets(plan);
    for (const [id, anc] of ancestors) {
        if (anc.has(id)) { problems.push(`${id} is part of a dependency cycle`); }
    }
    // Two sprints run in parallel when neither is an ancestor of the other.
    const list = plan.sprints;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) { continue; }
            const overlap = scopeOverlap(a.scope ?? [], b.scope ?? []);
            if (overlap.length) {
                problems.push(`${a.id} and ${b.id} can run in parallel but both touch ${overlap.join(', ')}`);
            }
        }
    }
    return problems;
}

function ancestorSets(plan: Plan): Map<string, Set<string>> {
    const byId = new Map(plan.sprints.map(s => [s.id, s]));
    const memo = new Map<string, Set<string>>();
    const walk = (id: string, stack: Set<string>): Set<string> => {
        if (memo.has(id)) { return memo.get(id)!; }
        const out = new Set<string>();
        if (stack.has(id)) { out.add(id); return out; }
        stack.add(id);
        for (const d of byId.get(id)?.deps ?? []) {
            out.add(d);
            for (const a of walk(d, stack)) { out.add(a); }
        }
        stack.delete(id);
        memo.set(id, out);
        return out;
    };
    for (const s of plan.sprints) { walk(s.id, new Set()); }
    return memo;
}

function scopeOverlap(a: string[], b: string[]): string[] {
    const norm = (p: string) => p.replace(/\/+$/, '');
    const out: string[] = [];
    for (const x of a.map(norm)) {
        for (const y of b.map(norm)) {
            if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) { out.push(x.length >= y.length ? x : y); }
        }
    }
    return [...new Set(out)];
}

export interface ReviewTally {
    total: number;
    approved: number;
    rejected: number;
    /** Hunks with no decision. */
    undecided: string[];
    /** Open threads, in any round, that are submitted or written in this round. */
    openThreads: Thread[];
}

export function tally(files: FileDiff[], decisions: Record<string, HunkDecision>, threads: Thread[]): ReviewTally {
    const t: ReviewTally = { total: 0, approved: 0, rejected: 0, undecided: [], openThreads: [] };
    for (const f of files) {
        for (const h of f.hunks) {
            t.total++;
            const d = decisions[h.key]?.decision;
            if (d === 'approved') { t.approved++; }
            else if (d === 'rejected') { t.rejected++; }
            else { t.undecided.push(h.key); }
        }
    }
    t.openThreads = threads.filter(th => th.status === 'open');
    return t;
}

/** A sprint is approved only when every change is approved and no thread is open. */
export function verdictOf(t: ReviewTally): 'approved' | 'changes' {
    return t.rejected === 0 && t.undecided.length === 0 && t.openThreads.length === 0 ? 'approved' : 'changes';
}

export interface TimelineBar {
    sprint: string;
    kind: 'working' | 'review' | 'planned';
    start: number;
    end: number;
}

/**
 * Bars for the timeline: agent time (working or revising) and time waiting for the reviewer,
 * from the recorded timestamps; sprints not started get a planned bar after their dependencies.
 */
export function timeline(plan: Plan, states: Map<string, SprintState>, now: number): TimelineBar[] {
    const bars: TimelineBar[] = [];
    const end = new Map<string, number>();
    const hour = 3600_000;
    for (const s of topoOrder(plan)) {
        const st = states.get(s.id);
        const t = (x?: string) => (x ? Date.parse(x) : NaN);
        if (st?.startedAt) {
            let cursor = t(st.startedAt);
            for (const r of st.rounds) {
                const sub = t(r.submittedAt);
                bars.push({ sprint: s.id, kind: 'working', start: cursor, end: sub });
                const rev = r.review ? t(r.review.submittedAt) : now;
                bars.push({ sprint: s.id, kind: 'review', start: sub, end: rev });
                cursor = rev;
            }
            if (st.status === 'working' || st.status === 'revising') {
                bars.push({ sprint: s.id, kind: 'working', start: cursor, end: now });
                cursor = now;
            }
            end.set(s.id, st.status === 'approved' ? t(st.approvedAt) || cursor : Math.max(cursor, now));
        } else {
            const start = Math.max(now, ...s.deps.map(d => end.get(d) ?? now));
            const stop = start + (s.estimateHours ?? 2) * hour;
            bars.push({ sprint: s.id, kind: 'planned', start, end: stop });
            end.set(s.id, stop);
        }
    }
    return bars.filter(b => b.end > b.start);
}
