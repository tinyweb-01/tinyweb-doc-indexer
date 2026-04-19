// PdfAdapter — text extraction per page via pdfjs-dist (legacy build, no DOM/canvas required).
//
// MVP scope:
//   - 1 Chunk per page (type: 'page'/'section').
//   - Tree: document → page[] (depth 1).
//   - No render-to-PNG, no OCR fallback (these are deferred).
//
// pdfjs-dist exposes a Node-friendly entry under 'pdfjs-dist/legacy/build/pdf.mjs'.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  SourceAdapter,
  IndexContext,
} from '@tinyweb_dev/doc-indexer-core';
import type {
  SourceInput,
  IndexedEvent,
  Chunk,
  AssetManifest,
  TreeNode,
  IndexedDocument,
} from '@tinyweb_dev/doc-indexer-core';

/**
 * Lazy-load pdfjs-dist legacy build. Done at runtime so consumers that never
 * call PdfAdapter.index() don't pay the import cost / don't need the dep
 * resolved. Returns the `getDocument` factory + relevant types.
 */
async function loadPdfjs(): Promise<any> {
  // The legacy build is shipped as ESM `.mjs` and works in Node 18+ without
  // any DOM polyfill (it uses no canvas, no DOMMatrix when only extracting text).
  // We ignore the type because pdfjs-dist's published types target the browser.
  // @ts-ignore
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return mod;
}

export class PdfAdapter implements SourceAdapter {
  readonly type = 'pdf' as const;

  detect(input: SourceInput): boolean {
    if (input.mime === 'application/pdf') return true;
    const p = (input.path ?? input.url ?? '').toLowerCase();
    return p.endsWith('.pdf');
  }

  async *index(input: SourceInput, ctx: IndexContext): AsyncIterable<IndexedEvent> {
    const t0 = Date.now();
    const buffer = await loadBuffer(input);
    const fileName = deriveFileName(input);

    ctx.logger.info(`[pdf-adapter] indexing ${fileName} (${buffer.byteLength} bytes)`);
    yield { kind: 'progress', pct: 5, message: 'loading pdf' };

    const pdfjs = await loadPdfjs();

    // pdfjs wants a Uint8Array (not Node Buffer) to avoid retention issues.
    const data = new Uint8Array(buffer);
    const loadingTask = pdfjs.getDocument({
      data,
      // Silence the noisy "Warning: TT" font warnings in CI logs.
      verbosity: 0,
      // No standard fonts / cmaps lookup — fine for pure text extraction.
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;

    const numPages: number = pdf.numPages;
    ctx.logger.info(`[pdf-adapter] ${fileName}: ${numPages} pages`);

    yield { kind: 'progress', pct: 15, message: `extracting text from ${numPages} pages` };

    const chunks: Chunk[] = [];
    const assets: AssetManifest[] = [];

    // Root chunk for the document itself (acts as the tree root's payload).
    const rootChunkId = `c-doc`;
    const rootChunk: Chunk = {
      id: rootChunkId,
      order: 0,
      type: 'section',
      title: fileName,
      content: fileName,
      source: {
        documentId: ctx.documentId,
        sourceType: 'pdf',
        locator: 'doc',
      },
      metadata: { kind: 'document', pageCount: numPages },
    };
    chunks.push(rootChunk);

    const pageNodes: TreeNode[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (ctx.signal?.aborted) {
        throw new Error('[pdf-adapter] aborted via signal');
      }

      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // textContent.items: { str: string, transform: number[], width, height, ... }[]
      // Reconstruct lines by Y coordinate (transform[5]) — pdfjs returns items
      // in painting order which is usually top-to-bottom but interleaves columns.
      const text = renderTextContent(textContent.items as PdfTextItem[]);

      const chunkId = `c-p${pageNum}`;
      const chunk: Chunk = {
        id: chunkId,
        parentId: rootChunkId,
        order: pageNum,
        type: 'section',
        title: `Page ${pageNum}`,
        content: text,
        source: {
          documentId: ctx.documentId,
          sourceType: 'pdf',
          locator: `page:${pageNum}`,
          page: pageNum,
        },
        metadata: { kind: 'page', page: pageNum },
      };
      chunks.push(chunk);

      pageNodes.push({
        id: `p${pageNum}`,
        title: `Page ${pageNum}`,
        chunkId,
        children: [],
        metadata: { kind: 'page', page: pageNum },
      });

      // Free per-page resources promptly.
      page.cleanup();

      const pct = 15 + Math.round((pageNum / numPages) * 75);
      if (pageNum % Math.max(1, Math.floor(numPages / 10)) === 0 || pageNum === numPages) {
        yield { kind: 'progress', pct, message: `page ${pageNum}/${numPages}` };
      }
    }

    await pdf.cleanup();
    await pdf.destroy();

    const tree: TreeNode = {
      id: 'doc',
      title: fileName,
      chunkId: rootChunkId,
      children: pageNodes,
      metadata: { kind: 'document', pageCount: numPages },
    };

    yield { kind: 'progress', pct: 92, message: 'emitting chunks' };

    for (const ch of chunks) yield { kind: 'chunk', chunk: ch };
    for (const a of assets) yield { kind: 'asset', asset: a };
    yield { kind: 'tree', tree };
    yield { kind: 'progress', pct: 100, message: 'done' };

    const doc: IndexedDocument = {
      id: ctx.documentId,
      title: fileName,
      sourceType: 'pdf',
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

interface PdfTextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e, f] — translation in [4]/[5]
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/**
 * Reconstruct readable text from pdfjs `textContent.items`.
 *
 * pdfjs flattens text by painting order. We:
 *   1. Group items by (rounded) Y coordinate to form lines.
 *   2. Sort lines top→bottom (PDF Y axis is bottom-up, so DESC by Y).
 *   3. Sort items within each line left→right (ASC by X).
 *   4. Insert spaces where the gap between items > ~half avg char width.
 */
function renderTextContent(items: PdfTextItem[]): string {
  if (!items.length) return '';

  // Bucket by rounded Y. Round to 2 px tolerance to merge same-line items.
  const lineMap = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = Math.round((it.transform?.[5] ?? 0) / 2) * 2;
    const arr = lineMap.get(y);
    if (arr) arr.push(it);
    else lineMap.set(y, [it]);
  }

  const ys = [...lineMap.keys()].sort((a, b) => b - a); // top → bottom
  const lines: string[] = [];
  for (const y of ys) {
    const lineItems = lineMap.get(y)!;
    lineItems.sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0));

    let prevEnd = -Infinity;
    let prevH = 12;
    let buf = '';
    for (const it of lineItems) {
      const x = it.transform?.[4] ?? 0;
      const w = it.width ?? 0;
      const h = (it.height as number | undefined) ?? prevH;
      // Insert a space when there's a non-trivial gap from the previous item
      // and the current item doesn't already start with whitespace.
      if (buf && x - prevEnd > h * 0.25 && !/^\s/.test(it.str) && !/\s$/.test(buf)) {
        buf += ' ';
      }
      buf += it.str;
      prevEnd = x + w;
      prevH = h;
    }
    const trimmed = buf.replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines.join('\n');
}

async function loadBuffer(input: SourceInput): Promise<Buffer> {
  if (input.buffer) return Buffer.from(input.buffer);
  if (input.path) return fs.readFile(input.path);
  throw new Error('[pdf-adapter] SourceInput must provide `buffer` or `path`.');
}

function deriveFileName(input: SourceInput): string {
  if (input.path) return path.basename(input.path);
  if (input.url) return path.basename(input.url.split('?')[0]) || 'document.pdf';
  return 'document.pdf';
}
