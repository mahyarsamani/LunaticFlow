import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TabGroupsStorage, TabGroup } from './tabGroupsStorage';
import { CommentStore } from './review/commentStore';

// Color → ThemeIcon color map (VS Code theme colors)
export const COLOR_MAP: Record<string, vscode.ThemeColor> = {
    red:    new vscode.ThemeColor('charts.red'),
    orange: new vscode.ThemeColor('charts.orange'),
    yellow: new vscode.ThemeColor('charts.yellow'),
    green:  new vscode.ThemeColor('charts.green'),
    blue:   new vscode.ThemeColor('charts.blue'),
    purple: new vscode.ThemeColor('charts.purple'),
    pink:   new vscode.ThemeColor('terminal.ansiMagenta'),
    grey:   new vscode.ThemeColor('charts.foreground'),
};

// Color → emoji label prefix for accessibility
export const COLOR_EMOJI: Record<string, string> = {
    red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢',
    blue: '🔵', purple: '🟣', pink: '🩷', grey: '⚫',
};

/** The file a tab shows, for every tab kind that has one. */
export function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;
    if (input instanceof vscode.TabInputText
        || input instanceof vscode.TabInputCustom
        || input instanceof vscode.TabInputNotebook) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
        return input.modified;
    }
    return undefined;
}

/** Paths of files currently open in any tab. */
export function openFilePaths(): Set<string> {
    const paths = new Set<string>();
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            const uri = tabUri(tab);
            if (uri?.scheme === 'file') { paths.add(uri.fsPath); }
        }
    }
    return paths;
}

// ─── Tree Items ──────────────────────────────────────────────────────────────

export class TabGroupItem extends vscode.TreeItem {
    constructor(
        public readonly group: TabGroup,
        public readonly groupId: string,
        openCount: number,
        isActive: boolean,
    ) {
        super(
            `${COLOR_EMOJI[group.color] ?? '🔵'} ${group.name}`,
            group.collapsed
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded,
        );
        this.id = group.id;

        const total = group.files.length;
        const counts = total === 0 ? 'empty' : `${openCount}/${total} open`;
        this.description = isActive ? `${counts} · current` : counts;

        this.tooltip = new vscode.MarkdownString(
            `**${group.name}**${isActive ? ' (current)' : ''}\n\n${total} file(s) · ${openCount} open`
        );
        this.contextValue = 'group';
        this.iconPath = new vscode.ThemeIcon(
            isActive ? 'layers-active' : 'layers',
            COLOR_MAP[group.color] ?? COLOR_MAP['blue']
        );
    }
}

export interface FileDisplayOptions {
    showFileIcons: boolean;
    showFilePath: boolean;
}

export class TabFileItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly groupId: string,
        public readonly isOpen: boolean,
        commentCount: number,
        display: FileDisplayOptions,
    ) {
        const uri = vscode.Uri.file(filePath);
        super(
            display.showFilePath ? vscode.workspace.asRelativePath(uri) : path.basename(filePath),
            vscode.TreeItemCollapsibleState.None,
        );
        this.id = `${groupId}::${filePath}`;

        const missing = !fs.existsSync(filePath);
        if (display.showFileIcons && !missing) { this.resourceUri = uri; }
        if (missing) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        }

        const parts: string[] = [];
        if (missing) {
            parts.push('missing');
        } else if (isOpen) {
            parts.push('● open');
        } else if (!display.showFilePath) {
            parts.push(path.dirname(filePath).split(path.sep).slice(-2).join('/'));
        }
        if (commentCount) { parts.push(`💬 ${commentCount}`); }
        this.description = parts.join(' · ');

        this.tooltip = missing ? `${filePath}\n(file not found)` : filePath;
        this.contextValue = /\.(md|markdown)$/i.test(filePath) ? 'file-md' : 'file';
        this.command = {
            command: 'tabGroups.openFile',
            title: 'Open File',
            arguments: [this],
        };
    }
}

// ─── Provider ────────────────────────────────────────────────────────────────

const FILE_MIME = 'application/vnd.tabgroups.file';
const GROUP_MIME = 'application/vnd.tabgroups.group';

