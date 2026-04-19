/**
 * Smoke test: register stub ExcelAdapter and run end-to-end via Indexer.
 * Run after `pnpm install && pnpm build` with:
 *   node --experimental-vm-modules examples/basic-excel.mjs
 *   (or via tsx) tsx examples/basic-excel.ts
 */
import { Indexer, FsStorage, NoopLLMProvider } from '@tinyweb_dev/doc-indexer-core';
import { ExcelAdapter } from '@tinyweb_dev/doc-indexer-excel';

async function main() {
  const indexer = new Indexer({
    adapters: [new ExcelAdapter()],
    llm: new NoopLLMProvider(),
    storage: new FsStorage('./out'),
  });

  const doc = await indexer.index({ path: process.argv[2] ?? './sample.xlsx' });
  console.log('Indexed:', doc.id, '-', doc.chunks.length, 'chunks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
