import * as vscode from 'vscode';
import * as path from 'path';
import { TabGroupsStorage, TabGroup } from './tabGroupsStorage';

// Color → ThemeIcon color map (VS Code theme colors)
const COLOR_MAP: Record<string, vscode.ThemeColor> = {
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
const COLOR_EMOJI: Record<string, string> = {
    red: '🔴', orange: '🟠', yellow: '🟡', green: '🟢',
    blue: '🔵', purple: '🟣', pink: '🩷', grey: '⚫',
};

// ─── Tree Items ──────────────────────────────────────────────────────────────

export class TabGroupItem extends vscode.TreeItem {
    constructor(
        public readonly group: TabGroup,
        public readonly groupId: string,
        openCount: number,
    ) {
        super(
            `${COLOR_EMOJI[group.color] ?? '🔵'} ${group.name}`,
            vscode.TreeItemCollapsibleState.Expanded,
        );

        const total = group.files.length;
        this.description = total === 0
            ? 'empty'
            : `${openCount}/${total} open`;

        this.tooltip = new vscode.MarkdownString(
            `**${group.name}**\n\n${total} file(s) · ${openCount} open`
        );
        this.contextValue = 'group';
        this.iconPath = new vscode.ThemeIcon(
            'symbol-namespace',
            COLOR_MAP[group.color] ?? COLOR_MAP['blue']
        );
    }
}

export class TabFileItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly groupId: string,
        public readonly isOpen: boolean,
    ) {
        const fileName = path.basename(filePath);
        super(fileName, vscode.TreeItemCollapsibleState.None);

        this.resourceUri = vscode.Uri.file(filePath);
        this.tooltip = filePath;
        this.description = isOpen ? '● open' : path.dirname(filePath).split(path.sep).slice(-2).join('/');
        this.contextValue = 'file';
        this.command = {
            command: 'tabGroups.openFile',
            title: 'Open File',
            arguments: [this],
        };
    }
}

// ─── Provider ────────────────────────────────────────────────────────────────

const MIME_TYPE = 'application/vnd.tabgroups.file';

export class TabGroupsProvider
    implements
        vscode.TreeDataProvider<TabGroupItem | TabFileItem>,
        vscode.TreeDragAndDropController<TabGroupItem | TabFileItem>
{
    dropMimeTypes = [MIME_TYPE, 'text/uri-list'];
    dragMimeTypes = [MIME_TYPE];

    private _onDidChangeTreeData = new vscode.EventEmitter<
        TabGroupItem | TabFileItem | undefined | null | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** Cached set of currently open file paths */
    private openPaths: Set<string> = new Set();

    constructor(private storage: TabGroupsStorage) {
        this.refreshOpenPaths();
    }

    refresh(): void {
        this.refreshOpenPaths();
        this._onDidChangeTreeData.fire();
    }

    private refreshOpenPaths(): void {
        this.openPaths = new Set<string>();
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    this.openPaths.add(tab.input.uri.fsPath);
                }
            }
        }
    }

    getTreeItem(element: TabGroupItem | TabFileItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TabGroupItem | TabFileItem): (TabGroupItem | TabFileItem)[] {
        if (!element) {
            // Root: return all groups
            return this.storage.getAllGroups().map(g => {
                const openCount = g.files.filter(f => this.openPaths.has(f)).length;
                return new TabGroupItem(g, g.id, openCount);
            });
        }

        if (element instanceof TabGroupItem) {
            const group = this.storage.getGroup(element.groupId);
            if (!group) { return []; }
            return group.files.map(
                f => new TabFileItem(f, element.groupId, this.openPaths.has(f))
            );
        }

        return [];
    }

    // ── Drag ──────────────────────────────────────────────────────────────
    handleDrag(
        source: readonly (TabGroupItem | TabFileItem)[],
        dataTransfer: vscode.DataTransfer,
    ): void {
        const files = source
            .filter((s): s is TabFileItem => s instanceof TabFileItem)
            .map(s => ({ filePath: s.filePath, fromGroupId: s.groupId }));

        if (files.length > 0) {
            dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(files)));
        }
    }

    // ── Drop ──────────────────────────────────────────────────────────────
    async handleDrop(
        target: TabGroupItem | TabFileItem | undefined,
        dataTransfer: vscode.DataTransfer,
    ): Promise<void> {
        // Determine target group
        let targetGroupId: string | undefined;
        if (target instanceof TabGroupItem) {
            targetGroupId = target.groupId;
        } else if (target instanceof TabFileItem) {
            targetGroupId = target.groupId;
        }
        if (!targetGroupId) { return; }

        // Handle internal drag (our own MIME type)
        const internalItem = dataTransfer.get(MIME_TYPE);
        if (internalItem) {
            const files: { filePath: string; fromGroupId: string }[] =
                JSON.parse(await internalItem.asString());
            for (const { filePath, fromGroupId } of files) {
                if (fromGroupId !== targetGroupId) {
                    this.storage.moveFileBetweenGroups(fromGroupId, targetGroupId, filePath);
                }
            }
            this.refresh();
            return;
        }

        // Handle external drag (files from Explorer, text/uri-list)
        const uriItem = dataTransfer.get('text/uri-list');
        if (uriItem) {
            const uriText = await uriItem.asString();
            const uris = uriText
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0 && !l.startsWith('#'));
            for (const uriStr of uris) {
                try {
                    const uri = vscode.Uri.parse(uriStr);
                    this.storage.addFileToGroup(targetGroupId, uri.fsPath);
                } catch { /* skip invalid URIs */ }
            }
            this.refresh();
        }
    }
}
