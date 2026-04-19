import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@tinyweb_dev/doc-indexer-core',
    '@tinyweb_dev/doc-indexer-excel',
    '@tinyweb_dev/doc-indexer-llm-openai',
    'commander',
    'kleur',
  ],
});
