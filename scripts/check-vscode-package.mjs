import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const npm = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const expected = JSON.parse(await readFile(new URL('packages/vscode/package.json', root), 'utf8'));
const filename = `${expected.name}-${npm.version}.vsix`;
const archive = process.argv[2] ?? new URL(`packages/vscode/${filename}`, root);
const files = unzipSync(await readFile(archive));
assert(files['extension/package.json'], 'The VSIX must contain its extension manifest.');
const manifest = JSON.parse(strFromU8(files['extension/package.json']));
assert.equal(manifest.version, npm.version, 'The packaged extension must match the npm release version.');
assert.equal(manifest.name, expected.name);
assert.equal(manifest.publisher, expected.publisher);
assert(files[`extension/${manifest.main.replace(/^\.\//, '')}`]?.length, 'The VSIX must contain its bundled entry point.');
assert(files['extension/LICENSE.txt']?.length, 'The VSIX must contain its license.');

const targets = ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64', 'win32-x64-msvc'];
const host = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
const required = process.env.WARDEN_NATIVE_EXPECT_ALL === '1' ? targets : targets.filter((target) => target === host);
for (const target of required) {
  assert(files[`extension/dist/native/warden.${target}.node`]?.length, `The VSIX is missing the ${target} native module.`);
}
assert(!Object.keys(files).some((name) => /^extension\/(src|node_modules)\//.test(name)), 'The VSIX must contain bundled code, not development sources.');
console.log(`VSIX checked: ${manifest.publisher}.${manifest.name} ${manifest.version}; ${required.length} native target(s).`);
