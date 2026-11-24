// The agent playground: the base directory where agents make their clones and write files.
// The setting lives in VS Code (user, remote or workspace level); the lf CLI cannot read VS Code
// settings, so the effective value is mirrored to ~/.config/lunaticflow/config.json on the host
// the extension runs on, per workspace folder.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function writeJsonAtomic(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** Expand ~, ${userHome} and ${env:NAME} in a configured path. */
export function expandPath(p: string): string {
    let out = p.trim()
        .replace(/\$\{userHome\}/g, os.homedir())
        .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? '');
    if (out === '~' || out.startsWith('~/')) { out = path.join(os.homedir(), out.slice(1)); }
    return out;
}

/** The playground for a workspace folder (its own override, else the user or remote value), or for none. */
export function playgroundFor(folder?: vscode.WorkspaceFolder): string | undefined {
    const v = vscode.workspace.getConfiguration('lunaticflow', folder?.uri).get<string>('agentPlayground', '');
    return v ? expandPath(v) : undefined;
}

export function configFile(): string {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'lunaticflow', 'config.json');
}

/**
 * Mirror the playground to the CLI's config file: a default, and one entry per workspace folder
 * whose value differs. Entries other windows wrote for other folders are kept.
 */
export function syncPlaygroundConfig(): void {
    const file = configFile();
    let cfg: { agentPlayground?: string; workspaces?: Record<string, string> } = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
    const user = vscode.workspace.getConfiguration('lunaticflow').inspect<string>('agentPlayground');
    const global = user?.globalValue ? expandPath(user.globalValue) : undefined;
    const next = { ...cfg, workspaces: { ...(cfg.workspaces ?? {}) } };
    if (global) { next.agentPlayground = global; } else { delete next.agentPlayground; }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        if (f.uri.scheme !== 'file') { continue; }
        const v = playgroundFor(f);
        if (v && v !== global) { next.workspaces[f.uri.fsPath] = v; }
        else { delete next.workspaces[f.uri.fsPath]; }
    }
    if (JSON.stringify(next) === JSON.stringify(cfg)) { return; }
    try {
        writeJsonAtomic(file, next);
    } catch (e) {
        void vscode.window.showWarningMessage(`LunaticFlow could not write ${file}: ${e instanceof Error ? e.message : e}`);
    }
}
