// Table row classifier - classifies rows in tabular Excel sheets
import type { ParsedCell, ParsedSheet } from '../types';

export enum RowType {
  HEADER = 'HEADER',
  CATEGORY = 'CATEGORY',
  STEP = 'STEP',
  SUBSECTION = 'SUBSECTION',
  TASK = 'TASK',
  SUBTOTAL = 'SUBTOTAL',
  EMPTY = 'EMPTY',
}

export interface ClassifiedRow {
  rowNum: number;
  type: RowType;
  cells: ParsedCell[];
  label: string;         // primary text label for this row
  isCancelled: boolean;  // strikethrough/red = cancelled
}

const STEP_RE = /^Step\s*\d+/i;
const SUBTOTAL_RE = /小計|合計|subtotal|total/i;
const HEADER_FILL = '#205EB5';

/**
 * Get cell at a specific column for a given row's cells.
 */
function cellAtCol(cells: ParsedCell[], col: number): ParsedCell | undefined {
  return cells.find(c => c.col === col);
}

/**
 * Check if columns D-K (col 4-11) have numeric data.
 */
function hasNumericData(cells: ParsedCell[]): boolean {
  return cells.some(c => c.col >= 4 && c.col <= 11 && typeof c.value === 'number');
}

/**
 * Classify all rows in a parsed sheet into structured row types.
 */
export function classifyRows(sheet: ParsedSheet): ClassifiedRow[] {
  // Group cells by row
  const rowMap = new Map<number, ParsedCell[]>();
  for (const cell of sheet.cells) {
    if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
    rowMap.get(cell.row)!.push(cell);
  }

  const results: ClassifiedRow[] = [];
  const sortedRows = Array.from(rowMap.keys()).sort((a, b) => a - b);

  for (const rowNum of sortedRows) {
    const cells = rowMap.get(rowNum)!;
    const classified = classifyRow(rowNum, cells);
    results.push(classified);
  }

  return results;
}

function classifyRow(rowNum: number, cells: ParsedCell[]): ClassifiedRow {
  const isCancelled = cells.some(c => c.isStrikethrough);

  // Check for header row (blue fill)
  if (cells.some(c => c.fillColor?.toUpperCase() === HEADER_FILL)) {
    return { rowNum, type: RowType.HEADER, cells, label: getLabel(cells), isCancelled };
  }

  const colA = cellAtCol(cells, 1); // Column A
  const colB = cellAtCol(cells, 2); // Column B
  const colC = cellAtCol(cells, 3); // Column C

  // Check for Category: bold text in A+B with a number in A
  if (colA?.isBold && colA.value != null && String(colA.value).trim() !== '') {
    const label = [colA.value, colB?.value, colC?.value].filter(Boolean).join(' ').trim();
    return { rowNum, type: RowType.CATEGORY, cells, label, isCancelled };
  }

  // Get column C text
  const cText = colC?.value != null ? String(colC.value).trim() : '';

  if (!cText) {
    return { rowNum, type: RowType.EMPTY, cells, label: '', isCancelled };
  }

  // Check for Step heading: bold C matching Step N:
  if (colC?.isBold && STEP_RE.test(cText)) {
    return { rowNum, type: RowType.STEP, cells, label: cText, isCancelled };
  }

  // Check for Subtotal: bold C with subtotal keywords
  if (colC?.isBold && SUBTOTAL_RE.test(cText)) {
    return { rowNum, type: RowType.SUBTOTAL, cells, label: cText, isCancelled };
  }

  // Check for Sub-section label: bold C, no numeric data in D-K
  if (colC?.isBold && !hasNumericData(cells)) {
    return { rowNum, type: RowType.SUBSECTION, cells, label: cText, isCancelled };
  }

  // Task row: has text in C and data in D-K
  if (cText) {
    return { rowNum, type: RowType.TASK, cells, label: cText, isCancelled };
  }

  return { rowNum, type: RowType.EMPTY, cells, label: '', isCancelled };
}

function getLabel(cells: ParsedCell[]): string {
  return cells
    .filter(c => c.value != null && String(c.value).trim() !== '')
    .map(c => String(c.value).trim())
    .join(' | ');
}

/**
 * Detect if a sheet is a table-type sheet (vs document-type).
 * Table sheets have: header row with column labels + numeric data columns.
 */
export function isTableSheet(sheet: ParsedSheet): boolean {
  // Group cells by row
  const rowMap = new Map<number, ParsedCell[]>();
  for (const cell of sheet.cells) {
    if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
    rowMap.get(cell.row)!.push(cell);
  }

  // Check first 3 rows for header-like patterns
  let hasHeaderRow = false;
  let numericColCount = 0;

  for (const [rowNum, cells] of rowMap) {
    if (rowNum <= 3) {
      // Header detection: multiple bold cells across columns
      const boldCount = cells.filter(c => c.isBold).length;
      if (boldCount >= 3 && cells.length >= 5) {
        hasHeaderRow = true;
      }
    }
    // Count rows with numeric data in multiple columns
    const numericCols = cells.filter(c => typeof c.value === 'number').length;
    if (numericCols >= 3) numericColCount++;
  }

  return hasHeaderRow && numericColCount >= 5;
}
