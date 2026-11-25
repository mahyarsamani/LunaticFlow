#!/usr/bin/env node
// Releases LunaticFlow by its calendar version scheme (see nextVersion in src/update/version.ts):
// beta 0.yymm.revision by default, stable yy.m.revision with --stable.
// Sets package.json, commits "Release <version>", tags v<version>, and pushes the commit and tag,
// which starts the Release workflow. --dry-run prints the next version and changes nothing.
// Run through `npm run release`, which compiles first.
const { execFileSync } = require('child_process');
const { nextVersion } = require('../out/update/version');

const args = process.argv.slice(2);
const stable = args.includes('--stable'), dryRun = args.includes('--dry-run');
const current = require('../package.json').version;
const next = nextVersion(current, new Date(), stable);
console.log(`${current} -> ${next}${stable ? ' (stable)' : ' (beta)'}`);
if (dryRun) { process.exit(0); }

const run = (cmd, ...a) => execFileSync(cmd, a, { stdio: 'inherit' });
run('npm', 'version', next, '-m', 'Release %s');
run('git', 'push', '--follow-tags');
