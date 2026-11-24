# LunaticFlow

Coding agents work in batches; LunaticFlow lets you review each batch the way you review a colleague's pull request.
An agent plans its task as a graph of sprints, finishes one sprint, and hands it over.
You review the sprint in VS Code's own diff editor, in the changed files: approve or reject each change, or comment on a line.
The agent revises, and you see only what changed since your review.
A sprint is done only when you approve every change and no thread is open; then the agent moves on to the next one.

LunaticFlow also keeps the two features it grew out of: tab groups and Markdown review comments.

## Sprints

### The loop

1. **Plan.** The agent splits the task into sprints with `lf plan add`, each with a goal, a scope (the paths it touches) and its dependencies.
   Each path through the graph runs serially; separate paths run in parallel, usually as separate agents in their own clones.
2. **Work.** The agent runs `lf start <sprint>`, commits as it goes, and hands the sprint over with `lf submit`.
   It then waits in `lf await`, which returns when you send your review.
3. **Review.** The sprint shows up in the **Flow** view with a 👁 and a notification.
   Click it to open the first file's diff.
   Above each change are **Approve**, **Reject** and **Comment**; the gutter **+** comments on any line.
   **Approve File** (editor title) approves the rest of a file and moves to the next.
   **Send Review** sends everything at once.
4. **Revise.** The agent's `lf revert-rejected` undoes rejected changes exactly; it answers each thread with `lf reply` and submits round 2.
   Round 2 shows only what changed since round 1, with your comments carried to their new lines and the agent's replies in the threads.
   Resolve the threads you are happy with, and approve or comment again.

### The Flow view

- **Repositories** with a `.lunaticflow/` plan, from the workspace (two folder levels deep, so `projects/sift` counts) and from `lunaticflow.agentRoots` (agents' clones; shown with a robot icon).
- **Sprints** in dependency order, with their state: ready, waiting on dependencies, agent working, **waiting for you**, agent revising, approved.
- Under a sprint in review: its **files and hunks**, each with inline ✓ ✗ 💬, and its **threads**.
- **Agents:** Claude Code sessions and their subagents, from the plugin's hooks; click one to open its session.
  **Research agents** started by `tools/agents/spawn.sh` are listed from `briefing-room/registry.tsv`.
- **Review Next Sprint** (👁 in the title bar or the status bar) opens the waiting sprint that unblocks the most downstream work.
- **Show Plan Graph and Timeline** draws the dependency graph (critical path in thick arrows) and a timeline in which time spent waiting for your review is red.

If an agent is not blocked in `lf await` when you send a review, LunaticFlow offers to open its Claude Code session with a prompt filled in.

### Setting up an agent

1. Install the Claude Code plugin, which carries the `lunaticflow` skill, the `lf` CLI and the hooks:
   ```
   /plugin install lunaticflow --marketplace mahyarsamani/tab-groups
   ```
   For a local clone: `/plugin marketplace add /path/to/this/repo`, then `/plugin install lunaticflow@lunaticflow`.
2. Optionally, **LunaticFlow: Install the lf CLI for Agents** puts `lf` in `~/.local/bin` for use in a terminal.
3. In a repository, ask the agent to plan the task as LunaticFlow sprints.

The plugin's hooks do three things:
- They record sessions and subagents, so the Flow view shows who is working.
- They tie a sprint to the session that ran `lf start`.
- A Stop hook keeps that session from ending its turn while its sprint is unfinished or nobody is waiting for its review.

### Where the state lives

Everything is in `<repo>/.lunaticflow/`, which `lf init` adds to `.git/info/exclude`:
`plan.json` (the sprints and their dependencies), `sprints/<id>.json` (rounds, decisions, threads) and `agents/<id>.json` (sessions and subagents).
The agent and the extension read and write the same files; the reviewer sees committed snapshots only, so a round never changes under you.

## Tab Groups

Organize your VS Code open files into named, color-coded groups — just like Chrome tab groups — and review Markdown files by leaving comments right on the rendered preview.

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
| `lunaticflow.agentRoots` | `["/scr/msamani/agents"]` | Folders holding agents' clones; their plans appear in the Flow view |
| `lunaticflow.scanDepth` | `2` | Folder levels searched for `.lunaticflow/` plans |
| `lunaticflow.notify` | `true` | Notify when a sprint is handed over for review |
| `lunaticflow.reviewerName` | `"You"` | Your name on review comments |
| `diffEditor.codeLens` | `false` | VS Code's own setting; LunaticFlow offers to turn it on so Approve / Reject / Comment show above each change |
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
npm test          # compile, the TypeScript unit tests, and the lf CLI tests (needs python3 and git)
npx @vscode/vsce package
```

`cli/lf.py` is the source of the CLI; `claude-plugin/bin/lf.py` is a copy the plugin ships (`npm run sync-plugin` refreshes it, and the tests fail if the two differ).
The hunk keys that tie a review to the agent's commits are computed the same way in `src/flow/diff.ts` and `cli/lf.py`, and a test checks that they agree.
