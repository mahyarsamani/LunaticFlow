import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    TabGroupsProvider, TabGroupItem, TabFileItem,
    COLOR_EMOJI, COLOR_MAP, tabUri, openFilePaths,
} from './tabGroupsProvider';
import { TabGroupsStorage } from './tabGroupsStorage';
import { activateReview } from './review';
import { activateFlow } from './flow';

export function activate(context: vscode.ExtensionContext) {
    try {
        activateFlow(context);
    } catch (e) {
        // Keep tab groups and Markdown review working even if the Flow view fails to start.
        vscode.window.showErrorMessage(`LunaticFlow: the Flow view failed to start: ${e instanceof Error ? e.message : e}`);
    }
    const review = activateReview(context);
    const storage = new TabGroupsStorage(context);
    const provider = new TabGroupsProvider(storage, review.store);

    // Register the tree data provider
    const treeView = vscode.window.createTreeView('tabGroupsView', {
        treeDataProvider: provider,
        showCollapseAll: true,
        dragAndDropController: provider,
        canSelectMany: true,
    });

    context.subscriptions.push(
        treeView,
        treeView.onDidCollapseElement(e => {
            if (e.element instanceof TabGroupItem) { storage.setCollapsed(e.element.groupId, true); }
        }),
        treeView.onDidExpandElement(e => {
            if (e.element instanceof TabGroupItem) { storage.setCollapsed(e.element.groupId, false); }
        }),
    );

    // ── Status bar: the current group, click to switch ─────────────────────
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tabGroups.switchToGroupPick';
    context.subscriptions.push(statusBar);

    function updateStatusBar() {
        const groups = storage.getAllGroups();
        const show = vscode.workspace.getConfiguration('tabGroupsPro').get<boolean>('showStatusBar', true);
        if (!show || groups.length === 0) {
            statusBar.hide();
            return;
        }
        const activeId = storage.getActiveGroupId();
        const active = activeId ? storage.getGroup(activeId) : undefined;
        statusBar.text = active ? `$(layers-active) ${active.name}` : '$(layers) Tab Groups';
        statusBar.color = active ? COLOR_MAP[active.color] : undefined;
        statusBar.tooltip = active
            ? `Current tab group: ${active.name} (click to switch)`
            : 'Switch to a tab group';
        statusBar.show();
    }

    function refreshAll() {
        provider.refresh();
        updateStatusBar();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** The file in the active editor tab, including non-text editors like images. */
    function activeFileUri(): vscode.Uri | undefined {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const uri = tab ? tabUri(tab) : vscode.window.activeTextEditor?.document.uri;
        return uri?.scheme === 'file' ? uri : undefined;
    }

    /** Open files as regular (non-preview) tabs. Returns the paths that no longer exist. */
    async function openFiles(filePaths: string[]): Promise<string[]> {
        const missing: string[] = [];
        let first: vscode.Uri | undefined;
        for (const filePath of filePaths) {
            if (!fs.existsSync(filePath)) {
                missing.push(filePath);
                continue;
            }
            const uri = vscode.Uri.file(filePath);
            first ??= uri;
            try {
                await vscode.commands.executeCommand('vscode.open', uri, { preview: false, preserveFocus: true });
            } catch {
                missing.push(filePath);
            }
        }
        if (first) {
            await vscode.commands.executeCommand('vscode.open', first, { preview: false, preserveFocus: false });
        }
        if (missing.length) {
            vscode.window.showWarningMessage(
                `Could not open ${missing.length} file(s): ${missing.map(p => path.basename(p)).join(', ')}`
            );
        }
        return missing;
    }

    function tabsFor(filePaths: Set<string>, filter: (tab: vscode.Tab) => boolean = () => true): vscode.Tab[] {
        const tabs: vscode.Tab[] = [];
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                const uri = tabUri(tab);
                if (uri?.scheme === 'file' && filePaths.has(uri.fsPath) && filter(tab)) { tabs.push(tab); }
            }
        }
        return tabs;
    }

    async function promptNewGroup(prompt = 'Group name', placeHolder = 'e.g. Feature Work, Bug Fixes, Research...') {
        const name = await vscode.window.showInputBox({
            prompt,
            placeHolder,
            validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) { return undefined; }
        const color = await pickColor();
        return storage.createGroup(name.trim(), color ?? 'blue');
    }

    /** Ask which group to use, offering to create one. */
    async function pickGroup(placeHolder: string): Promise<string | undefined> {
        const NEW = '__new__';
        const picks: (vscode.QuickPickItem & { groupId: string })[] = [
            ...storage.getAllGroups().map(g => ({
                label: `${COLOR_EMOJI[g.color] ?? '🔵'} ${g.name}`,
                description: `${g.files.length} file(s)`,
                groupId: g.id,
            })),
            { label: '$(add) New group…', groupId: NEW },
        ];
        const selected = await vscode.window.showQuickPick(picks, { placeHolder });
        if (!selected) { return undefined; }
        return selected.groupId === NEW ? promptNewGroup() : selected.groupId;
    }

    async function switchToGroup(groupId: string) {
        const group = storage.getGroup(groupId);
        if (!group) { return; }
        if (group.files.length === 0) {
            vscode.window.showWarningMessage(`"${group.name}" has no files yet. Add some before switching to it.`);
            return;
        }
        await openFiles(group.files);
        if (vscode.workspace.getConfiguration('tabGroupsPro').get<boolean>('switchClosesOtherTabs', true)) {
            const keep = new Set(group.files);
            const others = new Set([...openFilePaths()].filter(p => !keep.has(p)));
            const toClose = tabsFor(others, tab => !tab.isDirty && !tab.isPinned);
            if (toClose.length) { await vscode.window.tabGroups.close(toClose, true); }
        }
        storage.setActiveGroupId(groupId);
        refreshAll();
    }

    // ── Command: Create a new group ─────────────────────────────────────────
    const createGroup = vscode.commands.registerCommand('tabGroups.createGroup', async () => {
        if (await promptNewGroup()) { refreshAll(); }
    });

    // ── Command: Rename group ───────────────────────────────────────────────
    const renameGroup = vscode.commands.registerCommand('tabGroups.renameGroup', async (item: TabGroupItem) => {
        const group = storage.getGroup(item.groupId);
        if (!group) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'New group name',
            value: group.name,
            validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) { return; }

        storage.renameGroup(item.groupId, name.trim());
        refreshAll();
    });

    // ── Command: Delete group ───────────────────────────────────────────────
    const deleteGroup = vscode.commands.registerCommand('tabGroups.deleteGroup', async (item: TabGroupItem) => {
        const group = storage.getGroup(item.groupId);
        if (!group) { return; }

        const answer = await vscode.window.showWarningMessage(
            `Delete group "${group.name}"? Files won't be closed.`,
            { modal: true },
            'Delete'
        );
        if (answer !== 'Delete') { return; }

        storage.deleteGroup(item.groupId);
        refreshAll();
    });

    // ── Command: Add file(s) to a group (pick group) ───────────────────────
    // From the Explorer or a tab's context menu this gets the clicked file(s);
    // from the Command Palette it uses the active editor.
    const addActiveFile = vscode.commands.registerCommand(
        'tabGroups.addActiveFile',
        async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            const targets = (uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : [activeFileUri()])
                .filter((u): u is vscode.Uri => !!u && u.scheme === 'file');
            if (targets.length === 0) {
                vscode.window.showWarningMessage('No file to add.');
                return;
            }

            const label = targets.length === 1 ? `"${path.basename(targets[0].fsPath)}"` : `${targets.length} files`;
            const groupId = await pickGroup(`Add ${label} to which group?`);
            if (!groupId) { return; }

            storage.addFilesToGroup(groupId, targets.map(u => u.fsPath));
            refreshAll();
            vscode.window.setStatusBarMessage(`Added ${label} to "${storage.getGroup(groupId)?.name}"`, 3000);
        }
    );

    // ── Command: Add active file to a specific group (from tree context) ───
    const addActiveFileToGroup = vscode.commands.registerCommand(
        'tabGroups.addActiveFileToGroup',
        async (item: TabGroupItem) => {
            const uri = activeFileUri();
            if (!uri) {
                vscode.window.showWarningMessage('No active file to add.');
                return;
            }
            storage.addFileToGroup(item.groupId, uri.fsPath);
            refreshAll();
        }
    );

    // ── Command: Add every open tab to a specific group ────────────────────
    const addOpenTabsToGroup = vscode.commands.registerCommand(
        'tabGroups.addOpenTabsToGroup',
        async (item: TabGroupItem) => {
            const open = [...openFilePaths()];
            if (open.length === 0) {
                vscode.window.showWarningMessage('No open files to add.');
                return;
            }
            storage.addFilesToGroup(item.groupId, open);
            refreshAll();
        }
    );

    // ── Command: Open all files in group ───────────────────────────────────
    const openAllInGroup = vscode.commands.registerCommand(
        'tabGroups.openAllInGroup',
        async (item: TabGroupItem) => {
            const group = storage.getGroup(item.groupId);
            if (!group) { return; }
            await openFiles(group.files);
        }
    );

    // ── Command: Close all files in group ──────────────────────────────────
    const closeAllInGroup = vscode.commands.registerCommand(
        'tabGroups.closeAllInGroup',
        async (item: TabGroupItem) => {
            const group = storage.getGroup(item.groupId);
            if (!group) { return; }
            const tabs = tabsFor(new Set(group.files));
            if (tabs.length) { await vscode.window.tabGroups.close(tabs); }
        }
    );

    // ── Command: Switch to a group (open its files, close the rest) ────────
    const switchToGroupCmd = vscode.commands.registerCommand(
        'tabGroups.switchToGroup',
        (item: TabGroupItem) => switchToGroup(item.groupId)
    );

    const switchToGroupPick = vscode.commands.registerCommand('tabGroups.switchToGroupPick', async () => {
        const groups = storage.getAllGroups();
        if (groups.length === 0) {
            const create = await vscode.window.showInformationMessage('No tab groups yet.', 'Create Group');
            if (create) { vscode.commands.executeCommand('tabGroups.createGroup'); }
            return;
        }
        const activeId = storage.getActiveGroupId();
        const open = openFilePaths();
        const selected = await vscode.window.showQuickPick(
            groups.map(g => ({
                label: `${COLOR_EMOJI[g.color] ?? '🔵'} ${g.name}`,
                description: `${g.files.filter(f => open.has(f)).length}/${g.files.length} open${g.id === activeId ? ' · current' : ''}`,
                detail: g.files.slice(0, 6).map(f => path.basename(f)).join(', ') + (g.files.length > 6 ? ', …' : ''),
                groupId: g.id,
            })),
            { placeHolder: 'Switch to tab group', matchOnDetail: true }
        );
        if (selected) { await switchToGroup(selected.groupId); }
    });

    // ── Command: Remove file(s) from group ─────────────────────────────────
    const removeFileFromGroup = vscode.commands.registerCommand(
        'tabGroups.removeFileFromGroup',
        (item: TabFileItem, selection?: (TabGroupItem | TabFileItem)[]) => {
            const files = (selection?.length ? selection : [item])
                .filter((s): s is TabFileItem => s instanceof TabFileItem);
            for (const f of files) { storage.removeFileFromGroup(f.groupId, f.filePath); }
            refreshAll();
        }
    );

    // ── Command: Open a file ───────────────────────────────────────────────
    const openFile = vscode.commands.registerCommand(
        'tabGroups.openFile',
        async (item: TabFileItem) => {
            if (!fs.existsSync(item.filePath)) {
                const answer = await vscode.window.showWarningMessage(
                    `${path.basename(item.filePath)} no longer exists.`, 'Remove from Group'
                );
                if (answer) {
                    storage.removeFileFromGroup(item.groupId, item.filePath);
                    refreshAll();
                }
                return;
            }
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(item.filePath), { preview: false });
        }
    );

    // ── Command: Set group color ───────────────────────────────────────────
    const setGroupColor = vscode.commands.registerCommand(
        'tabGroups.setGroupColor',
        async (item: TabGroupItem) => {
            const color = await pickColor();
            if (!color) { return; }
            storage.setGroupColor(item.groupId, color);
            refreshAll();
        }
    );

    // ── Command: Group all currently open tabs ─────────────────────────────
    const addCurrentFilesToNewGroup = vscode.commands.registerCommand(
        'tabGroups.addCurrentFilesToNewGroup',
        async () => {
            const openPaths = [...openFilePaths()];
            if (openPaths.length === 0) {
                vscode.window.showWarningMessage('No open files to group.');
                return;
            }

            const groupId = await promptNewGroup(`Group name for ${openPaths.length} open file(s)`, 'e.g. Current Work');
            if (!groupId) { return; }
            storage.addFilesToGroup(groupId, openPaths);
            storage.setActiveGroupId(groupId);
            refreshAll();
            vscode.window.setStatusBarMessage(
                `Created group "${storage.getGroup(groupId)?.name}" with ${openPaths.length} file(s)`, 3000
            );
        }
    );

    // ── Command: Copy review comments for every file in a group ────────────
    const copyGroupComments = vscode.commands.registerCommand(
        'tabGroups.copyGroupComments',
        async (item: TabGroupItem) => {
            const group = storage.getGroup(item.groupId);
            if (!group) { return; }
            const text = review.format(group.files.map(f => vscode.Uri.file(f)));
            await review.copyToClipboard(text, `in "${group.name}"`);
        }
    );

    // ── Command: Refresh tree ──────────────────────────────────────────────
    const refresh = vscode.commands.registerCommand('tabGroups.refresh', () => {
        refreshAll();
    });

    context.subscriptions.push(
        createGroup, renameGroup, deleteGroup,
        addActiveFile, addActiveFileToGroup, addOpenTabsToGroup,
        openAllInGroup, closeAllInGroup,
        switchToGroupCmd, switchToGroupPick,
        removeFileFromGroup, openFile,
        setGroupColor, addCurrentFilesToNewGroup,
        copyGroupComments, refresh
    );

    context.subscriptions.push(
        // Auto-refresh when tabs change so "open" badge is accurate
        vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
        // Comment counts shown next to files
        review.store.onDidChange(() => provider.refresh()),
        // Follow files and folders that are renamed or moved
        vscode.workspace.onDidRenameFiles(e => {
            let changed = false;
            for (const f of e.files) {
                if (f.oldUri.scheme === 'file') { changed = storage.renamePath(f.oldUri.fsPath, f.newUri.fsPath) || changed; }
            }
            if (changed) { refreshAll(); }
        }),
        // Deleted or restored files change the "missing" marker
        vscode.workspace.onDidDeleteFiles(() => provider.refresh()),
        vscode.workspace.onDidCreateFiles(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('tabGroupsPro')) { refreshAll(); }
        }),
    );

    updateStatusBar();

    // Exposed for integration tests.
    return { review, storage, switchToGroup };
}

/** Returns the chosen color, or undefined if the picker was dismissed. */
async function pickColor(): Promise<string | undefined> {
    const colors = [
        { label: '🔴  Red',    value: 'red'    },
        { label: '🟠  Orange', value: 'orange' },
        { label: '🟡  Yellow', value: 'yellow' },
        { label: '🟢  Green',  value: 'green'  },
        { label: '🔵  Blue',   value: 'blue'   },
        { label: '🟣  Purple', value: 'purple' },
        { label: '🩷  Pink',   value: 'pink'   },
        { label: '⚫  Grey',   value: 'grey'   },
    ];
    const picked = await vscode.window.showQuickPick(colors, {
        placeHolder: 'Pick a group color',
    });
    return picked?.value;
}

export function deactivate() {}
