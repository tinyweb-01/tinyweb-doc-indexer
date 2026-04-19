// Table tree builder - converts classified rows into a MindmapNode tree
import type { ParsedCell, ParsedSheet, MindmapNode } from '../types';
import { classifyRows, RowType, type ClassifiedRow } from './row-classifier';

/**
 * Extract key-value data from task/subtotal row cells (columns D-K).
 */
function extractRowData(row: ClassifiedRow, headerRow: ClassifiedRow | null): Record<string, any> {
  const data: Record<string, any> = {};
  for (const cell of row.cells) {
    if (cell.col >= 4 && cell.col <= 11 && cell.value != null) {
      // Use header label if available
      const headerCell = headerRow?.cells.find(c => c.col === cell.col);
      const key = headerCell?.value ? String(headerCell.value).trim() : `col${cell.col}`;
      data[key] = cell.value;
    }
  }
  return data;
}

/**
 * Build a MindmapNode tree from a table-type sheet.
 */
export function buildTableTree(sheet: ParsedSheet, sheetName: string): MindmapNode {
  const classified = classifyRows(sheet);

  const root: MindmapNode = {
    id: 'root',
    title: sheetName,
    children: [],
    depth: 0,
  };

  // Find header row for column labels
  const headerRow = classified.find(r => r.type === RowType.HEADER) ?? null;

  let currentCategory: MindmapNode | null = null;
  let currentStep: MindmapNode | null = null;
  let currentSubsection: MindmapNode | null = null;
  let idCounter = 0;

  const makeId = () => `n${++idCounter}`;

  for (const row of classified) {
    if (row.type === RowType.HEADER || row.type === RowType.EMPTY) continue;

    const cancelledPrefix = row.isCancelled ? '~~' : '';
    const cancelledSuffix = row.isCancelled ? '~~ *(cancelled)*' : '';

    switch (row.type) {
      case RowType.CATEGORY: {
        currentCategory = {
          id: makeId(),
          title: `${cancelledPrefix}${row.label}${cancelledSuffix}`,
          children: [],
          depth: 1,
          sourceRange: `${sheetName}!A${row.rowNum}`,
          sourceData: row.cells,
        };
        root.children.push(currentCategory);
        currentStep = null;
        currentSubsection = null;
        break;
      }
      case RowType.STEP: {
        currentStep = {
          id: makeId(),
          title: `${cancelledPrefix}${row.label}${cancelledSuffix}`,
          children: [],
          depth: 2,
          sourceRange: `${sheetName}!C${row.rowNum}`,
          sourceData: row.cells,
        };
        (currentCategory ?? root).children.push(currentStep);
        currentSubsection = null;
        break;
      }
      case RowType.SUBSECTION: {
        currentSubsection = {
          id: makeId(),
          title: `${cancelledPrefix}${row.label}${cancelledSuffix}`,
          children: [],
          depth: 3,
          sourceRange: `${sheetName}!C${row.rowNum}`,
          sourceData: row.cells,
        };
        (currentStep ?? currentCategory ?? root).children.push(currentSubsection);
        break;
      }
      case RowType.TASK: {
        const data = extractRowData(row, headerRow);
        const parent = currentSubsection ?? currentStep ?? currentCategory ?? root;
        const taskNode: MindmapNode = {
          id: makeId(),
          title: `${cancelledPrefix}${row.label}${cancelledSuffix}`,
          summary: Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', '),
          children: [],
          depth: parent.depth + 1,
          sourceRange: `${sheetName}!C${row.rowNum}`,
          sourceData: row.cells,
        };
        parent.children.push(taskNode);
        break;
      }
      case RowType.SUBTOTAL: {
        const data = extractRowData(row, headerRow);
        const parent = currentSubsection ?? currentStep ?? currentCategory ?? root;
        const subtotalNode: MindmapNode = {
          id: makeId(),
          title: `📊 ${row.label}`,
          summary: Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(', '),
          children: [],
          depth: parent.depth + 1,
          sourceRange: `${sheetName}!C${row.rowNum}`,
          sourceData: row.cells,
        };
        parent.children.push(subtotalNode);
        break;
      }
    }
  }

  return root;
}
