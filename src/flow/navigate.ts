// Moving through the changes of a sprint round: change by change within a file and on into the
// next file, file by file, or to the next change that has no decision yet. Pure, so the rules are
// tested without VS Code; review.ts turns the result into an open diff and a cursor.

/** A changed file as navigation sees it: its hunks, each with its line range on the new side (1-based). */
export interface NavFile {
    path: string;
    hunks: { key: string; start: number; end: number }[];
}

export type NavMove = 'next' | 'previous' | 'nextFile' | 'previousFile' | 'nextUndecided';

/** Where the reviewer is: a file of the round (index into the files) and the cursor's line on the new side. */
export interface NavFrom {
    file: number;
    line: number;
}

/** A hunk: file index and hunk index within that file. */
export interface NavSpot {
    file: number;
    hunk: number;
}

/**
 * The target of a move, or why there is none: `end` past the last change or file, `start` before the
 * first, `none` when no change is left without a decision.
 */
export type NavResult = NavSpot | { edge: 'end' | 'start' | 'none' };

export function isSpot(r: NavResult): r is NavSpot {
    return 'file' in r;
}

/** The hunk at a line: the one that contains it, else the nearest; -1 for a file without hunks. */
export function hunkAt(f: NavFile, line: number): number {
    let best = -1;
    let dist = Infinity;
    f.hunks.forEach((h, i) => {
        const d = line < h.start ? h.start - line : line > h.end ? line - h.end : 0;
        if (d < dist) { dist = d; best = i; }
    });
    return best;
}

/** Every hunk of the round in review order: files in diff order, hunks top to bottom. */
function spots(files: NavFile[]): NavSpot[] {
    const out: NavSpot[] = [];
    files.forEach((f, file) => f.hunks.forEach((_, hunk) => out.push({ file, hunk })));
    return out;
}

/**
 * Index into `spots(files)` of the first hunk after the cursor: the next hunk in the cursor's file
 * that starts below the cursor line, else the first hunk of a later file. `all.length` when none.
 */
function after(files: NavFile[], all: NavSpot[], from: NavFrom): number {
    const i = all.findIndex(s => s.file > from.file || (s.file === from.file && files[s.file].hunks[s.hunk].start > from.line));
    return i < 0 ? all.length : i;
}

export function navigate(
    files: NavFile[], from: NavFrom | undefined, move: NavMove, decided: (key: string) => boolean,
): NavResult {
    const all = spots(files);
    if (!all.length) { return { edge: move.startsWith('previous') ? 'start' : 'end' }; }
    switch (move) {
        case 'next': {
            const i = from ? after(files, all, from) : 0;
            return all[i] ?? { edge: 'end' };
        }
        case 'previous': {
            if (!from) { return all[all.length - 1]; }
            // The last hunk that starts above the cursor: from inside a hunk, below its first line,
            // this goes to that hunk's first line, as VS Code's own "previous change" does.
            for (let i = all.length - 1; i >= 0; i--) {
                const s = all[i];
                if (s.file < from.file || (s.file === from.file && files[s.file].hunks[s.hunk].start < from.line)) { return s; }
            }
            return { edge: 'start' };
        }
        case 'nextFile': {
            const s = all.find(x => x.file > (from?.file ?? -1));
            return s ?? { edge: 'end' };
        }
        case 'previousFile': {
            if (!from) { return all.find(x => x.file === all[all.length - 1].file)!; }
            const before = all.filter(x => x.file < from.file);
            if (!before.length) { return { edge: 'start' }; }
            const file = before[before.length - 1].file;
            return all.find(x => x.file === file)!;
        }
        case 'nextUndecided': {
            // Search forward from the cursor, then wrap to the top; the hunk under the cursor comes last.
            const i = from ? after(files, all, from) : 0;
            const order = [...all.slice(i), ...all.slice(0, i)];
            const s = order.find(x => !decided(files[x.file].hunks[x.hunk].key));
            return s ?? { edge: 'none' };
        }
    }
}

/** Where a cursor is, for display: "Change 3 of 5 · File 2 of 7", plus what is left without a decision. */
export interface NavPosition {
    change: number;
    changes: number;
    file: number;
    files: number;
    undecidedInFile: number;
    undecidedInRound: number;
}

export function positionOf(files: NavFile[], from: NavFrom, decided: (key: string) => boolean): NavPosition | undefined {
    const f = files[from.file];
    if (!f) { return undefined; }
    const h = hunkAt(f, from.line);
    if (h < 0) { return undefined; }
    const undecided = (x: NavFile) => x.hunks.filter(k => !decided(k.key)).length;
    return {
        change: h + 1, changes: f.hunks.length, file: from.file + 1, files: files.length,
        undecidedInFile: undecided(f), undecidedInRound: files.reduce((n, x) => n + undecided(x), 0),
    };
}
