import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const workspace = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const extension = JSON.parse(await readFile(new URL('packages/vscode/package.json', root), 'utf8'));

assert.match(extension.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Releases require a stable X.Y.Z version.');
assert.equal(workspace.private, true, 'The workspace must not publish an npm product.');
assert.equal(workspace.bin, undefined, 'The desktop product must not ship a CLI.');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${extension.version}`, 'The release tag must match the extension version.');
}
console.log(`Release metadata checked: ${extension.publisher}.${extension.name} ${extension.version}.`);
