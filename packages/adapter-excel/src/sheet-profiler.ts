// Sheet Profiler — statistical analysis of a ParsedSheet
// Produces a SheetProfile with column stats, color patterns, merge topology, etc.
import type { ParsedSheet, ParsedCell } from './types';

// ── Types ──────────────────────────────────────────────────────

export interface ColumnProfile {
  col: number;
  colLetter: string;
  fillRate: number;           // 0–1, % of rows with non-empty value
  boldRate: number;           // 0–1, % of non-empty cells that are bold
  dataType: 'number' | 'text' | 'date' | 'formula' | 'boolean' | 'mixed' | 'empty';
  numberCount: number;
  textCount: number;
  formulaCount: number;
  uniqueValues: number;
  sampleValues: (string | number | boolean | null)[];  // up to 5 samples
}

export interface ColorUsage {
  color: string;
  count: number;
  rows: number[];             // which rows use this color
  isFill: boolean;            // true = fill color, false = font color
}

export interface MergeGroup {
  range: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  spanRows: number;
  spanCols: number;
  isVertical: boolean;        // spans multiple rows, 1 col
  isHorizontal: boolean;      // spans multiple cols, 1 row
}

export interface RowProfile {
  row: number;
  filledCols: number;
  boldCols: number;
  hasNumericData: boolean;
  fillColor: string | null;   // dominant fill color of this row
  fontColor: string | null;   // dominant font color
  isStrikethrough: boolean;
  isMergedAcross: boolean;    // has a horizontal merge spanning most cols
}

export interface SheetProfile {
  sheetName: string;
  totalRows: number;
  totalCols: number;
  totalCells: number;
  nonEmptyCells: number;

  // Sheet type heuristic
  sheetType: 'table' | 'document' | 'mixed' | 'empty';
  tableConfidence: number;    // 0–1

  // Column analysis
  columns: ColumnProfile[];

  // Row analysis
  rows: RowProfile[];

  // Color patterns
  fillColors: ColorUsage[];
  fontColors: ColorUsage[];

  // Merge topology
  mergeGroups: MergeGroup[];
  verticalMergeColumns: number[];  // columns with vertical merges (grouping cols)

  // Detected patterns
  headerRowCandidates: number[];   // rows likely to be headers
  subtotalRowCandidates: number[]; // rows likely to be subtotals
  numberingPattern: NumberingPattern | null;

  // Row uniformity
  medianFilledCols: number;
  rowUniformityScore: number;  // 0–1, how consistent row widths are
}

export interface NumberingPattern {
  type: 'dotted' | 'parenthesized' | 'step' | 'bare' | 'lettered';
  regex: RegExp;
  column: number;
  examples: string[];
}

// ── Helpers ────────────────────────────────────────────────────

