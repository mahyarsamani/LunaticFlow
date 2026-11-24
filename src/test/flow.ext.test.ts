// Runs the Flow view, the review controller and the lf CLI together, with a stand-in for VS Code.
// Run with: npm test (plain Node, python3 and git needed)
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

const mockPath = path.join(__dirname, 'vscodeMock.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? mockPath : origResolve.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vs = require('./vscodeMock') as typeof import('./vscodeMock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activateFlow } = require('../flow') as typeof import('../flow');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRevUri } = require('../flow/review') as typeof import('../flow/review');

const extRoot = path.join(__dirname, '..', '..');
const LF = path.join(extRoot, 'cli', 'lf.py');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-ext-'));
const sh = (cmd: string, ...a: string[]) => execFileSync(cmd, a, { cwd: repo, encoding: 'utf8' });
const lf = (...a: string[]) => sh('python3', LF, ...a);
const stateOf = (id: string) => JSON.parse(fs.readFileSync(path.join(repo, '.lunaticflow', 'sprints', `${id}.json`), 'utf8'));
const tick = () => new Promise(r => setTimeout(r, 20));

async function main() {
    // An agent plans two sprints and hands the first over.
    sh('git', 'init', '-q', '-b', 'main');
    sh('git', 'config', 'user.email', 't@t');
    sh('git', 'config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.c'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(''));
    sh('git', 'add', '.');
    sh('git', 'commit', '-qm', 'base');
    lf('init', '--title', 'Demo plan');
    lf('plan', 'add', '--id', 's1', '--title', 'Counters', '--scope', 'src');
    lf('plan', 'add', '--id', 's2', '--title', 'Next', '--deps', 's1');
    lf('start', 's1');
    const text = fs.readFileSync(path.join(repo, 'src', 'a.c'), 'utf8').split('\n');
    text[4] = 'line 5 changed';
    text[30] = 'line 31 drive-by';
    fs.writeFileSync(path.join(repo, 'src', 'a.c'), text.join('\n'));
    fs.writeFileSync(path.join(repo, 'src', 'new.c'), 'int x;\n');
    sh('git', 'add', '.');
    sh('git', 'commit', '-qm', 's1');
    lf('submit', 's1', '--summary', 'counters');

    // The extension starts and finds the plan.
    vs.workspace.workspaceFolders = [{ uri: vs.Uri.file(repo) }];
    vs.mock.setConfig('lunaticflow.agentRoots', []);
    // The agent playground: the extension mirrors it for the CLI, and an agent clones into it.
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-cfg-'));
    const play = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-play-'));
    process.env.XDG_CONFIG_HOME = cfgHome;
    vs.mock.setConfig('lunaticflow.agentPlayground', play);
    vs.mock.setConfig('diffEditor.codeLens', true);
    const context: any = {
        subscriptions: [], extensionPath: extRoot, extensionUri: vs.Uri.file(extRoot),
        globalState: { get: () => true, update: async () => {} },
    };
    activateFlow(context);
    const mirrored = JSON.parse(fs.readFileSync(path.join(cfgHome, 'lunaticflow', 'config.json'), 'utf8'));
    assert.strictEqual(mirrored.agentPlayground, play);
    assert.strictEqual(execFileSync('python3', [LF, 'playground'], { cwd: repo, encoding: 'utf8', env: process.env }).trim(), play);
    const tree = vs.calls.trees.find(t => t.id === 'lunaticflowView');
    assert.ok(tree, 'the Flow view is created');
    let roots = await tree.treeDataProvider.getChildren();
    assert.strictEqual(roots.length, 1);

    // An agent clones the repository for a work package and plans there: the clone shows up too.
    execFileSync('python3', [LF, 'clone', 'wp1'], { cwd: repo, encoding: 'utf8', env: process.env });
    const clone = path.join(play, 'wp1', path.basename(repo));
    execFileSync('python3', [LF, 'plan', 'add', '--id', 'c1', '--title', 'In the clone'], { cwd: clone, encoding: 'utf8' });
    await vs.commands.executeCommand('lunaticflow.refresh');
    roots = await tree.treeDataProvider.getChildren();
    const cloneNode = roots.find((n: any) => n.repo?.root === clone);
    assert.ok(cloneNode, 'the playground clone appears in the Flow view');
    assert.strictEqual(cloneNode.repo.origin, 'agents');
    roots = roots.filter((n: any) => n.repo?.root === repo);
    const sprints = await tree.treeDataProvider.getChildren(roots[0]);
    const s1 = sprints.find((n: any) => n.sprint?.id === 's1');
    const s1Item = tree.treeDataProvider.getTreeItem(s1);
    assert.match(s1Item.description, /waiting for you/);
    assert.strictEqual(tree.badge?.value, 1);
    const files = await tree.treeDataProvider.getChildren(s1);
    assert.deepStrictEqual(files.map((f: any) => f.file.path).sort(), ['src/a.c', 'src/new.c']);

    // Opening the sprint shows the first file in the diff editor.
    await vs.commands.executeCommand('lunaticflow.openRound', { root: repo, sprint: 's1' });
    const diff = vs.calls.executed.find(c => c.command === 'vscode.diff')!;
    assert.ok(diff, 'a diff editor opens');
    const right = diff.args[1];
    const ref = parseRevUri(right)!;
    assert.strictEqual(ref.side, 'new');
    const content: string = await vs.mock.content(right);
    assert.match(content, /line 5 changed/);
    const doc = { uri: right, lineCount: content.split('\n').length };
    vs.workspace.textDocuments = [doc];

    // CodeLenses above each hunk.
    let lenses = await vs.mock.codeLenses(doc);
    const titles = lenses.map((l: any) => l.command.title);
    assert.ok(titles.filter((t: string) => t.includes('Approve')).length === 2, titles.join(' | '));
    const approveArgs = lenses.filter((l: any) => l.command.command === 'lunaticflow.approveHunk').map((l: any) => l.command.arguments[0]);

    // Approve the first change, reject the drive-by with a reason.
    await vs.commands.executeCommand('lunaticflow.approveHunk', approveArgs[0]);
    vs.answers.input = 'out of scope';
    await vs.commands.executeCommand('lunaticflow.rejectHunk', approveArgs[1]);
    let st = stateOf('s1');
    const draft = st.rounds[0].draft;
    assert.strictEqual(draft[approveArgs[0].key].decision, 'approved');
    assert.deepStrictEqual(draft[approveArgs[1].key], { path: 'src/a.c', decision: 'rejected', reason: 'out of scope' });

    // Comment on the new file: the comment command opens a thread, and typing into it creates the comment.
    const newFile = files.find((f: any) => f.file.path === 'src/new.c');
    const newHunk = newFile.file.hunks[0];
    await vs.commands.executeCommand('lunaticflow.commentHunk', { root: repo, sprint: 's1', path: 'src/new.c', key: newHunk.key });
    const empty = vs.calls.commentThreads[vs.calls.commentThreads.length - 1];
    await vs.commands.executeCommand('lunaticflow.comment.create', { thread: empty, text: 'make it static' });
    st = stateOf('s1');
    assert.strictEqual(st.threads.length, 1);
    assert.strictEqual(st.threads[0].submitted, false);
    assert.strictEqual(st.threads[0].path, 'src/new.c');

    // Send: the commented hunk counts as answered, so no prompt; the verdict asks for changes.
    vs.answers.info = undefined;
    await vs.commands.executeCommand('lunaticflow.submitReview', { root: repo, sprint: 's1' });
    st = stateOf('s1');
    assert.strictEqual(st.status, 'revising');
    assert.strictEqual(st.rounds[0].review.verdict, 'changes');
    assert.strictEqual(st.rounds[0].draft, undefined);
    assert.strictEqual(st.threads[0].submitted, true);
    assert.ok(vs.calls.info.some(m => /isn't waiting/.test(m)), 'offers to nudge an agent that is not in lf await');
    const shown = lf('show', 's1');
    assert.match(shown, /CHANGES REQUESTED/);
    assert.match(shown, /out of scope/);
    assert.match(shown, /make it static/);

    // The agent answers: revert, fix, reply, resubmit.
    lf('revert-rejected', 's1');
    fs.writeFileSync(path.join(repo, 'src', 'new.c'), '// counters\nstatic int x;\n');
    sh('git', 'commit', '-qam', 'review');
    lf('reply', 's1', st.threads[0].id, 'done, and added a header comment');
    lf('submit', 's1', '--summary', 'round 2');
    // The store polls; reload now instead of waiting for the timer.
    await vs.commands.executeCommand('lunaticflow.refresh');
    await tick();

    // Round 2 shows only the changes since round 1, and the thread with the agent's reply.
    vs.calls.executed.length = 0;
    await vs.commands.executeCommand('lunaticflow.openRound', { root: repo, sprint: 's1', path: 'src/new.c' });
    const right2 = vs.calls.executed.find(c => c.command === 'vscode.diff')!.args[1];
    assert.strictEqual(parseRevUri(right2)!.round, 2);
    const content2: string = await vs.mock.content(right2);
    const doc2 = { uri: right2, lineCount: content2.split('\n').length };
    vs.workspace.textDocuments = [doc2];
    await vs.commands.executeCommand('lunaticflow.refresh');
    await tick(); await tick();
    const shownThread = vs.calls.commentThreads.filter(t => !t.disposed && t.uri.toString() === right2.toString());
    assert.strictEqual(shownThread.length, 1, 'the thread is carried into round 2');
    assert.strictEqual(shownThread[0].comments.length, 2);
    assert.strictEqual(shownThread[0].comments[1].author.name, 'Claude');
    const files2 = await tree.treeDataProvider.getChildren(s1);
    // Round 2 touches src/a.c (the revert) and src/new.c (the fix).
    assert.deepStrictEqual(files2.filter((f: any) => f.kind === 'file').map((f: any) => f.file.path).sort(), ['src/a.c', 'src/new.c']);
    assert.ok(files2.some((f: any) => f.kind === 'threads'), 'the sprint lists its threads');

    // Resolve the thread and approve everything: the sprint is approved and s2 becomes ready.
    await vs.commands.executeCommand('lunaticflow.resolveThreadItem', { root: repo, sprint: 's1', id: st.threads[0].id });
    await vs.commands.executeCommand('lunaticflow.approveFile', { root: repo, sprint: 's1', path: 'src/a.c' });
    await vs.commands.executeCommand('lunaticflow.approveFile', { root: repo, sprint: 's1', path: 'src/new.c' });
    const st2 = stateOf('s1');
    if (st2.status !== 'approved') {
        // approveFile asks before sending once everything is decided; the mock answers nothing, so send here.
        await vs.commands.executeCommand('lunaticflow.submitReview', { root: repo, sprint: 's1' });
    }
    const st3 = stateOf('s1');
    assert.strictEqual(st3.status, 'approved');
    assert.strictEqual(st3.rounds[1].review.verdict, 'approved');
    assert.match(lf('show', 's1'), /APPROVED/);
    assert.match(lf('next'), /s2/);
    assert.ok(vs.calls.info.some(m => /Sprint s1 approved\. Ready next: s2/.test(m)));

    // Decisions are frozen once a round is reviewed.
    lenses = await vs.mock.codeLenses(doc2);
    assert.ok(!lenses.some((l: any) => l.command.command === 'lunaticflow.approveHunk'));

    for (const d of context.subscriptions) { d.dispose?.(); }
    for (const d of [repo, play, cfgHome]) { fs.rmSync(d, { recursive: true, force: true }); }
    console.log('flow extension tests passed');
}

main().catch(e => { console.error(e); process.exit(1); });
