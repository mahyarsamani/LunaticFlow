// Run with: npm test (plain Node, no VS Code needed)
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffArgs, hunkNewRange, mapLine, parseDiff } from '../flow/diff';
import { Plan, SprintState, emptySprintState, readySprints, tally, timeline, topoOrder, validatePlan, verdictOf } from '../flow/model';
import { NavFile, hunkAt, navigate, positionOf } from '../flow/navigate';

// ── parseDiff on a real repository, and the same keys as the CLI ─────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-test-'));
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src', 'a.c'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(''));
fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
fs.writeFileSync(path.join(dir, 'with space.md'), 'hello\n\nworld\n');
git('add', '.');
git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD').trim();
const lines = fs.readFileSync(path.join(dir, 'src', 'a.c'), 'utf8').split('\n');
lines[4] = 'line 5 changed';
lines.splice(30, 0, 'inserted A', 'inserted B');
lines.splice(10, 1);
fs.writeFileSync(path.join(dir, 'src', 'a.c'), lines.join('\n'));
fs.rmSync(path.join(dir, 'gone.txt'));
fs.writeFileSync(path.join(dir, 'new.py'), 'x = 1\n');
fs.writeFileSync(path.join(dir, 'with space.md'), 'hello\n\nthere\n');
git('add', '-A');
git('commit', '-qm', 'change');
const head = git('rev-parse', 'HEAD').trim();
const text = git(...diffArgs(base, head));
const files = parseDiff(text);
const byPath = new Map(files.map(f => [f.path, f]));
assert.deepStrictEqual([...byPath.keys()].sort(), ['gone.txt', 'new.py', 'src/a.c', 'with space.md']);
assert.strictEqual(byPath.get('gone.txt')!.status, 'deleted');
assert.strictEqual(byPath.get('new.py')!.status, 'added');
// Line 5 changed and line 11 deleted share one hunk at -U3; the insertion at 30 is the second.
assert.strictEqual(byPath.get('src/a.c')!.hunks.length, 2);
for (const f of files) { for (const h of f.hunks) { assert.match(h.key, /^[0-9a-f]{12}$/); } }

const cli = path.join(__dirname, '..', '..', 'cli', 'test_lf.py');
const pyKeys = execFileSync('python3', [cli, '--keys'], { input: text, encoding: 'utf8' }).trim().split('\n');
const tsKeys = files.flatMap(f => f.hunks.map(h => `${f.path} ${f.status} ${h.key} ${h.newStart} ${h.newLines}`));
assert.deepStrictEqual(tsKeys, pyKeys, 'the CLI and the extension must agree on hunk keys');

// hunkNewRange: from the changed line 5 to where line 11 was removed (new line 10 is above the gap).
const h0 = byPath.get('src/a.c')!.hunks[0];
assert.deepStrictEqual(hunkNewRange(h0), { start: 5, end: 10 });
assert.deepStrictEqual(hunkNewRange(byPath.get('src/a.c')!.hunks[1]), { start: 30, end: 31 });
// mapLine: old line 20 moves up one (line 11 deleted above it); old line 35 moves down one (+2 −1).
const ah = byPath.get('src/a.c')!.hunks;
assert.strictEqual(mapLine(20, ah), 19);
assert.strictEqual(mapLine(35, ah), 36);
assert.strictEqual(mapLine(5, ah), 5);
fs.rmSync(dir, { recursive: true, force: true });

// ── plan helpers ─────────────────────────────────────────────────────────────
const plan: Plan = {
    version: 1, title: 'p', sprints: [
        { id: 'merge', title: 'campaign', deps: ['dx', 'ty'] },
        { id: 'base', title: 'one line', deps: [], scope: ['gem5/src/mem'] },
        { id: 'dx', title: 'dx100', deps: ['base'], scope: ['gem5/src/mem/dx100'] },
        { id: 'ty', title: 'tyche', deps: ['base'], scope: ['gem5/src/mem/dx100/shared.cc'] },
    ],
};
assert.deepStrictEqual(topoOrder(plan).map(s => s.id), ['base', 'dx', 'ty', 'merge']);
const problems = validatePlan(plan);
assert.strictEqual(problems.length, 1, problems.join('\n'));
assert.match(problems[0], /dx and ty can run in parallel/);
assert.match(validatePlan({ ...plan, sprints: [{ id: 'a', title: '', deps: ['b'] }, { id: 'b', title: '', deps: ['a'] }] }).join(), /cycle/);

const states = new Map<string, SprintState>(plan.sprints.map(s => [s.id, emptySprintState(s.id)]));
assert.deepStrictEqual(readySprints(plan, states).map(s => s.id), ['base']);
states.get('base')!.status = 'approved';
assert.deepStrictEqual(readySprints(plan, states).map(s => s.id), ['dx', 'ty']);

// ── verdict: approved only with every hunk approved and nothing open ─────────
const fake = [{ path: 'x', oldPath: 'x', status: 'modified' as const, hunks: [
    { key: 'k1', header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], added: 0, removed: 0 },
    { key: 'k2', header: '', oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [], added: 0, removed: 0 },
] }];
const ok = { k1: { path: 'x', decision: 'approved' as const }, k2: { path: 'x', decision: 'approved' as const } };
assert.strictEqual(verdictOf(tally(fake, ok, [])), 'approved');
assert.strictEqual(verdictOf(tally(fake, { k1: ok.k1 }, [])), 'changes');
assert.strictEqual(verdictOf(tally(fake, { ...ok, k2: { path: 'x', decision: 'rejected' } }, [])), 'changes');
const openThread = { id: 't', round: 1, path: 'x', line: 1, status: 'open' as const, submitted: true, messages: [] };
assert.strictEqual(verdictOf(tally(fake, ok, [openThread])), 'changes');
assert.strictEqual(verdictOf(tally(fake, ok, [{ ...openThread, status: 'resolved' }])), 'approved');

