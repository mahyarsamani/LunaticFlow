// Unified-diff parsing shared with the `lf` CLI (cli/lf.py implements the same rules).
// Pure: no dependency on the vscode module, so it can be unit tested with plain Node.
import * as crypto from 'crypto';

export interface Hunk {
    /** Stable identity of the hunk within one round: sha1(path + "\n" + body) truncated to 12 hex digits. */
    key: string;
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** Body lines after the @@ header, each starting with ' ', '+', '-' or '\'. */
    lines: string[];
    added: number;
    removed: number;
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'binary';

export interface FileDiff {
    /** Path in the new revision (the old path for a deleted file). */
    path: string;
    oldPath: string;
    status: FileStatus;
    hunks: Hunk[];
}

/** The git command both the extension and the CLI run, so their hunk keys agree. */
export function diffArgs(base: string, head: string): string[] {
    return ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', base, head];
}

export function hunkKey(path: string, lines: string[]): string {
    return crypto.createHash('sha1').update(path + '\n' + lines.join('\n')).digest('hex').slice(0, 12);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
    if (p === '/dev/null') { return p; }
    return p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
}

export function parseDiff(text: string): FileDiff[] {
    const files: FileDiff[] = [];
    let file: FileDiff | undefined;
    let hunk: Hunk | undefined;
    let fromHeader = '';
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }

    const finishHunk = () => {
        if (file && hunk) {
            hunk.key = hunkKey(file.path, hunk.lines);
            file.hunks.push(hunk);
        }
        hunk = undefined;
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            finishHunk();
            // Paths are taken from the ---/+++ lines; this fallback covers binary and mode-only diffs.
            const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
            file = { path: m ? m[2] : '', oldPath: m ? m[1] : '', status: 'modified', hunks: [] };
            files.push(file);
            fromHeader = '';
            continue;
        }
        if (!file) { continue; }
        if (hunk) {
            const c = line[0];
            if (c === ' ' || c === '+' || c === '-' || c === '\\' || line === '') {
                // An empty line inside a hunk is a context line whose leading space was stripped.
                hunk.lines.push(line === '' ? ' ' : line);
                if (c === '+') { hunk.added++; }
                if (c === '-') { hunk.removed++; }
                continue;
            }
            finishHunk();
        }
        if (line.startsWith('--- ')) {
            fromHeader = stripPrefix(line.slice(4));
            continue;
        }
        if (line.startsWith('+++ ')) {
            const to = stripPrefix(line.slice(4));
            if (to === '/dev/null') {
                file.status = 'deleted';
                file.path = fromHeader;
                file.oldPath = fromHeader;
            } else {
                file.path = to;
                file.oldPath = fromHeader === '/dev/null' ? to : fromHeader;
                if (fromHeader === '/dev/null') { file.status = 'added'; }
            }
            continue;
        }
        if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
        if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
        if (line.startsWith('Binary files ')) { file.status = 'binary'; continue; }
        const m = HUNK_RE.exec(line);
        if (m) {
            hunk = {
                key: '',
                header: line,
                oldStart: +m[1],
                oldLines: m[2] === undefined ? 1 : +m[2],
                newStart: +m[3],
                newLines: m[4] === undefined ? 1 : +m[4],
                lines: [],
                added: 0,
                removed: 0,
            };
        }
    }
    finishHunk();
    // A binary or mode-only change has no hunks; give it one pseudo-hunk so it can still be decided.
    for (const f of files) {
        if (f.hunks.length === 0) {
            f.hunks.push({
                key: hunkKey(f.path, [`<${f.status}>`]),
                header: `<${f.status}>`,
                oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [], added: 0, removed: 0,
            });
        }
    }
    return files;
}

/** First and last 1-based lines a hunk covers in the new file (its added lines, or where it removed them). */
export function hunkNewRange(h: Hunk): { start: number; end: number } {
    let line = h.newStart;
    let first = 0;
    let last = 0;
    for (const l of h.lines) {
        const c = l[0];
        if (c === '+') {
            if (!first) { first = line; }
            last = line;
            line++;
        } else if (c === '-') {
            if (!first) { first = Math.max(line, 1); }
            last = Math.max(last, Math.max(line - 1, first));
        } else if (c === ' ') {
            line++;
        }
    }
    if (!first) { return { start: Math.max(h.newStart, 1), end: Math.max(h.newStart, 1) }; }
    return { start: first, end: Math.max(last, first) };
}

/**
 * Where a 1-based line of the old file lands in the new file, given the hunks between them.
 * A line inside a changed region maps to the start of what replaced it.
 */
export function mapLine(line: number, hunks: Hunk[]): number {
    let delta = 0;
    for (const h of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
        const oldEnd = h.oldStart + Math.max(h.oldLines, 1) - 1;
        if (line < h.oldStart) { break; }
        if (line > oldEnd) {
            delta += h.newLines - h.oldLines;
            continue;
        }
        // Inside the hunk: walk it to find the exact line if it is context, else the nearest new line.
        let o = h.oldStart;
        let n = h.newStart;
        for (const l of h.lines) {
            const c = l[0];
            if (c === ' ') {
                if (o === line) { return n; }
                o++; n++;
            } else if (c === '-') {
                if (o === line) { return Math.max(n, 1); }
                o++;
            } else if (c === '+') {
                n++;
            }
        }
        return Math.max(n, 1);
    }
    return Math.max(line + delta, 1);
}
