// Run with: npm test (plain Node, no VS Code needed)
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffArgs, hunkNewRange, mapLine, parseDiff } from '../flow/diff';
import { Plan, SprintState, emptySprintState, readySprints, tally, timeline, topoOrder, validatePlan, verdictOf } from '../flow/model';

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

console.log('flow tests passed');