// ── timeline: review waits are their own bars; planned sprints follow their deps ─
const t0 = Date.parse('2026-11-24T10:00:00Z');
const iso = (h: number) => new Date(t0 + h * 3600_000).toISOString();
states.set('base', {
    ...emptySprintState('base'), status: 'approved', startedAt: iso(0), approvedAt: iso(3),
    rounds: [{ n: 1, base: 'a', head: 'b', submittedAt: iso(1), review: { submittedAt: iso(3), decisions: {}, verdict: 'approved' } }],
});
const bars = timeline(plan, states, t0 + 4 * 3600_000);
const baseBars = bars.filter(b => b.sprint === 'base');
assert.deepStrictEqual(baseBars.map(b => b.kind), ['working', 'review']);
assert.strictEqual(baseBars[1].end - baseBars[1].start, 2 * 3600_000);
const merge = bars.find(b => b.sprint === 'merge')!;
const dxEnd = bars.find(b => b.sprint === 'dx')!.end;
assert.ok(merge.start >= dxEnd);

// ── navigation between changes and files ──────────────────────────────────────
{
    // a.c: changes at 5-7 and 30 (a deletion-only change sits on one line); b.bin: a binary pseudo-hunk; c.c: one change.
    const files: NavFile[] = [
        { path: 'a.c', hunks: [{ key: 'a1', start: 5, end: 7 }, { key: 'a2', start: 30, end: 30 }] },
        { path: 'b.bin', hunks: [{ key: 'b1', start: 1, end: 1 }] },
        { path: 'c.c', hunks: [{ key: 'c1', start: 12, end: 14 }] },
    ];
    const none = () => false;
    assert.deepStrictEqual(navigate(files, undefined, 'next', none), { file: 0, hunk: 0 }, 'next with no cursor: the first change');
    assert.deepStrictEqual(navigate(files, undefined, 'previous', none), { file: 2, hunk: 0 }, 'previous with no cursor: the last change');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 1 }, 'next', none), { file: 0, hunk: 0 });
    assert.deepStrictEqual(navigate(files, { file: 0, line: 5 }, 'next', none), { file: 0, hunk: 1 }, 'from a change: the next one');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 6 }, 'next', none), { file: 0, hunk: 1 }, 'from inside a change: the next one');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 30 }, 'next', none), { file: 1, hunk: 0 }, 'the last change goes on into the next file');
    assert.deepStrictEqual(navigate(files, { file: 2, line: 12 }, 'next', none), { edge: 'end' });
    assert.deepStrictEqual(navigate(files, { file: 2, line: 40 }, 'next', none), { edge: 'end' }, 'below the last change');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 30 }, 'previous', none), { file: 0, hunk: 0 });
    assert.deepStrictEqual(navigate(files, { file: 0, line: 6 }, 'previous', none), { file: 0, hunk: 0 }, 'from inside a change: back to its first line');
    assert.deepStrictEqual(navigate(files, { file: 1, line: 1 }, 'previous', none), { file: 0, hunk: 1 }, 'back into the previous file, at its last change');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 5 }, 'previous', none), { edge: 'start' });
    assert.deepStrictEqual(navigate(files, { file: 0, line: 30 }, 'nextFile', none), { file: 1, hunk: 0 });
    assert.deepStrictEqual(navigate(files, { file: 2, line: 12 }, 'nextFile', none), { edge: 'end' });
    assert.deepStrictEqual(navigate(files, { file: 2, line: 12 }, 'previousFile', none), { file: 1, hunk: 0 }, 'a file starts at its first change');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 30 }, 'previousFile', none), { edge: 'start' });

    // Next undecided skips decided changes, wraps to the top, and comes back to the cursor's own change last.
    const done = new Set(['a2', 'b1']);
    const decided = (k: string) => done.has(k);
    assert.deepStrictEqual(navigate(files, { file: 0, line: 5 }, 'nextUndecided', decided), { file: 2, hunk: 0 });
    assert.deepStrictEqual(navigate(files, { file: 2, line: 12 }, 'nextUndecided', decided), { file: 0, hunk: 0 }, 'wraps to the top');
    done.add('a1');
    assert.deepStrictEqual(navigate(files, { file: 2, line: 12 }, 'nextUndecided', decided), { file: 2, hunk: 0 }, 'the change under the cursor, last');
    done.add('c1');
    assert.deepStrictEqual(navigate(files, { file: 0, line: 1 }, 'nextUndecided', decided), { edge: 'none' });
    assert.deepStrictEqual(navigate([], undefined, 'next', none), { edge: 'end' });

    // Where the cursor is.
    assert.strictEqual(hunkAt(files[0], 20), 1, 'between changes: the nearer one');
    assert.strictEqual(hunkAt({ path: 'x', hunks: [] }, 1), -1);
    done.clear();
    done.add('a1');
    assert.deepStrictEqual(positionOf(files, { file: 0, line: 31 }, decided),
        { change: 2, changes: 2, file: 1, files: 3, undecidedInFile: 1, undecidedInRound: 3 });
    assert.strictEqual(positionOf(files, { file: 5, line: 1 }, decided), undefined);
}

console.log('flow tests passed');
