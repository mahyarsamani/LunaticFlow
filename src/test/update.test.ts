// Run with: npm test (plain Node, no VS Code needed)
import * as assert from 'assert';
import { compareVersions, vsixAsset } from '../update/version';

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

console.log('update tests passed');
