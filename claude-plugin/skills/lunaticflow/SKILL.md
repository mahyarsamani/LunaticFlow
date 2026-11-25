---
name: lunaticflow
description: Work in reviewed sprints with LunaticFlow. Use for any non-trivial code change in a repository that has a .lunaticflow/ directory, when the user asks to plan work as sprints, or when a prompt mentions LunaticFlow, `lf`, a sprint review, or a review that is in. Covers planning the sprint graph, starting, submitting, waiting for review, and answering it.
---

# Working in LunaticFlow sprints

The reviewer reads your work in VS Code, sprint by sprint, in the changed files: they approve or reject each change and comment on lines.
You do one sprint at a time and keep revising it until the reviewer approves it.
**A sprint is done only when the reviewer approves it**: every change approved and no open thread.
You never approve a sprint, resolve a thread, or edit `.lunaticflow/sprints/*.json` yourself.

The `lf` command is the agent's side of the protocol (`lf --help`).
If `lf` is not on the PATH, use `python3 "${CLAUDE_PLUGIN_ROOT}/bin/lf.py"` in its place.

## 1. Plan the work as a graph of sprints

1. `lf init` once per repository (it keeps `.lunaticflow/` out of git).
2. Split the task into sprints. A sprint has one coherent goal, includes its own tests, and is small enough to review in 15 to 30 minutes: roughly under 300 changed lines and a handful of hunks per file.
3. Add them with dependencies and the paths each one touches:
   ```
   lf plan add --id s1 --title "One gem5 line" --goal "..." --scope gem5/src/mem/ruby --estimate 2
   lf plan add --id s2 --title "DX100 scratchpad" --deps s1 --scope gem5/src/mem/dx100
   ```
   Each path through the graph runs serially; sprints on separate paths can run in parallel.
   Give parallel sprints disjoint scopes; they conflict where they meet otherwise.
4. Show the plan (`lf plan show`) and wait for the user's approval before starting, as the repository's CLAUDE.md asks.

Parallel paths are worked by separate agents, each in its own clone on its own `agent/<wp>` branch (see the repository's agent-branch rules).
Make the clone with `lf clone <wp> --submodules`: it lands in the agent playground (`lf playground` prints it, for example `/scr/msamani/agents/<wp>/<repo>`), takes submodules from the local checkout, keeps pushes going to the original remote, and is set up for sprints.
Files an agent writes outside its repository also go under `<playground>/<wp>/`.
One agent never works two sprints at once.

## 2. Do one sprint

1. `lf next` lists the sprints whose dependencies are approved; `lf start <id>` starts one at the current clean HEAD.
2. Work only toward the sprint's goal and inside its scope. Commit after each step that passes its own test, with the repository's commit conventions.
3. When the sprint is done and its tests pass, commit everything and hand it over:
   ```
   lf submit <id> --summary "what changed and why, in two or three sentences" --tests "what you ran and the result"
   ```
4. Wait for the review: run `lf await <id>` **in the background** (`run_in_background`), then end your turn.
   It exits when the reviewer sends the review and prints it.
   Do not change the sprint's files while it is in review.

## 3. Answer a review

`lf await` (or `lf show <id>`) prints either APPROVED or CHANGES REQUESTED.

On CHANGES REQUESTED:
1. `lf revert-rejected <id>` undoes the rejected changes exactly; commit that on its own (`review: revert rejected changes`).
2. Address every open thread: change the code, or explain why not. Answer each one with `lf reply <id> <thread> "..."`; say what you did and where.
3. Leave approved changes alone unless a comment requires touching them, and say so in the summary when you do.
4. Commit, then `lf submit <id> --summary "..."` (add `--no-changes` if the round only answers comments) and `lf await <id>` again.

On APPROVED: `lf next`, then start the next ready sprint.
When every sprint is approved, report to the user; a clone agent then pushes its `agent/<wp>` branch and opens a draft pull request if the repository's rules allow it.

## Rules

- Never claim a sprint is finished, merged or approved before `lf` says APPROVED.
- A Stop hook holds you to an unfinished sprint you started: finish and submit it, or wait for its review with `lf await`.
- If the review cannot be answered (a comment needs a decision only the user can make), reply on the thread, submit with `--no-changes`, and say so to the user.
