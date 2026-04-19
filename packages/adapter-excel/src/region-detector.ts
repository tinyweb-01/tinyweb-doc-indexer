// Region Detector — finds distinct regions (tables, headers, free text areas)
// Uses gap detection, fill rate changes, and formatting transitions
import type { ParsedSheet, ParsedCell } from './types';
import type { SheetProfile, RowProfile } from './sheet-profiler';

// ── Types ──────────────────────────────────────────────────────

export type RegionType = 'table' | 'header' | 'section-header' | 'free-text' | 'empty-gap' | 'subtotal';

export interface Region {
  type: RegionType;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  rowCount: number;
  characteristics: RegionCharacteristics;
}

export interface RegionCharacteristics {
  dominantFillColor: string | null;
  boldRate: number;           // 0–1
  numericRate: number;        // 0–1, rows with numeric data
  avgFilledCols: number;
  hasMergedCells: boolean;
  isUniform: boolean;         // rows have similar structure
}

// ── Main Detector ──────────────────────────────────────────────

export function detectRegions(sheet: ParsedSheet, profile: SheetProfile): Region[] {
  const { rows } = profile;
  if (rows.length === 0) return [];

  // Step 1: Find empty-row gaps (rows with 0 filled cols or missing from data)
  const allRowNums = new Set(rows.map(r => r.row));
  const minRow = Math.min(...rows.map(r => r.row));
  const maxRow = Math.max(...rows.map(r => r.row));

  // Build a contiguous row array with gap markers
  const rowSequence: (RowProfile | null)[] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const rp = rows.find(rp => rp.row === r);
    rowSequence.push(rp && rp.filledCols > 0 ? rp : null);
  }

  // Step 2: Segment by empty gaps (consecutive null rows)
  const segments: { startRow: number; endRow: number; rows: RowProfile[] }[] = [];
  let currentSegment: RowProfile[] = [];
  let segStart = minRow;

  for (let i = 0; i < rowSequence.length; i++) {
    const rp = rowSequence[i];
    if (rp) {
      if (currentSegment.length === 0) segStart = minRow + i;
      currentSegment.push(rp);
    } else {
      if (currentSegment.length > 0) {
        segments.push({
          startRow: segStart,
          endRow: minRow + i - 1,
          rows: [...currentSegment],
        });
        currentSegment = [];
      }
    }
  }
  if (currentSegment.length > 0) {
    segments.push({
      startRow: segStart,
      endRow: maxRow,
      rows: [...currentSegment],
    });
  }

  // Step 3: Classify each segment into regions
  const regions: Region[] = [];

  for (const seg of segments) {
    const subRegions = classifySegment(seg.rows, seg.startRow, seg.endRow, profile);
    regions.push(...subRegions);
  }

  // Add empty gaps between segments
  for (let i = 0; i < segments.length - 1; i++) {
    const gapStart = segments[i].endRow + 1;
    const gapEnd = segments[i + 1].startRow - 1;
    if (gapEnd >= gapStart) {
      regions.push({
        type: 'empty-gap',
        startRow: gapStart,
        endRow: gapEnd,
        startCol: 1,
        endCol: profile.totalCols,
        rowCount: gapEnd - gapStart + 1,
        characteristics: {
          dominantFillColor: null,
          boldRate: 0,
          numericRate: 0,
          avgFilledCols: 0,
          hasMergedCells: false,
          isUniform: true,
        },
      });
    }
  }

  return regions.sort((a, b) => a.startRow - b.startRow);
}

// ── Segment Classification ─────────────────────────────────────

function classifySegment(
  rows: RowProfile[],
  startRow: number,
  endRow: number,
  profile: SheetProfile,
): Region[] {
  const regions: Region[] = [];

  // Sub-segment by formatting transitions
  const groups = groupByFormattingTransition(rows);

  for (const group of groups) {
    const region = classifyGroup(group, profile);
    regions.push(region);
  }

  return regions;
}

interface RowGroup {
  rows: RowProfile[];
  startRow: number;
  endRow: number;
}

/**
 * Group consecutive rows that share similar formatting characteristics.
 * A transition occurs when:
 * - Fill color changes
 * - Bold rate changes significantly  
 * - Column count changes dramatically
 * - A row is merged across (section header)
 */
