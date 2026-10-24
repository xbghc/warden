import { build } from 'tsup';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('packages/vscode/package.json', 'utf8'));
await build({
  config: false,
  entry: { extension: 'packages/vscode/src/extension.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'packages/vscode/dist',
  clean: true,
  bundle: true,
  splitting: false,
  external: ['vscode'],
  noExternal: [/^@warden\//],
  banner: { js: "var __wardenModuleUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__wardenModuleUrl', __WARDEN_BUNDLED__: 'true', __WARDEN_VERSION__: JSON.stringify(pkg.version) },
});
await mkdir('packages/vscode/dist/native', { recursive: true });
for (const file of await readdir('native').catch(() => [])) {
  if (file.endsWith('.node')) await cp(`native/${file}`, `packages/vscode/dist/native/${file}`);
}
await cp('LICENSE', 'packages/vscode/LICENSE');