function colToLetter(col: number): string {
  let s = '';
  let c = col;
  while (c > 0) {
    const r = (c - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostFrequent<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  const freq = new Map<T, number>();
  for (const v of arr) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best: T = arr[0];
  let bestCount = 0;
  for (const [v, c] of freq) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

// Numbering patterns to detect
const NUMBERING_PATTERNS: { type: NumberingPattern['type']; regex: RegExp }[] = [
  { type: 'dotted', regex: /^[\s\u3000]*[０-９0-9]+(?:[.．][０-９0-9]+)*[.．]/ },
  { type: 'parenthesized', regex: /^[\s\u3000]*\(?[０-９0-9]+\)/ },
  { type: 'step', regex: /^[\s\u3000]*Step\s*\d+/i },
  { type: 'bare', regex: /^[\s\u3000]*[0-9]+[\s\u3000]*$/ },
  { type: 'lettered', regex: /^[\s\u3000]*[A-Za-z][.．)\s]/ },
];

const SUBTOTAL_RE = /小計|合計|subtotal|total|sum|tổng|cộng/i;
const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;

// ── Main Profiler ──────────────────────────────────────────────

export function profileSheet(sheet: ParsedSheet): SheetProfile {
  const { name, cells, mergedCells, maxRow, maxCol } = sheet;

  if (cells.length === 0) {
    return emptyProfile(name);
  }

  // ── Group cells ──
  const byRow = new Map<number, ParsedCell[]>();
  const byCol = new Map<number, ParsedCell[]>();
  for (const cell of cells) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row)!.push(cell);
    if (!byCol.has(cell.col)) byCol.set(cell.col, []);
    byCol.get(cell.col)!.push(cell);
  }

  const allRows = [...byRow.keys()].sort((a, b) => a - b);
  const allCols = [...byCol.keys()].sort((a, b) => a - b);
  const nonEmptyCells = cells.filter(c => c.value != null && c.value !== '').length;

  // ── Column profiles ──
  const columns: ColumnProfile[] = allCols.map(col => {
    const colCells = byCol.get(col)!;
    const nonEmpty = colCells.filter(c => c.value != null && c.value !== '');
    const boldCells = nonEmpty.filter(c => c.isBold);

    let numberCount = 0, textCount = 0, formulaCount = 0, boolCount = 0, dateCount = 0;
    const uniqueVals = new Set<string>();
    const samples: (string | number | boolean | null)[] = [];

    for (const c of nonEmpty) {
      const v = c.value;
      uniqueVals.add(String(v));
      if (samples.length < 5) samples.push(v);

      if (c.formula) formulaCount++;
      else if (typeof v === 'number') numberCount++;
      else if (typeof v === 'boolean') boolCount++;
      else if (typeof v === 'string' && DATE_RE.test(v)) dateCount++;
      else textCount++;
    }

    let dataType: ColumnProfile['dataType'] = 'empty';
    if (nonEmpty.length === 0) dataType = 'empty';
    else if (formulaCount > nonEmpty.length * 0.5) dataType = 'formula';
    else if (numberCount > nonEmpty.length * 0.5) dataType = 'number';
    else if (dateCount > nonEmpty.length * 0.5) dataType = 'date';
    else if (boolCount > nonEmpty.length * 0.5) dataType = 'boolean';
    else if (textCount > nonEmpty.length * 0.5) dataType = 'text';
    else dataType = 'mixed';

    return {
      col,
      colLetter: colToLetter(col),
      fillRate: allRows.length > 0 ? nonEmpty.length / allRows.length : 0,
      boldRate: nonEmpty.length > 0 ? boldCells.length / nonEmpty.length : 0,
      dataType,
      numberCount,
      textCount,
      formulaCount,
      uniqueValues: uniqueVals.size,
      sampleValues: samples,
    };
  });

  // ── Row profiles ──
  const rows: RowProfile[] = allRows.map(row => {
    const rowCells = byRow.get(row)!;
    const nonEmpty = rowCells.filter(c => c.value != null && c.value !== '');
    const boldCells = nonEmpty.filter(c => c.isBold);
    const hasNumeric = rowCells.some(c => typeof c.value === 'number');

    const fillColors = nonEmpty.map(c => c.fillColor).filter(Boolean) as string[];
    const fontColors = nonEmpty.map(c => c.fontColor).filter(Boolean) as string[];
    const isStrike = rowCells.some(c => c.isStrikethrough);

    return {
      row,
      filledCols: nonEmpty.length,
      boldCols: boldCells.length,
      hasNumericData: hasNumeric,
      fillColor: mostFrequent(fillColors),
      fontColor: mostFrequent(fontColors),
      isStrikethrough: isStrike,
      isMergedAcross: false, // filled below
    };
  });

  // ── Color analysis ──
  const fillColorMap = new Map<string, { count: number; rows: Set<number> }>();
  const fontColorMap = new Map<string, { count: number; rows: Set<number> }>();
  for (const cell of cells) {
    if (cell.fillColor) {
      const entry = fillColorMap.get(cell.fillColor) ?? { count: 0, rows: new Set() };
      entry.count++;
      entry.rows.add(cell.row);
      fillColorMap.set(cell.fillColor, entry);
    }
    if (cell.fontColor) {
      const entry = fontColorMap.get(cell.fontColor) ?? { count: 0, rows: new Set() };
      entry.count++;
      entry.rows.add(cell.row);
      fontColorMap.set(cell.fontColor, entry);
    }
  }

  const fillColors: ColorUsage[] = [...fillColorMap.entries()]
    .map(([color, { count, rows }]) => ({ color, count, rows: [...rows].sort((a, b) => a - b), isFill: true }))
    .sort((a, b) => b.count - a.count);

  const fontColors: ColorUsage[] = [...fontColorMap.entries()]
    .map(([color, { count, rows }]) => ({ color, count, rows: [...rows].sort((a, b) => a - b), isFill: false }))
    .sort((a, b) => b.count - a.count);

  // ── Merge analysis ──
  const mergeGroups: MergeGroup[] = mergedCells.map(range => {
    const [startRef, endRef] = range.split(':');
    const start = parseA1Simple(startRef);
    const end = parseA1Simple(endRef);
    const spanRows = end.row - start.row + 1;
    const spanCols = end.col - start.col + 1;
    return {
      range,
      startRow: start.row, endRow: end.row,
      startCol: start.col, endCol: end.col,
      spanRows, spanCols,
      isVertical: spanRows > 1 && spanCols === 1,
      isHorizontal: spanCols > 1 && spanRows === 1,
    };
  });

  // Find columns with vertical merges (grouping columns)
  const vertMergeCols = new Map<number, number>();
  for (const mg of mergeGroups) {
    if (mg.isVertical) {
      vertMergeCols.set(mg.startCol, (vertMergeCols.get(mg.startCol) ?? 0) + 1);
    }
  }
  const verticalMergeColumns = [...vertMergeCols.entries()]
    .filter(([, count]) => count >= 2)
    .map(([col]) => col)
    .sort((a, b) => a - b);

  // Mark rows with horizontal merges spanning most columns
  for (const mg of mergeGroups) {
    if (mg.isHorizontal && mg.spanCols >= maxCol * 0.6) {
      const rp = rows.find(r => r.row === mg.startRow);
      if (rp) rp.isMergedAcross = true;
    }
  }

  // ── Header detection ──
  const headerRowCandidates: number[] = [];
  for (const rp of rows) {
    // High bold rate + many columns filled + in first few rows
    if (rp.row <= 5 && rp.boldCols >= 3 && rp.filledCols >= allCols.length * 0.5) {
      headerRowCandidates.push(rp.row);
    }
    // Or: distinct fill color used by very few rows (1-2) + bold
    if (rp.fillColor && rp.boldCols >= 3) {
      const colorUsage = fillColors.find(c => c.color === rp.fillColor);
      if (colorUsage && colorUsage.rows.length <= 3) {
        if (!headerRowCandidates.includes(rp.row)) headerRowCandidates.push(rp.row);
      }
    }
  }

  // ── Subtotal detection ──
  const subtotalRowCandidates: number[] = [];
  for (const rp of rows) {
    const rowCells = byRow.get(rp.row)!;
    const textValues = rowCells.map(c => String(c.value ?? '')).join(' ');
    if (SUBTOTAL_RE.test(textValues) && rp.boldCols >= 1) {
      subtotalRowCandidates.push(rp.row);
    }
  }

  // ── Numbering pattern ──
  let numberingPattern: NumberingPattern | null = null;
  for (const col of allCols.slice(0, 3)) { // check first 3 columns
    const colCells = byCol.get(col)!.filter(c => c.value != null && c.value !== '');
    for (const pat of NUMBERING_PATTERNS) {
      const matches = colCells.filter(c => pat.regex.test(String(c.value)));
      if (matches.length >= 3) {
        numberingPattern = {
          type: pat.type,
          regex: pat.regex,
          column: col,
          examples: matches.slice(0, 5).map(c => String(c.value)),
        };
        break;
      }
    }
    if (numberingPattern) break;
  }

  // ── Sheet type classification ──
  const filledColCounts = rows.map(r => r.filledCols);
  const medianFilledCols = median(filledColCounts);
  const wideRows = rows.filter(r => r.filledCols >= 4).length;
  const wideRowRatio = rows.length > 0 ? wideRows / rows.length : 0;

  // Uniformity: how consistent are row widths?
  const mean = filledColCounts.reduce((a, b) => a + b, 0) / (filledColCounts.length || 1);
  const variance = filledColCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (filledColCounts.length || 1);
  const stddev = Math.sqrt(variance);
  const rowUniformityScore = mean > 0 ? Math.max(0, 1 - stddev / mean) : 0;

  let sheetType: SheetProfile['sheetType'] = 'mixed';
  let tableConfidence = 0;

  if (cells.length === 0) {
    sheetType = 'empty';
  } else if (wideRowRatio > 0.5 && headerRowCandidates.length > 0) {
    sheetType = 'table';
    tableConfidence = Math.min(1, wideRowRatio * 0.6 + (headerRowCandidates.length > 0 ? 0.3 : 0) + rowUniformityScore * 0.1);
  } else if (wideRowRatio < 0.2 && medianFilledCols <= 2) {
    sheetType = 'document';
    tableConfidence = 0;
  } else {
    sheetType = 'mixed';
    tableConfidence = wideRowRatio * 0.5;
  }

  return {
    sheetName: name,
    totalRows: maxRow,
    totalCols: maxCol,
    totalCells: cells.length,
    nonEmptyCells,
    sheetType,
    tableConfidence,
    columns,
    rows,
    fillColors,
    fontColors,
    mergeGroups,
    verticalMergeColumns,
    headerRowCandidates,
    subtotalRowCandidates,
    numberingPattern,
    medianFilledCols,
    rowUniformityScore,
  };
}

function emptyProfile(name: string): SheetProfile {
  return {
    sheetName: name, totalRows: 0, totalCols: 0, totalCells: 0, nonEmptyCells: 0,
    sheetType: 'empty', tableConfidence: 0,
    columns: [], rows: [], fillColors: [], fontColors: [],
    mergeGroups: [], verticalMergeColumns: [],
    headerRowCandidates: [], subtotalRowCandidates: [],
    numberingPattern: null, medianFilledCols: 0, rowUniformityScore: 0,
  };
}

function parseA1Simple(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return { row: 0, col: 0 };
  let col = 0;
  for (let i = 0; i < match[1].length; i++) {
    col = col * 26 + (match[1].charCodeAt(i) - 64);
  }
  return { row: parseInt(match[2], 10), col };
}
