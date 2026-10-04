import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/cli/migrate.ts', 'create-user': 'src/cli/createUser.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Bundle the workspace package; everything else stays an external dependency.
  noExternal: ['@scalp-city/shared'],
});
