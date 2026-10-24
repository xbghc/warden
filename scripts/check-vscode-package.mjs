import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const expected = JSON.parse(await readFile(new URL('packages/vscode/package.json', root), 'utf8'));
const filename = `${expected.name}-${expected.version}.vsix`;
const archive = process.argv[2] ?? new URL(`packages/vscode/${filename}`, root);
const files = unzipSync(await readFile(archive));
assert(files['extension/package.json'], 'The VSIX must contain its extension manifest.');
const manifest = JSON.parse(strFromU8(files['extension/package.json']));
assert.equal(manifest.version, expected.version, 'The packaged extension must match the extension source version.');
assert.equal(manifest.name, expected.name);
assert.equal(manifest.publisher, expected.publisher);
assert(files[`extension/${manifest.main.replace(/^\.\//, '')}`]?.length, 'The VSIX must contain its bundled entry point.');
assert(files['extension/LICENSE.txt']?.length, 'The VSIX must contain its license.');
assert(files['extension/dist/webview/index.js']?.length, 'The VSIX must contain the webview script.');
assert(files['extension/dist/webview/index.css']?.length, 'The VSIX must contain the webview styles.');
assert(!strFromU8(files['extension/dist/webview/index.js']).includes('process.env'), 'Webviews must run without Node globals.');
const bundle = strFromU8(files[`extension/${manifest.main.replace(/^\.\//, '')}`]);
assert(!bundle.includes('hono/dist') && !bundle.includes('registry.npmjs.org'), 'The extension must not bundle the legacy server or npm update checker.');

const targets = ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-x64', 'darwin-arm64', 'win32-x64-msvc'];
const host = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : ''}`;
const required = process.env.WARDEN_NATIVE_EXPECT_ALL === '1' ? targets : targets.filter((target) => target === host);
for (const target of required) {
  assert(files[`extension/dist/native/warden.${target}.node`]?.length, `The VSIX is missing the ${target} native module.`);
}
assert(!Object.keys(files).some((name) => /^extension\/(src|node_modules)\//.test(name)), 'The VSIX must contain bundled code, not development sources.');
console.log(`VSIX checked: ${manifest.publisher}.${manifest.name} ${manifest.version}; ${required.length} native target(s).`);
