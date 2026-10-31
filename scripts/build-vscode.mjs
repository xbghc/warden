import { build } from 'tsup';
import { cp, readFile } from 'node:fs/promises';
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
  sourcemap: true,
  splitting: false,
  external: ['vscode'],
  noExternal: [/^@warden\//],
  define: { __WARDEN_VERSION__: JSON.stringify(pkg.version) },
});
await cp('LICENSE', 'packages/vscode/LICENSE');
