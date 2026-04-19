import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: [
    '@tinyweb_dev/doc-indexer-core',
    'tinyweb-office-cells',
    'puppeteer',
  ],
});
