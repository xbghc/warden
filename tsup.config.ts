import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: { cli: 'bin/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: false,
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  // Bundle everything (workspace packages + hono) so the published package has zero runtime deps.
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  define: { __WARDEN_VERSION__: JSON.stringify(pkg.version) },
});
