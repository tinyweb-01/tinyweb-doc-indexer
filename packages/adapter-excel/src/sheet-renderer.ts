// Sheet Renderer — converts Excel file/worksheet to PNG image
// Uses tinyweb-office-cells built-in rendering (worksheetToHtml + worksheetToPng)

import { Workbook, worksheetToHtml, worksheetToPng } from 'tinyweb-office-cells';
import type { ParsedSheet } from './types';

export interface RenderResult {
  /** PNG buffer of the rendered sheet */
  png: Buffer;
  /** Which renderer was used */
  renderer: 'tinyweb-office-cells';
}

/**
 * Render an Excel file to PNG using tinyweb-office-cells.
 */
export async function renderSheetToPng(
  excelFilePath: string,
  sheetIndex: number = 0,
): Promise<RenderResult> {
  const { readFileSync } = await import('fs');
  const buffer = readFileSync(excelFilePath);
  const workbook = await Workbook.loadFromBuffer(buffer);
  const ws = workbook.worksheets[sheetIndex];
  if (!ws) throw new Error(`Sheet index ${sheetIndex} not found`);

  const png = await worksheetToPng(ws);
  return { png, renderer: 'tinyweb-office-cells' };
}

/**
 * Render a ParsedSheet to PNG.
 * Reconstructs a tinyweb-office-cells Worksheet from parsed data, then renders.
 */
export async function renderParsedSheetToPng(
  sheet: ParsedSheet,
): Promise<RenderResult> {
  const { Worksheet, Cells } = await import('tinyweb-office-cells');
  const ws = new Worksheet(sheet.name);

  // Populate cells
  for (const cell of sheet.cells) {
    const c = ws.cells.cell(cell.row - 1, cell.col - 1);
    if (cell.value !== null && cell.value !== undefined) {
      c.value = cell.value;
    }
    if (cell.isBold) c.style.font.bold = true;
    if (cell.fontSize) c.style.font.size = cell.fontSize;
    if (cell.isStrikethrough) c.style.font.strikethrough = true;

    if (cell.fillColor) {
      // Convert #RRGGBB to ARGB
      const hex = cell.fillColor.replace('#', '');
      c.style.fill.setSolidFill('FF' + hex.toUpperCase());
    }
    if (cell.fontColor) {
      const hex = cell.fontColor.replace('#', '');
      c.style.font.color = 'FF' + hex.toUpperCase();
    }
  }

  // Apply merged cells
  for (const range of sheet.mergedCells) {
    ws.cells.mergeRange(range);
  }

  const png = await worksheetToPng(ws);
  return { png, renderer: 'tinyweb-office-cells' };
}

/**
 * Render a worksheet to HTML string.
 */
export function renderSheetToHtml(
  ws: any,
  options?: { fullPage?: boolean; defaultFont?: string },
): string {
  return worksheetToHtml(ws, options);
}
