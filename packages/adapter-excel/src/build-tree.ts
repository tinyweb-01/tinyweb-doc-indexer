// Build-tree orchestrator
// Combines region detection + table capture + heading tree into one MindmapNode tree.
//
// Rules:
//  • A region of type 'table' becomes a LEAF MindmapNode (kind: 'table'),
//    optionally carrying a captured PNG asset ref and a written index file ref.
//  • Non-table rows feed into buildHeadingTreeForSheet to produce normal headings.
//  • Sheet node aggregates table-leaves and heading-children, sorted by source row.
//
// Refactored for @tinyweb_dev/doc-indexer-excel:
//   - Persists PNGs / JSON via the Storage abstraction (no fs.writeFile).
//   - Uses ctx.llm for table enrichment when available.
//   - Returns the in-memory MindmapNode tree; the adapter `index()` translates
//     this tree into chunk/asset/tree events.

import type { LLMProvider, Storage } from '@tinyweb_dev/doc-indexer-core';
import type { ParsedWorkbook, ParsedSheet, MindmapNode } from './types';
import { captureTableImages, captureFullSheetImages, type TableCapture, type SheetCapture } from './table/capture';
import { buildHeadingTreeForSheet, _resetNodeCounter, _nextNodeId } from './structure-detector';
import { buildTableArtifact, writeArtifact } from './table/output-formatter';
import { enrichWithLLM, applyEnrichment } from './table/llm-enricher';

export interface BuildTreeOptions {
  buffer: Buffer;
  fileName: string;
  /** Storage to persist PNGs and table-index JSON. When omitted, nothing is persisted. */
  storage?: Storage;
  /** Document ID used as namespace for storage assets. Required if `storage` is set. */
  documentId?: string;
  /** Optional file-name prefix for artifacts (defaults to baseName of fileName). */
  namePrefix?: string;
  /** LLM provider (used for optional table enrichment). */
  llm?: LLMProvider;
  /** When true and `llm` is set, enrich table_meta via LLM. */
  useLLM?: boolean;
}

/** Build a mindmap tree for the entire workbook with table-leaf semantics. */
export async function buildMindmapTree(
  workbook: ParsedWorkbook,
  opts: BuildTreeOptions,
): Promise<MindmapNode> {
  _resetNodeCounter();

  const captureOpts = {
    storage: opts.storage,
    documentId: opts.documentId,
  };

  // 1a. Capture all table PNGs once (persists via storage if provided)
  const captures: TableCapture[] = await captureTableImages(opts.buffer, opts.fileName, captureOpts);

  // Group captures by sheet name
  const capsBySheet = new Map<string, TableCapture[]>();
  for (const c of captures) {
    if (!capsBySheet.has(c.sheetName)) capsBySheet.set(c.sheetName, []);
    capsBySheet.get(c.sheetName)!.push(c);
  }

  // 1b. Capture each full sheet PNG (best-effort; skip on failure)
  let sheetCaptures: SheetCapture[] = [];
  try {
    sheetCaptures = await captureFullSheetImages(opts.buffer, opts.fileName, captureOpts);
  } catch (err) {
    console.warn('[build-tree] full-sheet capture skipped:', err);
  }
  const sheetRefBySheet = new Map<string, string | undefined>();
  for (const s of sheetCaptures) {
    sheetRefBySheet.set(s.sheetName, s.assetRef);
  }

  // 2. Build root document node
  const root: MindmapNode = {
    id: _nextNodeId(),
    title: workbook.fileName,
    summary: `Workbook with ${workbook.sheets.length} sheet(s)`,
    children: [],
    depth: 0,
    kind: 'document',
  };

  // 3. Process each sheet
  for (const sheet of workbook.sheets) {
    if (sheet.hidden) {
      // Hidden sheets: show as a minimal leaf node (dimmed in UI), no analysis.
      const hiddenNode: MindmapNode = {
        id: _nextNodeId(),
        title: sheet.name,
        summary: 'Hidden sheet — skipped',
        children: [],
        sourceRange: `${sheet.name}!A1`,
        depth: 1,
        kind: 'sheet',
        payload: { kind: 'sheet', sheetName: sheet.name, hidden: true },
      };
      root.children.push(hiddenNode);
      continue;
    }
    const sheetNode = await buildSheetNode(sheet, capsBySheet.get(sheet.name) ?? [], opts);
    // Attach full-sheet asset ref into payload
    const sheetRef = sheetRefBySheet.get(sheet.name);
    sheetNode.payload = { kind: 'sheet', sheetName: sheet.name, pngPath: sheetRef };
    root.children.push(sheetNode);
  }

  reassignDepths(root, 0);
  return root;
}

