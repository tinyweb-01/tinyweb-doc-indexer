/**
 * Table Capture — detects tables in each sheet and renders each as a PNG image.
 *
 * Pipeline: load Excel → parse → profile → detect regions → filter tables → render each range to PNG.
 *
 * Refactored for @tinyweb_dev/doc-indexer-excel: writes PNG assets through the Storage abstraction
 * provided via IndexContext rather than `fs.writeFile`.
 */

import { Workbook, worksheetToPng } from 'tinyweb-office-cells';
import type { Storage } from '@tinyweb_dev/doc-indexer-core';
import { parseExcelBuffer } from '../excel-parser';
import { profileSheet } from '../sheet-profiler';
import { detectRegions, type Region } from '../region-detector';

// ── Types ──────────────────────────────────────────────────────

/** A block of merged consecutive regions (split at empty-gap boundaries) */
export interface RegionBlock {
  regions: Region[];
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface TableCapture {
  /** Sheet name */
  sheetName: string;
  /** 0-based sheet index */
  sheetIndex: number;
  /** Sequential index of this capture within the sheet */
  regionIndex: number;
  /** A1-style range string, e.g. "A3:F20" */
  range: string;
  /** The merged block of regions */
  block: RegionBlock;
  /** Rendered PNG buffer */
  pngBuffer: Buffer;
  /** Storage asset reference (e.g. "<documentId>/<name>") when persisted. */
  assetRef?: string;
  /** Asset filename (without documentId prefix). */
  assetName?: string;
}

export interface CaptureOptions {
  /** When provided, each PNG is persisted via storage.putAsset(documentId, name, buffer). */
  storage?: Storage;
  /** Document ID used as namespace for storage assets. Required if `storage` is set. */
  documentId?: string;
  /** Optional filename prefix (e.g. "<docId>_"). */
  namePrefix?: string;
}

// ── Helpers ────────────────────────────────────────────────────

function colToLetter(col: number): string {
  let s = '';
  let c = col;
  while (c > 0) {
    const rem = (c - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

function blockToA1Range(block: RegionBlock): string {
  const startCol = colToLetter(block.startCol);
  const endCol = colToLetter(block.endCol);
  return `${startCol}${block.startRow}:${endCol}${block.endRow}`;
}

/**
 * Merge consecutive non-empty-gap regions into blocks.
 * Each empty-gap region acts as a separator between blocks.
 */
function mergeRegionsIntoBlocks(regions: Region[]): RegionBlock[] {
  const blocks: RegionBlock[] = [];
  let current: Region[] = [];

  for (const r of regions) {
    if (r.type === 'empty-gap') {
      if (current.length > 0) {
        blocks.push(buildBlock(current));
        current = [];
      }
    } else {
      current.push(r);
    }
  }
  if (current.length > 0) {
    blocks.push(buildBlock(current));
  }
  return blocks;
}

function buildBlock(regions: Region[]): RegionBlock {
  return {
    regions,
    startRow: Math.min(...regions.map(r => r.startRow)),
    endRow: Math.max(...regions.map(r => r.endRow)),
    startCol: Math.min(...regions.map(r => r.startCol)),
    endCol: Math.max(...regions.map(r => r.endCol)),
  };
}

// ── Main API ───────────────────────────────────────────────────

/**
 * Detect all table regions in every sheet of an Excel file,
 * then render each table region as a separate PNG image.
 */
export async function captureTableImages(
  buffer: Buffer,
  fileName: string,
  opts: CaptureOptions = {},
): Promise<TableCapture[]> {
  const prefix = opts.namePrefix ?? '';
  // 1. Parse workbook structure (for region detection)
  const workbook = await parseExcelBuffer(buffer, fileName);

  // 2. Load native workbook (for rendering)
  const nativeWorkbook = await Workbook.loadFromBuffer(buffer);

  const results: TableCapture[] = [];

  for (let sheetIdx = 0; sheetIdx < workbook.sheets.length; sheetIdx++) {
    const parsedSheet = workbook.sheets[sheetIdx];
    const nativeWs = nativeWorkbook.worksheets[sheetIdx];
    if (!nativeWs) continue;

    // 3. Profile & detect regions
    const profile = profileSheet(parsedSheet);
    const regions = detectRegions(parsedSheet, profile);

    // 4. Merge consecutive non-empty-gap regions into blocks
    const blocks = mergeRegionsIntoBlocks(regions);

    // 5. Filter blocks that contain at least one table region
    const tableBlocks = blocks.filter(b =>
      b.regions.some(r => r.type === 'table'),
    );

    // 6. Render each block to PNG
    for (let i = 0; i < tableBlocks.length; i++) {
      const block = tableBlocks[i];
      const range = blockToA1Range(block);

      const pngBuffer = await worksheetToPng(nativeWs, { range });

      let assetRef: string | undefined;
      let assetName: string | undefined;
      if (opts.storage && opts.documentId) {
        const safeSheet = parsedSheet.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        // Include sheetIdx so two sheets whose names slug to the same string
        // (common with all-CJK names) don't collide.
        assetName = `images/${prefix}s${sheetIdx}_${safeSheet}_table_${i}.png`;
        assetRef = await opts.storage.putAsset(opts.documentId, assetName, pngBuffer, {
          mime: 'image/png',
        });
      }

      results.push({
        sheetName: parsedSheet.name,
        sheetIndex: sheetIdx,
        regionIndex: i,
        range,
        block,
        pngBuffer,
        assetRef,
        assetName,
      });
    }
  }

  return results;
}

// ── Full-sheet capture ─────────────────────────────────────────

export interface SheetCapture {
  sheetName: string;
  sheetIndex: number;
  pngBuffer: Buffer;
  assetRef?: string;
  assetName?: string;
}

/**
 * Render every worksheet as a single full-sheet PNG (no range filter),
 * using the same Workbook engine. Useful for sheet-level previews in the UI.
 */
export async function captureFullSheetImages(
  buffer: Buffer,
  fileName: string,
  opts: CaptureOptions = {},
): Promise<SheetCapture[]> {
  const prefix = opts.namePrefix ?? '';
  const workbook = await parseExcelBuffer(buffer, fileName);
  const nativeWorkbook = await Workbook.loadFromBuffer(buffer);

  const results: SheetCapture[] = [];
  for (let i = 0; i < workbook.sheets.length; i++) {
    const parsedSheet = workbook.sheets[i];
    const nativeWs = nativeWorkbook.worksheets[i];
    if (!nativeWs) continue;
    let pngBuffer: Buffer;
    try {
      pngBuffer = await worksheetToPng(nativeWs, {});
    } catch (err) {
      console.warn(`[capture] full-sheet render failed for "${parsedSheet.name}":`, err);
      continue;
    }
    let assetRef: string | undefined;
    let assetName: string | undefined;
    if (opts.storage && opts.documentId) {
      const safe = parsedSheet.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      assetName = `images/${prefix}s${i}_${safe}_sheet.png`;
      assetRef = await opts.storage.putAsset(opts.documentId, assetName, pngBuffer, {
        mime: 'image/png',
      });
    }
    results.push({ sheetName: parsedSheet.name, sheetIndex: i, pngBuffer, assetRef, assetName });
  }
  return results;
}
