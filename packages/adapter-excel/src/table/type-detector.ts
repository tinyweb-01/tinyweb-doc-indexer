// Table type detector — determines if a sheet is SQL-indexable (flat) vs hierarchical
// SQL-indexable: no merged cells, no subtotal/group rows, consistent column structure
import type { ParsedSheet, ParsedCell } from '../types';
import { classifyRows, RowType } from './row-classifier';

export interface SqlIndexableResult {
  sql_indexable: boolean;
  reason: string;
  signals: {
    hasMergedCells: boolean;
    hasSubtotalRows: boolean;
    hasCategoryRows: boolean;
    hasStepOrSubsectionRows: boolean;
    columnStructureConsistent: boolean;
    dataRowCount: number;
    nonDataRowCount: number;
  };
}

/**
 * Decide whether a sheet can be flattened into rows × columns for SQL-style indexing.
 *
 * A sheet is SQL-indexable when ALL of:
 *  - No merged cells (besides possibly the header row)
 *  - No subtotal / category / step / subsection rows
 *  - Header row identifiable
 *  - Most data rows have a consistent number of filled columns
 */
export function detectSqlIndexable(sheet: ParsedSheet): SqlIndexableResult {
  const classified = classifyRows(sheet);

  // Group cells by row for filled-column-count analysis
  const rowMap = new Map<number, ParsedCell[]>();
  for (const cell of sheet.cells) {
    if (!rowMap.has(cell.row)) rowMap.set(cell.row, []);
    rowMap.get(cell.row)!.push(cell);
  }

  // Count non-header merged ranges
  // Allowed: merges entirely within row 1-2 (header)
  let nonHeaderMergeCount = 0;
  for (const range of sheet.mergedCells || []) {
    const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const startRow = parseInt(m[2], 10);
    const endRow = parseInt(m[4], 10);
    if (startRow > 2 || endRow > 2) {
      nonHeaderMergeCount++;
    }
  }
  const hasMergedCells = nonHeaderMergeCount > 0;

  let subtotalCount = 0;
  let categoryCount = 0;
  let stepOrSubsectionCount = 0;
  let taskCount = 0;

  for (const r of classified) {
    switch (r.type) {
      case RowType.SUBTOTAL: subtotalCount++; break;
      case RowType.CATEGORY: categoryCount++; break;
      case RowType.STEP:
      case RowType.SUBSECTION: stepOrSubsectionCount++; break;
      case RowType.TASK: taskCount++; break;
    }
  }

  const hasSubtotalRows = subtotalCount > 0;
  const hasCategoryRows = categoryCount > 0;
  const hasStepOrSubsectionRows = stepOrSubsectionCount > 0;

  // Column-structure consistency: among TASK rows, fraction sharing modal filled-col-count
  const taskRows = classified.filter(r => r.type === RowType.TASK);
  let columnStructureConsistent = true;
  if (taskRows.length >= 3) {
    const counts = new Map<number, number>();
    for (const r of taskRows) {
      const filled = r.cells.filter(c => c.value != null && String(c.value).trim() !== '').length;
      counts.set(filled, (counts.get(filled) ?? 0) + 1);
    }
    const modal = Math.max(...counts.values());
    columnStructureConsistent = modal / taskRows.length >= 0.6;
  }

  const signals = {
    hasMergedCells,
    hasSubtotalRows,
    hasCategoryRows,
    hasStepOrSubsectionRows,
    columnStructureConsistent,
    dataRowCount: taskCount,
    nonDataRowCount: subtotalCount + categoryCount + stepOrSubsectionCount,
  };

  // Decision
  const blockers: string[] = [];
  if (hasMergedCells) blockers.push(`${nonHeaderMergeCount} merged cells outside header`);
  if (hasSubtotalRows) blockers.push(`${subtotalCount} subtotal rows`);
  if (hasCategoryRows) blockers.push(`${categoryCount} category rows`);
  if (hasStepOrSubsectionRows) blockers.push(`${stepOrSubsectionCount} step/subsection rows`);
  if (!columnStructureConsistent) blockers.push('inconsistent column structure across data rows');

  const sql_indexable = blockers.length === 0 && taskCount >= 1;

  const reason = sql_indexable
    ? `flat structure with ${taskCount} data rows`
    : `hierarchical structure: ${blockers.join(', ')}`;

  return { sql_indexable, reason, signals };
}
