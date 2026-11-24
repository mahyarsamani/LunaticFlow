// Run with: npm test (plain Node, no VS Code needed)
import * as assert from 'assert';
import { compareVersions, nextVersion, vsixAsset } from '../update/version';

assert.ok(compareVersions('v0.3.1', '0.3.0') > 0);
assert.ok(compareVersions('0.3.0', 'v0.3.1') < 0);
assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), 0);
assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'numeric, not lexical');
assert.ok(compareVersions('1.0', '1.0.1') < 0);
assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0, 'a pre-release precedes its release');
assert.ok(compareVersions('1.0.0-beta', '1.0.0-alpha') > 0);

assert.deepStrictEqual(
    vsixAsset({ tag_name: 'v1', html_url: '', assets: [
        { name: 'notes.txt', browser_download_url: 'a' },
        { name: 'lunaticflow-1.0.0.vsix', browser_download_url: 'b' },
    ] }),
    { name: 'lunaticflow-1.0.0.vsix', url: 'b' },
);
assert.strictEqual(vsixAsset({ tag_name: 'v1', html_url: '', assets: [] }), undefined);

// The calendar scheme: beta 0.yymm.revision, stable yy.m.revision.
const nov = new Date(2026, 10, 24), dec = new Date(2026, 11, 2), jan = new Date(2027, 0, 5);
assert.strictEqual(nextVersion('0.3.2', nov, false), '0.2611.0', 'the first beta follows the old scheme');
assert.strictEqual(nextVersion('0.2611.0', nov, false), '0.2611.1', 'same month: next revision');
assert.strictEqual(nextVersion('0.2611.4', dec, false), '0.2612.0', 'new month: revision 0');
assert.strictEqual(nextVersion('0.2612.3', jan, false), '0.2701.0', 'new year');
assert.strictEqual(nextVersion('0.2701.0', jan, true), '27.1.0', 'first stable, no zero-padded month');
assert.strictEqual(nextVersion('27.1.0', jan, true), '27.1.1');
assert.throws(() => nextVersion('27.1.0', jan, false), /beta cannot follow/);
assert.throws(() => nextVersion('0.2612.0', nov, false), /not be newer/, 'a clock behind the last release');
assert.ok(compareVersions('0.2611.0', '0.3.2') > 0 && compareVersions('26.11.0', '0.2701.0') > 0);

console.log('update tests passed');
