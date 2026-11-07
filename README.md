# Tab Groups Pro

Organize your VS Code open files into named, color-coded groups — just like Chrome tab groups — and review Markdown files by leaving comments right on the rendered preview.

## Tab Groups

- **Create named groups** with a custom color (🔴🟠🟡🟢🔵🟣🩷⚫)
- **Switch between groups** — opens the group's files and closes the other tabs, like switching contexts. Tabs with unsaved changes and pinned tabs are kept. Use the ⇄ button on a group, the status bar, or `Cmd+Alt+G` / `Ctrl+Alt+G`.
- **Current group in the status bar** — click it to switch
- **Drag and drop** — move files between groups, reorder files within a group, reorder groups, drag files in from the Explorer or editor tabs, or drag them out onto the editor to open them
- **Open / Close all** files in a group at once (any file type, including images and notebooks)
- **Snapshot open tabs** — group all currently open files into a new group, or add them to an existing one
- **Add to group from anywhere** — right-click one or several files in the Explorer, or a tab's title
- **Follows renames** — files and folders renamed or moved inside VS Code stay in their groups; deleted files show a warning
- **Persistent across sessions** — groups and their collapsed state are saved per workspace
- **Live "open" badge** — see how many files in each group are currently open

## Markdown Review

Leave comments on a Markdown file from a rendered preview, then export them as a list:

```
@docs/design.md#12 : this needs a diagram; also cite the RFC
@docs/design.md#40 : typo in the table header
@README.md#3 : reword the intro
```

Each line is `@<path>#<source line> : <comment(s)>`. Several comments on the same line are joined with `; `.

1. Open a `.md` file and click **💬 Open Review Preview** in the editor title bar (or `Cmd+Alt+R` / `Ctrl+Alt+R`, or right-click the file in the Explorer or a tab group).
2. In the preview, hover any block and click the **+** in the left margin, or select text and click **💬 Comment**. `Cmd/Ctrl+Enter` saves, `Esc` cancels.
3. Copy or export from the preview's toolbar, the **Review Comments** panel in the Tab Groups sidebar, or a group's context menu (**Copy Review Comments for Group**).

Comments follow their lines as you edit the file and show as 💬 notes at the end of commented lines in the editor. They're saved in workspace state, so they stay out of your repository.

## Usage

1. Click the **Tab Groups** icon in the Activity Bar
2. Use **+** to create a new group, or use the **Group All Open Tabs** button
3. Right-click a group to switch to it, open/close all, add files, change color, rename, or delete
4. Drag files between groups in the sidebar

All commands are available via `Ctrl+Shift+P` → search "Tab Groups" or "Markdown Review".

## Settings

| Setting | Default | |
|---|---|---|
| `tabGroupsPro.showFileIcons` | `true` | Show file type icons in the groups panel |
| `tabGroupsPro.showFilePath` | `false` | Show workspace-relative paths instead of file names |
| `tabGroupsPro.switchClosesOtherTabs` | `true` | Close tabs outside the group when switching to it |
| `tabGroupsPro.showStatusBar` | `true` | Show the current group in the status bar |
| `mdReview.separator` | `"; "` | Joins several comments on one line |
| `mdReview.includeQuote` | `false` | Export `"selected text" comment` for selection comments |
| `mdReview.absolutePaths` | `false` | Export absolute paths instead of workspace-relative ones |

## Development

```bash
npm install
npm test          # compile + unit tests
npx @vscode/vsce package
```