export class TabGroupsProvider
    implements
        vscode.TreeDataProvider<TabGroupItem | TabFileItem>,
        vscode.TreeDragAndDropController<TabGroupItem | TabFileItem>
{
    dropMimeTypes = [FILE_MIME, GROUP_MIME, 'text/uri-list'];
    dragMimeTypes = [FILE_MIME, GROUP_MIME, 'text/uri-list'];

    private _onDidChangeTreeData = new vscode.EventEmitter<
        TabGroupItem | TabFileItem | undefined | null | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** Cached set of currently open file paths */
    private openPaths: Set<string> = new Set();

    constructor(private storage: TabGroupsStorage, private comments?: CommentStore) {
        this.refreshOpenPaths();
    }

    refresh(): void {
        this.refreshOpenPaths();
        this._onDidChangeTreeData.fire();
    }

    private refreshOpenPaths(): void {
        this.openPaths = openFilePaths();
    }

    getTreeItem(element: TabGroupItem | TabFileItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TabGroupItem | TabFileItem): (TabGroupItem | TabFileItem)[] {
        if (!element) {
            const activeId = this.storage.getActiveGroupId();
            return this.storage.getAllGroups().map(g => {
                const openCount = g.files.filter(f => this.openPaths.has(f)).length;
                return new TabGroupItem(g, g.id, openCount, g.id === activeId);
            });
        }

        if (element instanceof TabGroupItem) {
            const group = this.storage.getGroup(element.groupId);
            if (!group) { return []; }
            const config = vscode.workspace.getConfiguration('tabGroupsPro');
            const display: FileDisplayOptions = {
                showFileIcons: config.get<boolean>('showFileIcons', true),
                showFilePath: config.get<boolean>('showFilePath', false),
            };
            return group.files.map(f => new TabFileItem(
                f,
                element.groupId,
                this.openPaths.has(f),
                this.comments?.count(vscode.Uri.file(f)) ?? 0,
                display,
            ));
        }

        return [];
    }

    getParent(element: TabGroupItem | TabFileItem): TabGroupItem | undefined {
        if (element instanceof TabFileItem) {
            const g = this.storage.getGroup(element.groupId);
            if (!g) { return undefined; }
            const openCount = g.files.filter(f => this.openPaths.has(f)).length;
            return new TabGroupItem(g, g.id, openCount, g.id === this.storage.getActiveGroupId());
        }
        return undefined;
    }

    // ── Drag ──────────────────────────────────────────────────────────────
    handleDrag(
        source: readonly (TabGroupItem | TabFileItem)[],
        dataTransfer: vscode.DataTransfer,
    ): void {
        const groups = source.filter((s): s is TabGroupItem => s instanceof TabGroupItem);
        if (groups.length > 0) {
            dataTransfer.set(GROUP_MIME, new vscode.DataTransferItem(JSON.stringify(groups.map(g => g.groupId))));
            return;
        }

        const files = source.filter((s): s is TabFileItem => s instanceof TabFileItem);
        if (files.length > 0) {
            dataTransfer.set(FILE_MIME, new vscode.DataTransferItem(
                JSON.stringify(files.map(s => ({ filePath: s.filePath, fromGroupId: s.groupId })))
            ));
            // Lets files be dropped onto the editor area to open them.
            dataTransfer.set('text/uri-list', new vscode.DataTransferItem(
                files.map(s => vscode.Uri.file(s.filePath).toString()).join('\r\n')
            ));
        }
    }

    // ── Drop ──────────────────────────────────────────────────────────────
    async handleDrop(
        target: TabGroupItem | TabFileItem | undefined,
        dataTransfer: vscode.DataTransfer,
    ): Promise<void> {
        // Reorder groups: drop onto a group (or one of its files) to place before it.
        const groupItem = dataTransfer.get(GROUP_MIME);
        if (groupItem) {
            const ids: string[] = JSON.parse(await groupItem.asString());
            this.storage.moveGroups(ids, target?.groupId);
            this.refresh();
            return;
        }

        if (!target) { return; }
        const targetGroupId = target.groupId;
        // Dropping onto a file inserts before it; onto a group appends.
        const beforePath = target instanceof TabFileItem ? target.filePath : undefined;

        // Files dragged within the panel: move between groups or reorder.
        const fileItem = dataTransfer.get(FILE_MIME);
        if (fileItem) {
            const files: { filePath: string; fromGroupId: string }[] = JSON.parse(await fileItem.asString());
            for (const { filePath, fromGroupId } of files) {
                this.storage.moveFile(filePath, fromGroupId, targetGroupId, beforePath);
            }
            this.refresh();
            return;
        }

        // Files dragged in from the Explorer or editor tabs.
        const uriItem = dataTransfer.get('text/uri-list');
        if (uriItem) {
            const paths: string[] = [];
            for (const line of (await uriItem.asString()).split(/\r?\n/)) {
                const l = line.trim();
                if (!l || l.startsWith('#')) { continue; }
                try {
                    const uri = vscode.Uri.parse(l);
                    if (uri.scheme === 'file') { paths.push(uri.fsPath); }
                } catch { /* skip invalid URIs */ }
            }
            this.storage.addFilesToGroup(targetGroupId, paths, beforePath);
            this.refresh();
        }
    }
}
