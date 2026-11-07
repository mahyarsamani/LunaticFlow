// Run with: npm test (plain Node, no VS Code needed)
import * as assert from 'assert';
import { formatComments, shiftLines, renamedPath, LineChange } from '../review/format';

// ── formatComments ───────────────────────────────────────────────────────────
assert.strictEqual(
    formatComments([
        { path: 'docs/b.md', comments: [{ line: 4, text: 'second file' }] },
        {
            path: 'a.md',
            comments: [
                { line: 12, text: 'later line' },
                { line: 3, text: 'first' },
                { line: 3, text: 'also\nmultiline', quote: 'some text' },
                { line: 5, text: '   ' },
            ],
        },
    ]),
    ['@a.md#3 : first; also multiline', '@a.md#12 : later line', '@docs/b.md#4 : second file'].join('\n'),
);
assert.strictEqual(
    formatComments(
        [{ path: 'a.md', comments: [{ line: 1, text: 'x', quote: 'q' }, { line: 1, text: 'y' }] }],
        { separator: ' | ', includeQuote: true },
    ),
    '@a.md#1 : "q" x | y',
);
assert.strictEqual(formatComments([]), '');

// ── shiftLines ───────────────────────────────────────────────────────────────
const mk = () => [{ line: 1 }, { line: 5 }, { line: 10 }];
const ch = (startLine: number, startChar: number, endLine: number, rangeLength: number, text: string): LineChange =>
    ({ startLine, startChar, endLine, rangeLength, text });

// Enter pressed at the end of line 2: later comments shift down.
let c = mk();
assert.ok(shiftLines(c, [ch(1, 8, 1, 0, '\n')]));
assert.deepStrictEqual(c.map(x => x.line), [1, 6, 11]);

// Two lines inserted at column 0 of commented line 5: it moves with its text.
c = mk();
shiftLines(c, [ch(4, 0, 4, 0, 'a\nb\n')]);
assert.deepStrictEqual(c.map(x => x.line), [1, 7, 12]);

// Lines 3–4 deleted.
c = mk();
shiftLines(c, [ch(2, 0, 4, 20, '')]);
assert.deepStrictEqual(c.map(x => x.line), [1, 3, 8]);

// Edit within one line: nothing moves.
c = mk();
assert.ok(!shiftLines(c, [ch(4, 2, 4, 3, 'xyz')]));
assert.deepStrictEqual(c.map(x => x.line), [1, 5, 10]);

// ── renamedPath ──────────────────────────────────────────────────────────────
assert.strictEqual(renamedPath('/w/a.md', '/w/a.md', '/w/b.md'), '/w/b.md');
assert.strictEqual(renamedPath('/w/docs/x.md', '/w/docs', '/w/guide'), '/w/guide/x.md');
assert.strictEqual(renamedPath('/w/docs2/x.md', '/w/docs', '/w/guide'), undefined);
assert.strictEqual(renamedPath('C:\\w\\d\\x.md', 'C:\\w\\d', 'C:\\w\\e', '\\'), 'C:\\w\\e\\x.md');

console.log('format tests passed');