function groupByFormattingTransition(rows: RowProfile[]): RowGroup[] {
  if (rows.length === 0) return [];

  const groups: RowGroup[] = [];
  let current: RowProfile[] = [rows[0]];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];

    const isTransition =
      // Merged-across rows are always their own group
      curr.isMergedAcross !== prev.isMergedAcross ||
      // Fill color change (both non-null and different)
      (curr.fillColor !== prev.fillColor && (curr.fillColor != null || prev.fillColor != null)) ||
      // Dramatic column count change (>50% difference)
      (prev.filledCols > 0 && Math.abs(curr.filledCols - prev.filledCols) / prev.filledCols > 0.5) ||
      // Bold vs non-bold transition (single-row bold = likely header/subtotal)
      (curr.boldCols > 0 && curr.boldCols === curr.filledCols && prev.boldCols < prev.filledCols);

    // Single-row transitions: check if current group is a single special row
    if (isTransition && current.length > 0) {
      groups.push({
        rows: [...current],
        startRow: current[0].row,
        endRow: current[current.length - 1].row,
      });
      current = [curr];
    } else {
      current.push(curr);
    }
  }

  if (current.length > 0) {
    groups.push({
      rows: current,
      startRow: current[0].row,
      endRow: current[current.length - 1].row,
    });
  }

  return groups;
}

function classifyGroup(group: RowGroup, profile: SheetProfile): Region {
  const { rows } = group;
  const totalBold = rows.reduce((s, r) => s + r.boldCols, 0);
  const totalFilled = rows.reduce((s, r) => s + r.filledCols, 0);
  const boldRate = totalFilled > 0 ? totalBold / totalFilled : 0;
  const numericRows = rows.filter(r => r.hasNumericData).length;
  const numericRate = rows.length > 0 ? numericRows / rows.length : 0;
  const avgFilled = totalFilled / (rows.length || 1);

  const fillColors = rows.map(r => r.fillColor).filter(Boolean) as string[];
  const dominantFill = fillColors.length > 0 ? mostFreq(fillColors) : null;

  const hasMerged = rows.some(r => r.isMergedAcross) ||
    profile.mergeGroups.some(mg =>
      mg.startRow >= group.startRow && mg.endRow <= group.endRow
    );

  const colCounts = rows.map(r => r.filledCols);
  const mean = colCounts.reduce((a, b) => a + b, 0) / (colCounts.length || 1);
  const variance = colCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (colCounts.length || 1);
  const isUniform = Math.sqrt(variance) / (mean || 1) < 0.3;

  const chars: RegionCharacteristics = {
    dominantFillColor: dominantFill,
    boldRate,
    numericRate,
    avgFilledCols: avgFilled,
    hasMergedCells: hasMerged,
    isUniform,
  };

  // Determine column bounds
  const minCol = Math.min(...rows.map(r => {
    // Find min col from profile rows' cells - approximate from filled count
    return 1; // default to 1; precise detection would need cell data
  }));
  const maxCol = profile.totalCols;

  // Classification logic.
  // IMPORTANT: default is 'free-text' — we only promote a block to 'table'
  // when there is positive structural evidence. Otherwise text-heavy
  // numbered/paragraph blocks get wrongly captured as table images.
  let type: RegionType = 'free-text';

  if (rows.length === 1) {
    const r = rows[0];
    // Header row: bold, distinctive fill, in first few rows
    if (profile.headerRowCandidates.includes(r.row)) {
      type = 'header';
    }
    // Subtotal row
    else if (profile.subtotalRowCandidates.includes(r.row)) {
      type = 'subtotal';
    }
    // Section header: merged across, bold, distinctive fill
    else if (r.isMergedAcross && r.boldCols > 0) {
      type = 'section-header';
    }
    // Single bold row with few cols = section header
    else if (boldRate >= 0.8 && avgFilled <= 3 && !r.hasNumericData) {
      type = 'section-header';
    }
    // else: free-text (default)
  } else if (rows.length <= 2 && boldRate >= 0.8 && numericRate === 0) {
    type = 'header';
  } else if (boldRate >= 0.7 && numericRate < 0.2 && avgFilled <= 3) {
    type = 'section-header';
  } else {
    // Multi-row block — decide table vs free-text based on positive evidence.
    // A real table needs: enough columns, uniform structure, AND at least
    // one of {numeric data, bold-header signal, merged header cells}.
    const hasNumericSignal = numericRate >= 0.25;
    const hasStructuredHeader =
      avgFilled >= 3 &&
      isUniform &&
      rows.length >= 2 &&
      (numericRate >= 0.1 || boldRate >= 0.08 || hasMerged || dominantFill !== null);
    const isDenseTable =
      avgFilled >= 4 && rows.length >= 3 && isUniform;

    if (hasNumericSignal && avgFilled >= 3) {
      type = 'table';
    } else if (hasStructuredHeader) {
      type = 'table';
    } else if (isDenseTable) {
      type = 'table';
    } else {
      // Single-column prose, numbered lists, short multi-row notes, etc.
      type = 'free-text';
    }
  }

  return {
    type,
    startRow: group.startRow,
    endRow: group.endRow,
    startCol: minCol,
    endCol: maxCol,
    rowCount: rows.length,
    characteristics: chars,
  };
}

function mostFreq(arr: string[]): string {
  const freq = new Map<string, number>();
  for (const v of arr) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best = arr[0], bestC = 0;
  for (const [v, c] of freq) if (c > bestC) { best = v; bestC = c; }
  return best;
}
