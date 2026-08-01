import * as vscode from 'vscode';

export interface TabGroup {
    id: string;
    name: string;
    color: string;
    files: string[];
    collapsed: boolean;
    createdAt: number;
}

const STORAGE_KEY = 'tabGroupsPro.groups';

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

    createGroup(name: string, color: string): string {
        const groups = this.getAllGroups();
        const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        groups.push({ id, name, color, files: [], collapsed: false, createdAt: Date.now() });
        this.save(groups);
        return id;
    }

    renameGroup(id: string, name: string): void {
        const groups = this.getAllGroups();
        const g = groups.find(g => g.id === id);
        if (g) { g.name = name; }
        this.save(groups);
    }

    deleteGroup(id: string): void {
        this.save(this.getAllGroups().filter(g => g.id !== id));
    }

    setGroupColor(id: string, color: string): void {
        const groups = this.getAllGroups();
        const g = groups.find(g => g.id === id);
        if (g) { g.color = color; }
        this.save(groups);
    }

    addFileToGroup(groupId: string, filePath: string): void {
        const groups = this.getAllGroups();
        const g = groups.find(g => g.id === groupId);
        if (g && !g.files.includes(filePath)) {
            g.files.push(filePath);
        }
        this.save(groups);
    }

    removeFileFromGroup(groupId: string, filePath: string): void {
        const groups = this.getAllGroups();
        const g = groups.find(g => g.id === groupId);
        if (g) { g.files = g.files.filter(f => f !== filePath); }
        this.save(groups);
    }

    moveFileBetweenGroups(fromGroupId: string, toGroupId: string, filePath: string): void {
        this.removeFileFromGroup(fromGroupId, filePath);
        this.addFileToGroup(toGroupId, filePath);
    }

    reorderGroups(orderedIds: string[]): void {
        const groups = this.getAllGroups();
        const grouped = new Map(groups.map(g => [g.id, g]));
        const reordered: TabGroup[] = [];
        for (const id of orderedIds) {
            const g = grouped.get(id);
            if (g) { reordered.push(g); }
        }
        // Append any that weren't in the ordered list
        for (const g of groups) {
            if (!orderedIds.includes(g.id)) { reordered.push(g); }
        }
        this.save(reordered);
    }
}
