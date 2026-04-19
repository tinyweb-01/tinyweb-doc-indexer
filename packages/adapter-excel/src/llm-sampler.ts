// LLM Sampler — produces minimal cell samples for LLM fallback classification
// Enforces token budget and compresses cell format
import type { ParsedSheet, ParsedCell } from './types';
import type { SheetProfile } from './sheet-profiler';

// ── Types ──────────────────────────────────────────────────────

export interface LLMSample {
  sheetName: string;
  totalRows: number;
  totalCols: number;
  sampledRows: CompressedRow[];
  estimatedTokens: number;
  prompt: string;
}

export interface CompressedRow {
  row: number;
  cells: string; // pipe-separated: "col:value:B:fill" (B=bold, fill=color)
  tag?: string;  // why this row was sampled
}

export interface SamplerOptions {
  maxRows?: number;       // default 30
  maxTokens?: number;     // default 2000
  includeHeader?: boolean; // default true
  includeSubtotals?: boolean; // default true
  randomDataRows?: number; // default 3 per region
}

const DEFAULT_OPTIONS: Required<SamplerOptions> = {
  maxRows: 30,
  maxTokens: 2000,
  includeHeader: true,
  includeSubtotals: true,
  randomDataRows: 3,
};

// ── Main Sampler ───────────────────────────────────────────────

export function sampleForLLM(
  sheet: ParsedSheet,
  profile: SheetProfile,
  options?: SamplerOptions,
): LLMSample {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const byRow = new Map<number, ParsedCell[]>();
  for (const cell of sheet.cells) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row)!.push(cell);
  }

  const sampled: CompressedRow[] = [];
  const usedRows = new Set<number>();

  // 1. Header rows (first 3-5 rows)
  if (opts.includeHeader) {
    const headerRows = profile.headerRowCandidates.length > 0
      ? profile.headerRowCandidates
      : profile.rows.filter(r => r.row <= 5).map(r => r.row);

    for (const row of headerRows.slice(0, 3)) {
      if (byRow.has(row)) {
        sampled.push(compressRow(row, byRow.get(row)!, 'header'));
        usedRows.add(row);
      }
    }
  }

  // 2. Subtotal rows
  if (opts.includeSubtotals) {
    for (const row of profile.subtotalRowCandidates.slice(0, 5)) {
      if (!usedRows.has(row) && byRow.has(row)) {
        sampled.push(compressRow(row, byRow.get(row)!, 'subtotal'));
        usedRows.add(row);
      }
    }
  }

  // 3. Rows with unique formatting patterns (deduplicated by fill color + bold pattern)
  const seenPatterns = new Set<string>();
  for (const rp of profile.rows) {
    const pattern = `${rp.fillColor ?? 'none'}|${rp.boldCols > 0 ? 'B' : '-'}|${rp.filledCols}|${rp.isStrikethrough ? 'S' : '-'}`;
    if (!seenPatterns.has(pattern) && !usedRows.has(rp.row) && byRow.has(rp.row)) {
      seenPatterns.add(pattern);
      sampled.push(compressRow(rp.row, byRow.get(rp.row)!, `pattern:${pattern}`));
      usedRows.add(rp.row);
    }
  }

  // 4. Random data rows to fill remaining budget
  const remaining = opts.maxRows - sampled.length;
  if (remaining > 0) {
    const dataRows = profile.rows
      .filter(r => !usedRows.has(r.row) && r.hasNumericData && byRow.has(r.row))
      .map(r => r.row);
    
    // Evenly sample across the sheet
    const step = Math.max(1, Math.floor(dataRows.length / remaining));
    for (let i = 0; i < dataRows.length && sampled.length < opts.maxRows; i += step) {
      sampled.push(compressRow(dataRows[i], byRow.get(dataRows[i])!, 'data-sample'));
      usedRows.add(dataRows[i]);
    }
  }

  // Sort by row number
  sampled.sort((a, b) => a.row - b.row);

  // Estimate tokens (~4 chars per token)
  const rawText = sampled.map(r => r.cells).join('\n');
  const estimatedTokens = Math.ceil(rawText.length / 4);

  // If over budget, trim from the end (keep headers and unique patterns)
  while (sampled.length > 1 && Math.ceil(sampled.map(r => r.cells).join('\n').length / 4) > opts.maxTokens) {
    // Remove last data-sample row
    let idx = -1;
    for (let i = sampled.length - 1; i >= 0; i--) {
      if (sampled[i].tag === 'data-sample') { idx = i; break; }
    }
    if (idx >= 0) sampled.splice(idx, 1);
    else break;
  }

  const finalTokens = Math.ceil(sampled.map(r => r.cells).join('\n').length / 4);

  const prompt = buildPrompt(sheet.name, profile, sampled);

  return {
    sheetName: sheet.name,
    totalRows: profile.totalRows,
    totalCols: profile.totalCols,
    sampledRows: sampled,
    estimatedTokens: finalTokens,
    prompt,
  };
}

// ── Compression ────────────────────────────────────────────────

function compressRow(row: number, cells: ParsedCell[], tag: string): CompressedRow {
  const parts = cells
    .filter(c => c.value != null && c.value !== '')
    .sort((a, b) => a.col - b.col)
    .map(c => {
      const flags: string[] = [];
      if (c.isBold) flags.push('B');
      if (c.isStrikethrough) flags.push('S');
      if (c.fillColor) flags.push(`f:${c.fillColor}`);
      if (c.fontColor) flags.push(`c:${c.fontColor}`);
      const val = typeof c.value === 'string' ? c.value.slice(0, 50) : String(c.value);
      return `${colLetter(c.col)}:${val}${flags.length ? ':' + flags.join(',') : ''}`;
    });

  return { row, cells: `R${row}|${parts.join('|')}`, tag };
}

function colLetter(col: number): string {
  let s = '';
  let c = col;
  while (c > 0) {
    const r = (c - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

// ── Prompt Builder ─────────────────────────────────────────────

function buildPrompt(sheetName: string, profile: SheetProfile, rows: CompressedRow[]): string {
  const lines: string[] = [];
  lines.push(`Analyze this Excel sheet "${sheetName}" (${profile.totalRows} rows × ${profile.totalCols} cols).`);
  lines.push(`Sheet type guess: ${profile.sheetType} (confidence: ${(profile.tableConfidence * 100).toFixed(0)}%)`);
  lines.push(`Detected colors: ${profile.fillColors.slice(0, 5).map(c => `${c.color}(${c.count})`).join(', ')}`);
  lines.push('');
  lines.push('Sampled rows (format: R<row>|<col>:<value>:<flags>):');
  for (const r of rows) {
    lines.push(`  [${r.tag}] ${r.cells}`);
  }
  lines.push('');
  lines.push('Classify each sampled row as one of: HEADER, CATEGORY, STEP, SUBSECTION, TASK, SUBTOTAL, SECTION_HEADER, FREE_TEXT, EMPTY');
  lines.push('Also identify: (1) What is this sheet about? (2) What hierarchy levels exist? (3) What do the colors mean?');
  lines.push('Return JSON: { "description": "...", "rowClassifications": { "<rowNum>": "<type>" }, "colorMeaning": { "<color>": "<meaning>" } }');
  return lines.join('\n');
}
