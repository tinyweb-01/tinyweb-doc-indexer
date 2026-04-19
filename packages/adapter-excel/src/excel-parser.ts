// Excel parser using tinyweb-office-cells
import { Workbook } from 'tinyweb-office-cells';
import type { ParsedWorkbook, ParsedSheet, ParsedCell } from './types';

/**
 * Parse an Excel buffer into a structured ParsedWorkbook.
 */
export async function parseExcelBuffer(buffer: Buffer, fileName: string): Promise<ParsedWorkbook> {
  const workbook = await Workbook.loadFromBuffer(buffer);
  const sheets: ParsedSheet[] = [];

  for (const ws of workbook.worksheets) {
    const cells: ParsedCell[] = [];
    const cellsCollection = ws.cells;

    // Iterate all cells in the internal map
    for (const [ref, cell] of cellsCollection._cells.entries()) {
      const { row, col } = parseA1(ref);
      const style = cell.style;
      const font = style?.font;

      const rawVal = cell.value;
      const value: string | number | boolean | null =
        rawVal instanceof Date ? rawVal.toISOString() : (rawVal ?? null);

      // Extract fill color
      let fillColor: string | undefined;
      const fill = style?.fill as any;
      if (fill?.foregroundColor) {
        const c = String(fill.foregroundColor);
        // ARGB format like "FFD9E6FC" — skip if white/transparent
        if (c.length >= 6 && c !== 'FFFFFFFF' && c !== '00000000') {
          fillColor = '#' + c.slice(-6);
        }
      }

      // Extract font color
      let fontColor: string | undefined;
      const fontAny = font as any;
      if (fontAny?.color) {
        const c = String(fontAny.color);
        if (c.length >= 6 && c !== 'FF000000') {
          fontColor = '#' + c.slice(-6);
        }
      }

      cells.push({
        ref,
        value,
        formula: cell.formula ?? null,
        isBold: font?.bold ?? false,
        fontSize: font?.size ?? null,
        isMerged: false,
        row,
        col,
        fillColor,
        fontColor,
        isStrikethrough: fontAny?.strikethrough ?? fontAny?.strike ?? false,
      });
    }

    // Mark merged cells
    const mergedCells = ws._mergedCells || [];
    for (const mergeRange of mergedCells) {
      for (const c of cells) {
        if (isInRange(c.ref, mergeRange)) {
          c.isMerged = true;
        }
      }
    }

    const maxRow = cells.reduce((m, c) => Math.max(m, c.row), 0);
    const maxCol = cells.reduce((m, c) => Math.max(m, c.col), 0);

    // Detect hidden / veryHidden worksheets via tinyweb-office-cells API.
    // `isVisible` is false for both hidden and veryHidden states.
    const wsAny = ws as any;
    const hidden =
      typeof wsAny.isVisible === 'boolean'
        ? !wsAny.isVisible
        : wsAny.visible === false || wsAny.visible === 'veryHidden';

    sheets.push({
      name: ws.name,
      cells,
      mergedCells,
      maxRow,
      maxCol,
      hidden,
    });
  }

  return { fileName, sheets };
}

function parseA1(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return { row: 0, col: 0 };
  const colStr = match[1];
  const row = parseInt(match[2], 10);
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { row, col };
}

function isInRange(ref: string, range: string): boolean {
  const parts = range.split(':');
  if (parts.length !== 2) return false;
  const start = parseA1(parts[0]);
  const end = parseA1(parts[1]);
  const cell = parseA1(ref);
  return cell.row >= start.row && cell.row <= end.row &&
         cell.col >= start.col && cell.col <= end.col;
}