async function buildSheetNode(
  sheet: ParsedSheet,
  caps: TableCapture[],
  opts: BuildTreeOptions,
): Promise<MindmapNode> {
  // a. Heading subtree: rows OUTSIDE captured table BLOCKS.
  const blockedRows = new Set<number>();
  for (const cap of caps) {
    for (let r = cap.block.startRow; r <= cap.block.endRow; r++) blockedRows.add(r);
  }
  const headingSheet: ParsedSheet =
    blockedRows.size === 0
      ? sheet
      : { ...sheet, cells: sheet.cells.filter(c => !blockedRows.has(c.row)) };
  let headingNodes = buildHeadingTreeForSheet(headingSheet);

  // Collapse redundant heading-of-same-name-as-sheet.
  const sheetTitleNorm = sheet.name.trim().toLowerCase();
  headingNodes = headingNodes.flatMap(n =>
    n.title.trim().toLowerCase() === sheetTitleNorm ? n.children : [n]
  );

  // Drop heading nodes that are merely the *title row(s)* sitting immediately
  // above a captured table block.
  const TITLE_PROXIMITY = 5;
  const blockStarts = caps.map(c => c.block.startRow);
  const headingRowOf = (n: MindmapNode): number | null => {
    const m = (n.sourceRange ?? '').match(/!([A-Z]+)(\d+)/);
    return m ? parseInt(m[2], 10) : null;
  };
  const isTableTitleHeading = (n: MindmapNode): boolean => {
    if (n.children.length > 0) return false;
    const row = headingRowOf(n);
    if (row == null) return false;
    return blockStarts.some(s => row < s && s - row <= TITLE_PROXIMITY);
  };
  headingNodes = headingNodes.filter(n => !isTableTitleHeading(n));

  // b. Table leaves: one per capture
  const tableNodes: MindmapNode[] = [];
  for (const cap of caps) {
    const tableNode = await buildTableLeaf(sheet, cap, opts);
    tableNodes.push(tableNode);
  }

  // c. Combine, sort by source row
  const all = [...headingNodes, ...tableNodes];
  all.sort((a, b) => sortKey(a) - sortKey(b));

  return {
    id: _nextNodeId(),
    title: sheet.name,
    summary: `${sheet.cells.length} cells · ${tableNodes.length} table(s)`,
    children: all,
    sourceRange: `${sheet.name}!A1`,
    depth: 1,
    kind: 'sheet',
  };
}

async function buildTableLeaf(
  sheet: ParsedSheet,
  cap: TableCapture,
  opts: BuildTreeOptions,
): Promise<MindmapNode> {
  const label = `${sheet.name} · table ${cap.regionIndex + 1} (${cap.range})`;

  // Slice sheet to table region
  const subSheet: ParsedSheet = {
    ...sheet,
    cells: sheet.cells.filter(
      c =>
        c.row >= cap.block.startRow && c.row <= cap.block.endRow &&
        c.col >= cap.block.startCol && c.col <= cap.block.endCol,
    ),
    maxRow: cap.block.endRow,
    maxCol: cap.block.endCol,
  };

  const baseName = (opts.namePrefix ?? opts.fileName).replace(/\.[^.]+$/, '');
  const tableLabel = `${sheet.name}_table_${cap.regionIndex}`;

  let indexRef: string | undefined;
  let tableMeta: { name: string; description: string; sql_indexable: boolean; rows: number; cols: number } = {
    name: tableLabel,
    description: '',
    sql_indexable: false,
    rows: cap.block.endRow - cap.block.startRow + 1,
    cols: cap.block.endCol - cap.block.startCol + 1,
  };

  // Try to build & write the table artifact (best-effort).
  try {
    const artifact = buildTableArtifact(subSheet, {
      sheetName: tableLabel,
      fileNamePrefix: `${baseName}_${tableLabel}`,
      maxLinesPerFile: 500,
      inlineThreshold: 500,
      image: cap.assetRef,
      dataBounds: cap.block,
    });

    // Optional LLM enrichment of table_meta.name / description.
    if (opts.useLLM && opts.llm) {
      try {
        const enrichment = await enrichWithLLM(artifact.index, subSheet, {
          enabled: true,
          llm: opts.llm,
        });
        applyEnrichment(artifact.index, enrichment);
      } catch (err) {
        console.warn(`[build-tree] LLM enrichment failed for ${tableLabel}:`, err);
      }
    }

    if (opts.storage && opts.documentId) {
      const written = await writeArtifact(artifact, opts.storage, opts.documentId);
      indexRef = written.indexRef;
    }
    tableMeta = {
      name: artifact.index.table_meta.name,
      description: artifact.index.table_meta.description,
      sql_indexable: artifact.index.table_meta.sql_indexable,
      rows: tableMeta.rows,
      cols: tableMeta.cols,
    };
  } catch (err) {
    console.warn(`[build-tree] buildTableArtifact failed for ${tableLabel}:`, err);
  }

  return {
    id: _nextNodeId(),
    title: label,
    summary: tableMeta.description || `Table region ${cap.range}`,
    children: [],
    sourceRange: `${sheet.name}!${cap.range}`,
    depth: 2,
    kind: 'table',
    payload: {
      kind: 'table',
      range: cap.range,
      pngPath: cap.assetRef,
      indexFile: indexRef,
      tableMeta,
    },
  };
}

/** Extract starting row from sourceRange like "Sheet1!A12:D40" or "Sheet1!A12". */
function sortKey(n: MindmapNode): number {
  const sr = n.sourceRange ?? '';
  const m = sr.match(/!([A-Z]+)(\d+)/);
  return m ? parseInt(m[2], 10) : 0;
}

function reassignDepths(node: MindmapNode, depth: number): void {
  node.depth = depth;
  for (const c of node.children) reassignDepths(c, depth + 1);
}
