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
