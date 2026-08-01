import * as vscode from 'vscode';
import * as path from 'path';
import { TabGroupsProvider, TabGroupItem, TabFileItem } from './tabGroupsProvider';
import { TabGroupsStorage, TabGroup } from './tabGroupsStorage';

export function activate(context: vscode.ExtensionContext) {
    const storage = new TabGroupsStorage(context);
    const provider = new TabGroupsProvider(storage);

    // Register the tree data provider
    const treeView = vscode.window.createTreeView('tabGroupsView', {
        treeDataProvider: provider,
        showCollapseAll: true,
        dragAndDropController: provider,
        canSelectMany: false,
    });

    context.subscriptions.push(treeView);

    // ── Command: Create a new group ─────────────────────────────────────────
    const createGroup = vscode.commands.registerCommand('tabGroups.createGroup', async () => {
        const name = await vscode.window.showInputBox({
            prompt: 'Group name',
            placeHolder: 'e.g. Feature Work, Bug Fixes, Research...',
            validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
        });
        if (!name) { return; }

        const color = await pickColor();
        storage.createGroup(name.trim(), color);
        provider.refresh();
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
        provider.refresh();
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
        provider.refresh();
    });

    // ── Command: Add active file (pick group) ──────────────────────────────
    const addActiveFile = vscode.commands.registerCommand('tabGroups.addActiveFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active file to add.');
            return;
        }

        const groups = storage.getAllGroups();
        if (groups.length === 0) {
            const create = await vscode.window.showWarningMessage(
                'No groups yet. Create one first?', 'Create Group'
            );
            if (create) {
                vscode.commands.executeCommand('tabGroups.createGroup');
            }
            return;
        }

        const picks = groups.map(g => ({
            label: `$(symbol-color) ${g.name}`,
            description: `${g.files.length} file(s)`,
            groupId: g.id,
        }));

        const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: 'Select a group to add the active file to',
        });
        if (!selected) { return; }

        storage.addFileToGroup(selected.groupId, editor.document.uri.fsPath);
        provider.refresh();
        vscode.window.showInformationMessage(
            `Added "${path.basename(editor.document.uri.fsPath)}" to group.`
        );
    });

    // ── Command: Add active file to a specific group (from tree context) ───
    const addActiveFileToGroup = vscode.commands.registerCommand(
        'tabGroups.addActiveFileToGroup',
        async (item: TabGroupItem) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active file to add.');
                return;
            }
            storage.addFileToGroup(item.groupId, editor.document.uri.fsPath);
            provider.refresh();
        }
    );

    // ── Command: Open all files in group ───────────────────────────────────
    const openAllInGroup = vscode.commands.registerCommand(
        'tabGroups.openAllInGroup',
        async (item: TabGroupItem) => {
            const group = storage.getGroup(item.groupId);
            if (!group) { return; }

            for (const filePath of group.files) {
                try {
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                } catch {
                    vscode.window.showWarningMessage(`Could not open: ${filePath}`);
                }
            }
        }
    );

    // ── Command: Close all files in group ──────────────────────────────────
    const closeAllInGroup = vscode.commands.registerCommand(
        'tabGroups.closeAllInGroup',
        async (item: TabGroupItem) => {
            const group = storage.getGroup(item.groupId);
            if (!group) { return; }

            const groupPaths = new Set(group.files);
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        if (groupPaths.has(tab.input.uri.fsPath)) {
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
            }
        }
    );

    // ── Command: Remove file from group ────────────────────────────────────
    const removeFileFromGroup = vscode.commands.registerCommand(
        'tabGroups.removeFileFromGroup',
        (item: TabFileItem) => {
            storage.removeFileFromGroup(item.groupId, item.filePath);
            provider.refresh();
        }
    );

    // ── Command: Open a file ───────────────────────────────────────────────
    const openFile = vscode.commands.registerCommand(
        'tabGroups.openFile',
        async (item: TabFileItem) => {
            try {
                const doc = await vscode.workspace.openTextDocument(item.filePath);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch {
                vscode.window.showErrorMessage(`Could not open: ${item.filePath}`);
            }
        }
    );

    // ── Command: Set group color ───────────────────────────────────────────
    const setGroupColor = vscode.commands.registerCommand(
        'tabGroups.setGroupColor',
        async (item: TabGroupItem) => {
            const color = await pickColor();
            if (!color) { return; }
            storage.setGroupColor(item.groupId, color);
            provider.refresh();
        }
    );

    // ── Command: Group all currently open tabs ─────────────────────────────
    const addCurrentFilesToNewGroup = vscode.commands.registerCommand(
        'tabGroups.addCurrentFilesToNewGroup',
        async () => {
            const openPaths: string[] = [];
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        openPaths.push(tab.input.uri.fsPath);
                    }
                }
            }

            if (openPaths.length === 0) {
                vscode.window.showWarningMessage('No open text files to group.');
                return;
            }

            const name = await vscode.window.showInputBox({
                prompt: `Group name for ${openPaths.length} open file(s)`,
                placeHolder: 'e.g. Current Work',
                validateInput: v => v.trim() ? undefined : 'Name cannot be empty',
            });
            if (!name) { return; }

            const color = await pickColor();
            const groupId = storage.createGroup(name.trim(), color);
            for (const p of openPaths) {
                storage.addFileToGroup(groupId, p);
            }
            provider.refresh();
            vscode.window.showInformationMessage(
                `Created group "${name}" with ${openPaths.length} file(s).`
            );
        }
    );

    // ── Command: Refresh tree ──────────────────────────────────────────────
    const refresh = vscode.commands.registerCommand('tabGroups.refresh', () => {
        provider.refresh();
    });

    context.subscriptions.push(
        createGroup, renameGroup, deleteGroup,
        addActiveFile, addActiveFileToGroup,
        openAllInGroup, closeAllInGroup,
        removeFileFromGroup, openFile,
        setGroupColor, addCurrentFilesToNewGroup,
        refresh
    );

    // Auto-refresh when tabs change so "open" badge is accurate
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh())
    );
}

async function pickColor(): Promise<string> {
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
        placeHolder: 'Pick a group color (optional)',
    });
    return picked?.value ?? 'blue';
}

export function deactivate() {}
