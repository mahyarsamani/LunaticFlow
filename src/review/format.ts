// Pure helpers with no dependency on the vscode module, so they can be unit tested.

export interface FormattableComment {
    line: number;
    text: string;
    quote?: string;
}

export interface FormatOptions {
    separator?: string;
    includeQuote?: boolean;
}

export interface LineChange {
    startLine: number;
    startChar: number;
    endLine: number;
    rangeLength: number;
    text: string;
}

/** Build the export text: one "@path#line : comment(s)" entry per commented line. */
export function formatComments(
    files: { path: string; comments: FormattableComment[] }[],
    opts: FormatOptions = {},
): string {
    const separator = opts.separator ?? '; ';
    const out: string[] = [];
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sorted) {
        const byLine = new Map<number, FormattableComment[]>();
        for (const c of file.comments) {
            if (!c.text || !c.text.trim()) { continue; }
            if (!byLine.has(c.line)) { byLine.set(c.line, []); }
            byLine.get(c.line)!.push(c);
        }
        for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
            const texts = byLine.get(line)!.map(c => {
                const text = oneLine(c.text);
                return opts.includeQuote && c.quote ? `"${oneLine(c.quote)}" ${text}` : text;
            });
            out.push(`@${file.path}#${line} : ${texts.join(separator)}`);
        }
    }
    return out.join('\n');
}

function oneLine(s: string): string {
    return s.trim().replace(/\s*\n\s*/g, ' ');
}

/**
 * Move comment line numbers (1-based) so they follow the text when the document is edited.
 * Mutates `comments`; returns whether any comment moved. Change ranges are 0-based.
 */
export function shiftLines(comments: { line: number }[], changes: LineChange[]): boolean {
    let moved = false;
    // Apply bottom-up so earlier changes don't invalidate later ranges.
    const ordered = [...changes].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar);
    for (const ch of ordered) {
        const added = (ch.text.match(/\n/g) || []).length;
        const delta = added - (ch.endLine - ch.startLine);
        if (delta === 0) { continue; }
        for (const c of comments) {
            const l = c.line - 1;
            let next = l;
            if (l > ch.endLine) {
                next = l + delta;
            } else if (l > ch.startLine) {
                // The commented line was inside the replaced region: keep it within what replaced it.
                next = Math.min(l, ch.startLine + added);
            } else if (l === ch.startLine && ch.startChar === 0 && ch.rangeLength === 0 && ch.text.endsWith('\n')) {
                // Lines inserted directly above the commented line push it down.
                next = l + added;
            }
            if (next !== l) {
                c.line = next + 1;
                moved = true;
            }
        }
    }
    return moved;
}

/**
 * Rewrite a path after a file or folder rename. Returns undefined when `p` is unaffected.
 * `sep` is the path separator used in `p`.
 */
export function renamedPath(p: string, oldPath: string, newPath: string, sep = '/'): string | undefined {
    if (p === oldPath) { return newPath; }
    const prefix = oldPath.endsWith(sep) ? oldPath : oldPath + sep;
    if (p.startsWith(prefix)) { return newPath + (newPath.endsWith(sep) ? '' : sep) + p.slice(prefix.length); }
    return undefined;
}
