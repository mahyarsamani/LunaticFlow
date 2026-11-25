// The plan as a picture: the dependency graph and a timeline (Gantt) drawn with Mermaid.
import * as vscode from 'vscode';
import { FlowRepo, FlowStore } from './store';
import { Plan, SprintState, timeline, topoOrder } from './model';

/** Sprints that depend on `id`, directly or not. */
export function downstream(plan: Plan, id: string): Set<string> {
    const out = new Set<string>();
    const walk = (x: string) => {
        for (const s of plan.sprints) {
            if (s.deps.includes(x) && !out.has(s.id)) { out.add(s.id); walk(s.id); }
        }
    };
    walk(id);
    return out;
}

/** The chain of sprints that finishes last, following the dependency that finishes last at each step. */
export function criticalPath(plan: Plan, states: Map<string, SprintState>, now: number): string[] {
    const bars = timeline(plan, states, now);
    const end = new Map<string, number>();
    for (const b of bars) { end.set(b.sprint, Math.max(end.get(b.sprint) ?? 0, b.end)); }
    const byId = new Map(plan.sprints.map(s => [s.id, s]));
    let cur = [...end.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const path: string[] = [];
    while (cur && !path.includes(cur)) {
        path.unshift(cur);
        const deps = byId.get(cur)?.deps ?? [];
        cur = deps.sort((a, b) => (end.get(b) ?? 0) - (end.get(a) ?? 0))[0];
    }
    return path;
}

const esc = (s: string) => s.replace(/"/g, '#quot;').replace(/[<>]/g, ' ');
const safeId = (s: string) => 'n_' + s.replace(/[^A-Za-z0-9_]/g, '_');

export function mermaidGraph(repo: FlowRepo, now = Date.now()): string {
    const crit = new Set(criticalPath(repo.plan, repo.states, now));
    const lines = ['flowchart LR'];
    for (const s of topoOrder(repo.plan)) {
        const status = repo.sprintStatus(s.id);
        lines.push(`  ${safeId(s.id)}["<b>${esc(s.id)}</b> ${esc(s.title)}<br/><i>${status.replace('_', ' ')}</i>"]:::${status}`);
    }
    for (const s of repo.plan.sprints) {
        for (const d of s.deps) {
            lines.push(`  ${safeId(d)} ${crit.has(d) && crit.has(s.id) ? '==>' : '-->'} ${safeId(s.id)}`);
        }
    }
    lines.push(
        '  classDef planned fill:#2b2e36,stroke:#6b7280,color:#e5e7eb',
        '  classDef blocked fill:#1f2127,stroke:#4b5060,color:#9aa0ad,stroke-dasharray:4 3',
        '  classDef working fill:#1d3557,stroke:#4c9aff,color:#e5e7eb',
        '  classDef revising fill:#1d3557,stroke:#4c9aff,color:#e5e7eb',
        '  classDef in_review fill:#4a3b0b,stroke:#e3b341,color:#fff3c4,stroke-width:3px',
        '  classDef approved fill:#123b22,stroke:#3fb950,color:#d6f5dd',
    );
    return lines.join('\n');
}

export function mermaidGantt(repo: FlowRepo, now = Date.now()): string {
    const bars = timeline(repo.plan, repo.states, now);
    const lines = ['gantt', '  dateFormat x', '  axisFormat %b %d %H:%M', `  todayMarker on`];
    const titles = new Map(repo.plan.sprints.map(s => [s.id, s.title]));
    let i = 0;
    for (const s of topoOrder(repo.plan)) {
        const mine = bars.filter(b => b.sprint === s.id);
        if (!mine.length) { continue; }
        lines.push(`  section ${esc(s.id)} ${esc(titles.get(s.id) ?? '')}`.replace(/:/g, ' '));
        for (const b of mine) {
            const label = b.kind === 'working' ? 'agent' : b.kind === 'review' ? 'waiting for you' : 'planned';
            const tag = b.kind === 'review' ? 'crit, ' : b.kind === 'planned' ? '' : b.end >= now - 1000 ? 'active, ' : 'done, ';
            lines.push(`  ${label} :${tag}b${i++}, ${Math.round(b.start)}, ${Math.round(b.end)}`);
        }
    }
    return lines.join('\n');
}

export class PlanGraphPanel {
    private static panels = new Map<string, PlanGraphPanel>();
    private readonly sub: vscode.Disposable;

    static show(context: vscode.ExtensionContext, store: FlowStore, repo: FlowRepo) {
        const existing = PlanGraphPanel.panels.get(repo.root);
        if (existing) { existing.panel.reveal(); existing.update(); return; }
        const panel = vscode.window.createWebviewPanel('lunaticflow.plan', `Plan: ${repo.name}`, vscode.ViewColumn.Active, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        });
        PlanGraphPanel.panels.set(repo.root, new PlanGraphPanel(context, store, repo.root, panel));
    }

    private constructor(private readonly context: vscode.ExtensionContext, private readonly store: FlowStore,
                        private readonly root: string, readonly panel: vscode.WebviewPanel) {
        const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'mermaid.min.js'));
        const csp = `default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource} 'unsafe-inline';`;
        panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
 body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 18px}
 h2{font-size:14px;font-weight:600;margin:18px 0 6px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.06em}
 .legend{font-size:12px;color:var(--vscode-descriptionForeground)} .legend b{font-weight:600}
 .err{color:var(--vscode-errorForeground);white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}
 #graph svg,#gantt svg{max-width:100%;height:auto}
</style></head><body>
<h2>Dependency graph</h2>
<div class="legend">Each path runs serially; separate paths run in parallel. Thick arrows mark the critical path. <b>Yellow</b> sprints wait for you.</div>
<div id="graph"></div>
<h2>Timeline</h2>
<div class="legend">Agent time, time <b>waiting for your review</b> (red), and planned sprints after their dependencies.</div>
<div id="gantt"></div>
<script src="${script}"></script>
<script>
 const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
 mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', flowchart: { htmlLabels: true } });
 let n = 0;
 async function draw(id, text) {
   const el = document.getElementById(id);
   try { const { svg } = await mermaid.render(id + '-svg-' + (n++), text); el.innerHTML = svg; }
   catch (e) { el.innerHTML = '<div class="err"></div>'; el.firstChild.textContent = String(e && e.message || e) + '\\n\\n' + text; }
 }
 window.addEventListener('message', e => { draw('graph', e.data.graph); draw('gantt', e.data.gantt); });
 acquireVsCodeApi().postMessage({ ready: true });
</script></body></html>`;
        this.sub = vscode.Disposable.from(
            store.onDidChange(() => this.update()),
            panel.webview.onDidReceiveMessage((m: { ready?: boolean }) => { if (m?.ready) { this.update(); } }),
        );
        panel.onDidDispose(() => { this.sub.dispose(); PlanGraphPanel.panels.delete(root); });
    }

    update() {
        const repo = this.store.repo(this.root);
        if (!repo) { return; }
        void this.panel.webview.postMessage({ graph: mermaidGraph(repo), gantt: mermaidGantt(repo) });
    }
}
