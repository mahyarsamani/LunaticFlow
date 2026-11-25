// Pure helpers for the updater, so they can be unit tested without VS Code.

/** Compare two versions such as "0.3.1" and "v0.4.0"; negative when a < b. Pre-release tags sort before the release. */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2);
        return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ?? '' };
    };
    const x = parse(a), y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
        if (d) { return d; }
    }
    if (x.pre === y.pre) { return 0; }
    if (!x.pre) { return 1; }
    if (!y.pre) { return -1; }
    return x.pre < y.pre ? -1 : 1;
}

/**
 * The version after `current` released on `date`, by LunaticFlow's calendar scheme.
 * Stable: yy.m.revision (26.11.0). Beta: 0.yymm.revision (0.2611.0), the year and month in one
 * field because VS Code accepts only three-part semver. The revision counts releases within a
 * month and starts at 0. Months are not zero-padded: semver forbids leading zeros.
 */
export function nextVersion(current: string, date: Date, stable: boolean): string {
    const yy = date.getFullYear() % 100, m = date.getMonth() + 1;
    const [major, minor, patch] = current.replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const [a, b] = stable ? [yy, m] : [0, yy * 100 + m];
    const next = `${a}.${b}.${major === a && minor === b ? patch + 1 : 0}`;
    if (compareVersions(next, current) <= 0) {
        throw new Error(`${next} would not be newer than ${current}` + (stable ? '' : ' (a beta cannot follow a stable release)'));
    }
    return next;
}

export interface Release {
    tag_name: string;
    html_url: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: { name: string; browser_download_url: string; size?: number }[];
}

/** The release's .vsix asset, if it has one. */
export function vsixAsset(r: Release): { name: string; url: string } | undefined {
    const a = r.assets.find(x => x.name.toLowerCase().endsWith('.vsix'));
    return a ? { name: a.name, url: a.browser_download_url } : undefined;
}
