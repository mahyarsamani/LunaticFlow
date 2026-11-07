import * as vscode from 'vscode';
import * as path from 'path';
import { renamedPath } from './review/format';

export interface TabGroup {
    id: string;
    name: string;
    color: string;
    files: string[];
    collapsed: boolean;
    createdAt: number;
}

const STORAGE_KEY = 'tabGroupsPro.groups';
const ACTIVE_KEY = 'tabGroupsPro.activeGroup';

export class TabGroupsStorage {
    private ctx: vscode.ExtensionContext;

    constructor(ctx: vscode.ExtensionContext) {
        this.ctx = ctx;
    }

    getAllGroups(): TabGroup[] {
        return this.ctx.workspaceState.get<TabGroup[]>(STORAGE_KEY) ?? [];
    }

    getGroup(id: string): TabGroup | undefined {
        return this.getAllGroups().find(g => g.id === id);
    }

    private save(groups: TabGroup[]): void {
        this.ctx.workspaceState.update(STORAGE_KEY, groups);
    }

    /** Apply `fn` to one group and save. */
    private edit(id: string, fn: (g: TabGroup) => void): void {
        const groups = this.getAllGroups();
        const g = groups.find(g => g.id === id);
        if (g) { fn(g); }
        this.save(groups);
    }

    /** The group last switched to, shown in the status bar. */
    getActiveGroupId(): string | undefined {
        const id = this.ctx.workspaceState.get<string>(ACTIVE_KEY);
        return id && this.getGroup(id) ? id : undefined;
    }

    setActiveGroupId(id: string | undefined): void {
        this.ctx.workspaceState.update(ACTIVE_KEY, id);
    }

    createGroup(name: string, color: string): string {
        const groups = this.getAllGroups();
        const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        groups.push({ id, name, color, files: [], collapsed: false, createdAt: Date.now() });
        this.save(groups);
        return id;
    }

    renameGroup(id: string, name: string): void {
        this.edit(id, g => { g.name = name; });
    }

    deleteGroup(id: string): void {
        this.save(this.getAllGroups().filter(g => g.id !== id));
        if (this.ctx.workspaceState.get<string>(ACTIVE_KEY) === id) { this.setActiveGroupId(undefined); }
    }

    setGroupColor(id: string, color: string): void {
        this.edit(id, g => { g.color = color; });
    }

    setCollapsed(id: string, collapsed: boolean): void {
        this.edit(id, g => { g.collapsed = collapsed; });
    }

    /** Add files to a group, skipping ones already in it. Inserts before `beforePath` when given. */
    addFilesToGroup(groupId: string, filePaths: string[], beforePath?: string): void {
        this.edit(groupId, g => {
            const fresh = filePaths.filter((p, i) => !g.files.includes(p) && filePaths.indexOf(p) === i);
            const at = beforePath ? g.files.indexOf(beforePath) : -1;
            g.files.splice(at === -1 ? g.files.length : at, 0, ...fresh);
        });
    }

    addFileToGroup(groupId: string, filePath: string): void {
        this.addFilesToGroup(groupId, [filePath]);
    }

    removeFileFromGroup(groupId: string, filePath: string): void {
        this.edit(groupId, g => { g.files = g.files.filter(f => f !== filePath); });
    }

    /**
     * Move a file into a group (possibly the same one, to reorder it).
     * Inserts before `beforePath` when given, else appends.
     */
    moveFile(filePath: string, fromGroupId: string, toGroupId: string, beforePath?: string): void {
        if (filePath === beforePath) { return; }
        const groups = this.getAllGroups();
        const from = groups.find(g => g.id === fromGroupId);
        const to = groups.find(g => g.id === toGroupId);
        if (!from || !to) { return; }
        from.files = from.files.filter(f => f !== filePath);
        to.files = to.files.filter(f => f !== filePath);
        const at = beforePath ? to.files.indexOf(beforePath) : -1;
        to.files.splice(at === -1 ? to.files.length : at, 0, filePath);
        this.save(groups);
    }

    /** Move groups so they sit just before `beforeId` (or at the end). */
    moveGroups(ids: string[], beforeId?: string): void {
        const groups = this.getAllGroups();
        const moving = groups.filter(g => ids.includes(g.id));
        if (beforeId && ids.includes(beforeId)) { return; }
        const rest = groups.filter(g => !ids.includes(g.id));
        const at = beforeId ? rest.findIndex(g => g.id === beforeId) : -1;
        rest.splice(at === -1 ? rest.length : at, 0, ...moving);
        this.save(rest);
    }

    /** Follow a renamed or moved file or folder. Returns whether any group changed. */
    renamePath(oldPath: string, newPath: string): boolean {
        const groups = this.getAllGroups();
        let changed = false;
        for (const g of groups) {
            g.files = g.files.map(f => {
                const next = renamedPath(f, oldPath, newPath, path.sep);
                if (next === undefined) { return f; }
                changed = true;
                return next;
            });
            g.files = g.files.filter((f, i) => g.files.indexOf(f) === i);
        }
        if (changed) { this.save(groups); }
        return changed;
    }
}
