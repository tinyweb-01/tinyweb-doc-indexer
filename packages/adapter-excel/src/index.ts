import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetManifest,
  Chunk,
  IndexContext,
  IndexedDocument,
  IndexedEvent,
  SourceAdapter,
  SourceInput,
  TreeNode,
} from '@tinyweb_dev/doc-indexer-core';

import { parseExcelBuffer } from './excel-parser';
import { buildMindmapTree } from './build-tree';
import { exportMarkdownTree } from './markdown-tree-exporter';
import type {
  MindmapNode,
  TableNodePayload,
  SheetNodePayload,
} from './types';

/**
 * Excel adapter — parses an .xlsx workbook into a mindmap tree of
 * Sheet → Heading → Table leaves, persists per-table PNG snapshots and
 * AI-friendly index JSON via `ctx.storage`, and emits a stream of
 * `chunk` / `asset` / `tree` / `done` events.
 */
export class ExcelAdapter implements SourceAdapter {
  readonly type = 'excel' as const;

  detect(input: SourceInput): boolean {
    if (input.mime?.includes('spreadsheetml')) return true;
    const p = (input.path ?? input.url ?? '').toLowerCase();
    return p.endsWith('.xlsx') || p.endsWith('.xls') || p.endsWith('.xlsm');
  }

  async *index(input: SourceInput, ctx: IndexContext): AsyncIterable<IndexedEvent> {
    const t0 = Date.now();
    const buffer = await loadBuffer(input);
    const fileName = deriveFileName(input);

    ctx.logger.info(`[excel-adapter] indexing ${fileName} (${buffer.byteLength} bytes)`);
    yield { kind: 'progress', pct: 5, message: 'parsing workbook' };

    const useLLM = Boolean(ctx.options.useLLM ?? ctx.llm);

    const workbook = await parseExcelBuffer(buffer, fileName);
    yield { kind: 'progress', pct: 25, message: 'building mindmap tree' };

    const root = await buildMindmapTree(workbook, {
      buffer,
      fileName,
      storage: ctx.storage,
      documentId: ctx.documentId,
      namePrefix: fileName.replace(/\.[^.]+$/, ''),
      llm: ctx.llm,
      useLLM,
    });

    yield { kind: 'progress', pct: 80, message: 'emitting chunks' };

    // Walk the mindmap and emit chunks + assets, building a TreeNode mirror.
    const chunks: Chunk[] = [];
    const assets: AssetManifest[] = [];
    let order = 0;

    const walk = (node: MindmapNode, parentChunkId?: string): TreeNode => {
      const chunkId = `c-${node.id}`;
      const kind = node.kind ?? 'heading';

      // Build chunk.
      const chunk: Chunk = {
        id: chunkId,
        parentId: parentChunkId,
        order: order++,
        type: kind === 'table' ? 'table' : kind === 'sheet' ? 'section' : 'section',
        title: node.title,
        content: node.summary ?? node.title,
        contentRich: node.payload,
        source: {
          documentId: ctx.documentId,
          sourceType: 'excel',
          locator: node.sourceRange ?? `node:${node.id}`,
          sheet: extractSheetName(node.sourceRange),
        },
        metadata: {
          depth: node.depth,
          kind,
        },
      };

      // Lift assets from payload.
      const nodeAssets: AssetManifest[] = [];
      if (kind === 'table') {
        const p = node.payload as TableNodePayload | undefined;
        if (p?.pngPath) {
          const a: AssetManifest = { kind: 'image', ref: p.pngPath, alt: node.title };
          nodeAssets.push(a);
          assets.push(a);
        }
        if (p?.indexFile) {
          const a: AssetManifest = { kind: 'file', ref: p.indexFile, alt: `${node.title} index`, mime: 'application/json' };
          nodeAssets.push(a);
          assets.push(a);
        }
      } else if (kind === 'sheet') {
        const p = node.payload as SheetNodePayload | undefined;
        if (p?.pngPath) {
          const a: AssetManifest = { kind: 'snapshot', ref: p.pngPath, alt: node.title };
          nodeAssets.push(a);
          assets.push(a);
        }
      }
      if (nodeAssets.length) chunk.assets = nodeAssets;

      chunks.push(chunk);

      const treeNode: TreeNode = {
        id: node.id,
        title: node.title,
        chunkId,
        children: node.children.map(c => walk(c, chunkId)),
        metadata: { kind, depth: node.depth, sourceRange: node.sourceRange },
      };
      return treeNode;
    };

    const tree = walk(root);

    // Mirror the mindmap as a markdown folder tree under `<docId>/tree/`
    // (plus a top-level README.md). Failure must NOT abort indexing.
    try {
      await exportMarkdownTree({
        storage: ctx.storage,
        documentId: ctx.documentId,
        root,
      });
    } catch (err) {
      ctx.logger.warn(`[excel-adapter] markdown tree export failed: ${(err as Error).message}`);
    }

    // Stream events out.
    for (const ch of chunks) yield { kind: 'chunk', chunk: ch };
    for (const a of assets) yield { kind: 'asset', asset: a };
    yield { kind: 'tree', tree };
    yield { kind: 'progress', pct: 100, message: 'done' };

    const doc: IndexedDocument = {
      id: ctx.documentId,
      title: fileName,
      sourceType: 'excel',
      createdAt: new Date().toISOString(),
      chunks,
      tree,
      assets,
      stats: {
        chunkCount: chunks.length,
        tokenEstimate: chunks.reduce((s, c) => s + Math.ceil((c.content?.length ?? 0) / 4), 0),
        durationMs: Date.now() - t0,
      },
    };
    yield { kind: 'done', doc };
  }
}

// ---- helpers --------------------------------------------------------------

async function loadBuffer(input: SourceInput): Promise<Buffer> {
  if (input.buffer) return Buffer.from(input.buffer);
  if (input.path) return fs.readFile(input.path);
  throw new Error('[excel-adapter] SourceInput must provide `buffer` or `path`.');
}

function deriveFileName(input: SourceInput): string {
  if (input.path) return path.basename(input.path);
  if (input.url) return path.basename(input.url.split('?')[0]) || 'workbook.xlsx';
  return 'workbook.xlsx';
}

function extractSheetName(sourceRange?: string): string | undefined {
  if (!sourceRange) return undefined;
  const i = sourceRange.indexOf('!');
  return i > 0 ? sourceRange.slice(0, i) : undefined;
}
