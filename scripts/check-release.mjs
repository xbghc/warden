import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const npm = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const extension = JSON.parse(await readFile(new URL('packages/vscode/package.json', root), 'utf8'));

assert.match(npm.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Releases require a stable X.Y.Z version.');
assert.equal(extension.version, npm.version, 'The npm package and VS Code extension must have the same version.');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${npm.version}`, 'The release tag must match both package versions.');
}
console.log(`Release metadata checked: ${npm.name} and ${extension.publisher}.${extension.name} ${npm.version}.`);
