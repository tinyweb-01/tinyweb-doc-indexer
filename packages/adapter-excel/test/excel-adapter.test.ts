import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Indexer, FsStorage, NoopLLMProvider } from '@tinyweb_dev/doc-indexer-core';
import { ExcelAdapter } from '../src/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixtures live in the host app for now (../../../../excel-knowledge-absorber/experiences/...)
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../excel-knowledge-absorber/experiences/table-indexing/input'
);
const FIXTURES = ['tables-sample.xlsx', 'sample.xlsx'];

describe('ExcelAdapter — snapshot', () => {
  let outDir: string;
  let indexer: Indexer;

  beforeAll(async () => {
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-indexer-excel-test-'));
    indexer = new Indexer({
      adapters: [new ExcelAdapter()],
      storage: new FsStorage(outDir),
      llm: new NoopLLMProvider(),
    });
  });

  for (const fixture of FIXTURES) {
    it(`indexes ${fixture}`, async () => {
      const fixturePath = path.join(FIXTURE_DIR, fixture);
      try {
        await fs.access(fixturePath);
      } catch {
        console.warn(`[skip] fixture not found: ${fixturePath}`);
        return;
      }

      const doc = await indexer.index({ path: fixturePath, type: 'excel' });

      // Basic sanity assertions.
      expect(doc.sourceType).toBe('excel');
      expect(doc.id).toBeTruthy();
      expect(doc.chunks.length).toBeGreaterThan(0);
      expect(doc.tree).toBeDefined();
      expect(doc.tree!.children.length).toBeGreaterThan(0);
      expect(doc.stats.chunkCount).toBe(doc.chunks.length);

      // Every chunk's parentId must reference an existing chunk (or be undefined for root).
      const ids = new Set(doc.chunks.map(c => c.id));
      for (const c of doc.chunks) {
        if (c.parentId) expect(ids.has(c.parentId)).toBe(true);
        expect(c.source.documentId).toBe(doc.id);
        expect(c.source.sourceType).toBe('excel');
      }

      // At least one table chunk should exist for table fixtures.
      const tableChunks = doc.chunks.filter(c => c.type === 'table');
      expect(tableChunks.length).toBeGreaterThan(0);

      // Assets referenced by storage should actually exist on disk.
      // FsStorage.putAsset returns ref already namespaced under <documentId>/...
      for (const a of doc.assets) {
        const abs = path.join(outDir, a.ref);
        const stat = await fs.stat(abs).catch(() => null);
        expect(stat, `asset missing on disk: ${a.ref}`).not.toBeNull();
        expect(stat!.size).toBeGreaterThan(0);
      }

      // Snapshot a stable shape (omit volatile fields).
      const stableTree = stripVolatile(doc.tree);
      expect(stableTree).toMatchSnapshot();
    }, 120_000);
  }
});

function stripVolatile(node: any): any {
  if (!node) return node;
  return {
    title: node.title,
    metadata: { kind: node.metadata?.kind, depth: node.metadata?.depth },
    children: (node.children ?? []).map(stripVolatile),
  };
}
