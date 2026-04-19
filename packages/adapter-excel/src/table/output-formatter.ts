// Table output formatter — produces AI-friendly chunked JSON
// - Index file (table_meta + summary_index) ≤ MAX_LINES_PER_FILE
// - Detail chunk files (one per group / sub-step) ≤ MAX_LINES_PER_FILE
// - Auto-splits oversized groups into sub-chunks
//
// See: experiences/table-indexing/complex-table-representation-for-ai.md
import type {
  ParsedSheet, ParsedCell,
  TableIndex, TableMeta, SummaryChunk, DetailChunk, TaskRecord,
  FlatColumnDef, TableOutputArtifact, SummaryPageFile,
} from '../types';
import { classifyRows, RowType, type ClassifiedRow } from './row-classifier';
import { detectSqlIndexable } from './type-detector';

// ── Configuration ──────────────────────────────────────────────

export interface FormatterOptions {
  maxLinesPerFile?: number;        // default 500
  inlineThreshold?: number;        // default 500 — if total ≤ this, inline chunks into index
  sheetName?: string;              // override sheet display name
  fileNamePrefix?: string;         // file name prefix, default = sheet name
  /** Business-level description (what the table represents). If omitted, a placeholder is used. */
  description?: string;
  /** Path / URL to rendered image of the table (for AI visual reference). */
  image?: string;
  /** Override auto-detected data range (1-based, inclusive). */
  dataBounds?: { startRow: number; endRow: number; startCol: number; endCol: number };
}

const DEFAULT_OPTIONS: Required<Omit<FormatterOptions, 'sheetName' | 'fileNamePrefix' | 'description' | 'image' | 'dataBounds'>> = {
  maxLinesPerFile: 500,
  inlineThreshold: 500,
};

/** Compute the actual data range of a sheet (1-based, inclusive). Returns null if sheet is empty. */
function computeDataBounds(sheet: ParsedSheet): { startRow: number; endRow: number; startCol: number; endCol: number } | undefined {
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const cell of sheet.cells) {
    const v = cell.value;
    if (v === null || v === undefined || v === '') continue;
    if (cell.row < minR) minR = cell.row;
    if (cell.row > maxR) maxR = cell.row;
    if (cell.col < minC) minC = cell.col;
    if (cell.col > maxC) maxC = cell.col;
  }
  if (!isFinite(minR)) return undefined;
  return { startRow: minR, endRow: maxR, startCol: minC, endCol: maxC };
}

// Stop-words / generic terms filtered out of keywords
const STOPWORDS = new Set([
  'và', 'của', 'cho', 'các', 'là', 'với', 'theo', 'từ', 'trên', 'tại',
  'một', 'những', 'này', 'đó', 'đã', 'sẽ', 'có', 'không', 'để', 'bằng',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with',
  'tổng', 'cộng', 'small', 'sub', 'subtotal', 'total',
]);

// ── Helpers ────────────────────────────────────────────────────

function colLetter(col: number): string {
  let s = '';
  let c = col;
  while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); }
  return s;
}

function jsonLineCount(obj: any): number {
  return JSON.stringify(obj, null, 2).split('\n').length;
}

/** Collapse multi-line strings (from merged cells) into single readable line. */
function cleanPath(s: string): string {
  if (!s) return '';
  return s
    .replace(/\r/g, '')
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
    .join(' / ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 160);
}

/** Join parent path with child label using ' › ' separator. */
function joinPath(parent: string | undefined, child: string): string {
  const p = cleanPath(parent ?? '');
  const c = cleanPath(child);
  if (!p) return c;
  if (!c) return p;
  return `${p} › ${c}`;
}

function safeId(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'item';
}

function truncate(s: string, n = 80): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Build a numeric key from header column for subtotal/total payloads. */
function pickNumericValues(row: ClassifiedRow, headerLabels: Map<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of row.cells) {
    if (typeof c.value === 'number' && c.col >= 4) {
      const key = headerLabels.get(c.col) ?? `col_${colLetter(c.col)}`;
      out[normalizeKey(key)] = c.value;
    }
  }
  return out;
}

// Vietnamese-aware key normalizer: transliterates diacritics to readable ASCII
const VN_MAP: Record<string, string> = {
  'à':'a','á':'a','ả':'a','ã':'a','ạ':'a',
  'ă':'a','ằ':'a','ắ':'a','ẳ':'a','ẵ':'a','ặ':'a',
  'â':'a','ầ':'a','ấ':'a','ẩ':'a','ẫ':'a','ậ':'a',
  'è':'e','é':'e','ẻ':'e','ẽ':'e','ẹ':'e',
  'ê':'e','ề':'e','ế':'e','ể':'e','ễ':'e','ệ':'e',
  'ì':'i','í':'i','ỉ':'i','ĩ':'i','ị':'i',
  'ò':'o','ó':'o','ỏ':'o','õ':'o','ọ':'o',
  'ô':'o','ồ':'o','ố':'o','ổ':'o','ỗ':'o','ộ':'o',
  'ơ':'o','ờ':'o','ớ':'o','ở':'o','ỡ':'o','ợ':'o',
  'ù':'u','ú':'u','ủ':'u','ũ':'u','ụ':'u',
  'ư':'u','ừ':'u','ứ':'u','ử':'u','ữ':'u','ự':'u',
  'ỳ':'y','ý':'y','ỷ':'y','ỹ':'y','ỵ':'y',
  'đ':'d',
};

function transliterate(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    out += VN_MAP[ch] ?? ch;
  }
  return out;
}

function normalizeKey(s: string): string {
  return transliterate(s)
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'value';
}

function extractKeywords(rows: ClassifiedRow[], maxKeywords = 12): string[] {
  const freq = new Map<string, number>();
  for (const r of rows) {
    const text = r.cells
      .filter(c => c.col >= 1 && c.col <= 6 && typeof c.value === 'string')
      .map(c => String(c.value))
      .join(' ');
    // Tokenize: words ≥3 chars, also keep alnum codes like "598PGM", "NetCOBOL"
    const tokens = text.match(/[A-Za-z0-9_\u00C0-\u024F\u1E00-\u1EFF\u3040-\u30FF\u4E00-\u9FFF]+/g) || [];
    for (const tok of tokens) {
      const lo = tok.toLowerCase();
      if (lo.length < 3) continue;
      if (STOPWORDS.has(lo)) continue;
      // Keep mixed-case original (preserves NetCOBOL, AS400, etc.)
      const key = /^[a-z]+$/.test(tok) ? tok : tok;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([k]) => k);
}

// ── Header label map ───────────────────────────────────────────

function buildHeaderLabels(classified: ClassifiedRow[]): Map<number, string> {
  const header = classified.find(r => r.type === RowType.HEADER);
  const map = new Map<number, string>();
  if (!header) return map;
  for (const c of header.cells) {
    if (c.value != null) {
      const txt = String(c.value).trim().split('\n')[0];
      if (txt) map.set(c.col, txt);
    }
  }
  return map;
}

// ── Build TaskRecord from a TASK row ───────────────────────────

function rowToTask(row: ClassifiedRow, headers: Map<number, string>): TaskRecord {
  const rec: TaskRecord = {
    task: truncate(row.label, 200),
    cancelled: row.isCancelled,
  };
  for (const c of row.cells) {
    if (c.col < 4) continue; // skip A,B,C — A/B used for category, C is task label
    if (c.value == null || String(c.value).trim() === '') continue;
    const key = normalizeKey(headers.get(c.col) ?? `col_${colLetter(c.col)}`);
    if (key === 'task') continue;
    let v: any = c.value;
    if (typeof v === 'string') v = truncate(v, 300);
    rec[key] = v;
  }
  return rec;
}

// ── Hierarchical group building ────────────────────────────────

interface RawGroup {
  chunk_id: string;
  path: string;
  parent_chunk_id: string | null;
  start_row: number;
  end_row: number;
  rows: ClassifiedRow[];
  subtotal?: Record<string, number>;
  children: RawGroup[];
  // Tasks are direct children of this group (excluding nested step/subsection groups)
  tasks: ClassifiedRow[];
}

function buildRawGroups(classified: ClassifiedRow[]): RawGroup[] {
  const root: RawGroup[] = [];
  const stack: RawGroup[] = []; // current path of nested groups
  let categoryIdx = 0;
  let stepIdx = 0;
  let subsectionIdx = 0;

  for (const row of classified) {
    if (row.type === RowType.HEADER || row.type === RowType.EMPTY) continue;

    const top = () => stack[stack.length - 1];

    const makeGroup = (kind: string, depth: number, idx: number): RawGroup => {
      // ancestor for chunk_id naming
      const parent = stack.find(g => g.chunk_id) ?? null;
      const id = parent
        ? `${parent.chunk_id}_${kind}${idx}`
        : `${kind}_${idx}`;
      return {
        chunk_id: id,
        path: cleanPath(row.label),
        parent_chunk_id: parent?.chunk_id ?? null,
        start_row: row.rowNum,
        end_row: row.rowNum,
        rows: [row],
        children: [],
        tasks: [],
      };
    };

    const popUntil = (depthAllowed: number) => {
      while (stack.length > depthAllowed) stack.pop();
    };

    switch (row.type) {
      case RowType.CATEGORY: {
        categoryIdx++;
        stepIdx = 0;
        subsectionIdx = 0;
        popUntil(0);
        const g = makeGroup('group', 1, categoryIdx);
        // Build path with prefix from row.label (often already "1 名称")
        root.push(g);
        stack.push(g);
        break;
      }
      case RowType.STEP: {
        stepIdx++;
        subsectionIdx = 0;
        popUntil(1);
        const g = makeGroup('step', 2, stepIdx);
        const parent = top();
        g.path = joinPath(parent?.path, row.label);
        if (parent) parent.children.push(g); else root.push(g);
        stack.push(g);
        break;
      }
      case RowType.SUBSECTION: {
        subsectionIdx++;
        popUntil(2);
        const g = makeGroup('sub', 3, subsectionIdx);
        const parent = top();
        g.path = joinPath(parent?.path, row.label);
        if (parent) parent.children.push(g); else root.push(g);
        stack.push(g);
        break;
      }
      case RowType.TASK: {
        const parent = top();
        if (parent) {
          parent.tasks.push(row);
          parent.end_row = row.rowNum;
          parent.rows.push(row);
        } else {
          // Orphan task with no category — bucket under a synthetic group
          let bucket = root.find(g => g.chunk_id === 'group_misc');
          if (!bucket) {
            bucket = {
              chunk_id: 'group_misc',
              path: 'Miscellaneous',
              parent_chunk_id: null,
              start_row: row.rowNum,
              end_row: row.rowNum,
              rows: [row],
              children: [],
              tasks: [row],
            };
            root.push(bucket);
          } else {
            bucket.tasks.push(row);
            bucket.end_row = row.rowNum;
            bucket.rows.push(row);
          }
        }
        break;
      }
      case RowType.SUBTOTAL: {
        const parent = top();
        if (parent) {
          parent.rows.push(row);
          parent.end_row = row.rowNum;
          // Subtotal will be filled-in later when we have header labels
          (parent as any)._subtotalRow = row;
        }
        break;
      }
    }
  }

  // Recursively bubble end_row from children
  const fixRange = (g: RawGroup) => {
    for (const c of g.children) {
      fixRange(c);
      if (c.end_row > g.end_row) g.end_row = c.end_row;
    }
  };
  root.forEach(fixRange);

  return root;
}

// ── Convert RawGroup tree → SummaryChunk[] + DetailChunk[] ─────

interface BuildContext {
  headers: Map<number, string>;
  detailChunks: DetailChunk[];
  maxLinesPerFile: number;
  filePrefix: string;
  // Track which chunk_ids will be written as separate files
  chunkFileNames: Map<string, string>; // chunk_id → file name
}

function buildSummaryAndDetails(group: RawGroup, ctx: BuildContext): SummaryChunk {
  // Resolve subtotal
  const subtotalRow: ClassifiedRow | undefined = (group as any)._subtotalRow;
  const subtotal = subtotalRow ? pickNumericValues(subtotalRow, ctx.headers) : undefined;
  group.subtotal = subtotal;

  // Decide: leaf group (has tasks, no children) vs branch (has children)
  const hasChildren = group.children.length > 0;
  const taskCount = group.tasks.length;

  // For a leaf or mixed group, build a DetailChunk for its own tasks if any
  let myDetailChunkId: string | undefined;
  if (taskCount > 0) {
    const tasks: TaskRecord[] = group.tasks.map(r => rowToTask(r, ctx.headers));
    const chunk: DetailChunk = {
      chunk_id: group.chunk_id,
      path: group.path,
      parent_chunk: group.parent_chunk_id,
      subtotal,
      tasks,
    };

    // Auto-split if oversized
    const split = autoSplit(chunk, ctx.maxLinesPerFile);
    for (const c of split) {
      ctx.detailChunks.push(c);
      ctx.chunkFileNames.set(c.chunk_id, `tables/${ctx.filePrefix}_chunk_${c.chunk_id}.json`);
    }
    myDetailChunkId = group.chunk_id;
  }

  // Build summary entry
  const childSummaries: SummaryChunk[] = group.children.map(c => buildSummaryAndDetails(c, ctx));

  const allRowsForKeywords = [
    ...group.rows,
    ...group.children.flatMap(c => c.rows),
  ];

  const summary: SummaryChunk = {
    chunk_id: group.chunk_id,
    path: cleanPath(group.path),
    subtotal,
    row_range: `${group.start_row}-${group.end_row}`,
    children_count: taskCount + group.children.length,
    keywords: extractKeywords(allRowsForKeywords).slice(0, 6),
  };

  if (childSummaries.length > 0) {
    summary.sub_chunks = childSummaries.map(c => c.chunk_id);
  }
  if (myDetailChunkId) {
    summary.chunk_file = ctx.chunkFileNames.get(myDetailChunkId);
  }

  // Append child summaries to flat list at the end (handled by caller)
  (summary as any)._childSummaries = childSummaries;

  return summary;
}

/** Flatten nested summary tree into single list (depth-first). */
function flattenSummaries(summaries: SummaryChunk[]): SummaryChunk[] {
  const out: SummaryChunk[] = [];
  const walk = (s: SummaryChunk) => {
    const children: SummaryChunk[] = (s as any)._childSummaries || [];
    delete (s as any)._childSummaries;
    out.push(s);
    children.forEach(walk);
  };
  summaries.forEach(walk);
  return out;
}

// ── Auto-split oversized chunks ────────────────────────────────

function autoSplit(chunk: DetailChunk, maxLines: number): DetailChunk[] {
  if (jsonLineCount(chunk) <= maxLines) return [chunk];

  // Estimate tasks-per-piece by binary-shrinking until each piece fits
  const total = chunk.tasks.length;
  if (total <= 1) return [chunk]; // can't split further

  let perPiece = total;
  while (perPiece > 1) {
    const sample: DetailChunk = { ...chunk, tasks: chunk.tasks.slice(0, perPiece) };
    if (jsonLineCount(sample) <= maxLines) break;
    perPiece = Math.floor(perPiece / 2);
  }
  perPiece = Math.max(perPiece, 1);

  const pieces: DetailChunk[] = [];
  for (let i = 0, idx = 1; i < total; i += perPiece, idx++) {
    const slice = chunk.tasks.slice(i, i + perPiece);
    pieces.push({
      ...chunk,
      chunk_id: `${chunk.chunk_id}_part${idx}`,
      path: `${chunk.path} (part ${idx}/${Math.ceil(total / perPiece)})`,
      tasks: slice,
      // Only first piece carries the subtotal
      subtotal: idx === 1 ? chunk.subtotal : undefined,
    });
  }
  return pieces;
}

// ── Flat (SQL-indexable) output ────────────────────────────────

function buildFlatData(
  classified: ClassifiedRow[],
  headers: Map<number, string>,
): { columns: FlatColumnDef[]; records: Record<string, any>[] } {
  // Determine column set from header (or fallback to encountered cols)
  const colSet = new Set<number>(headers.keys());
  for (const r of classified) {
    for (const c of r.cells) if (c.value != null) colSet.add(c.col);
  }
  const cols = [...colSet].sort((a, b) => a - b);

  // Infer data types from TASK rows
  const colTypes = new Map<number, FlatColumnDef['dataType']>();
  for (const col of cols) {
    const seen = new Set<string>();
    for (const r of classified) {
      if (r.type !== RowType.TASK) continue;
      const c = r.cells.find(x => x.col === col);
      if (!c || c.value == null) continue;
      seen.add(typeof c.value);
    }
    if (seen.size === 0) colTypes.set(col, 'string');
    else if (seen.size === 1) {
      const t = [...seen][0];
      colTypes.set(col, t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string');
    } else colTypes.set(col, 'mixed');
  }

  const columns: FlatColumnDef[] = cols.map(col => {
    const label = headers.get(col) ?? `col_${colLetter(col)}`;
    return {
      key: normalizeKey(label) || `col_${colLetter(col)}`,
      label,
      dataType: colTypes.get(col) ?? 'string',
    };
  });

  const records = classified
    .filter(r => r.type === RowType.TASK)
    .map(r => {
      const rec: Record<string, any> = {};
      for (const colDef of columns) {
        const col = cols[columns.indexOf(colDef)];
        const c = r.cells.find(x => x.col === col);
        if (c && c.value != null) rec[colDef.key] = c.value;
      }
      if (r.isCancelled) rec._cancelled = true;
      return rec;
    });

  return { columns, records };
}

// ── Public API ─────────────────────────────────────────────────

export function buildTableArtifact(
  sheet: ParsedSheet,
  options?: FormatterOptions,
): TableOutputArtifact {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sheetName = options?.sheetName ?? sheet.name;
  const filePrefix = options?.fileNamePrefix ?? sheetName;

  const classified = classifyRows(sheet);
  const headers = buildHeaderLabels(classified);
  const sqlCheck = detectSqlIndexable(sheet);

  // Compute totals from grand-total row if present (last SUBTOTAL or row-with-bold-total)
  let totals: Record<string, number | string> | undefined;
  const subtotals = classified.filter(r => r.type === RowType.SUBTOTAL);
  if (subtotals.length > 0) {
    // Sum all numeric cols across subtotal rows
    const sum: Record<string, number> = {};
    for (const r of subtotals) {
      const vals = pickNumericValues(r, headers);
      for (const [k, v] of Object.entries(vals)) {
        sum[k] = (sum[k] ?? 0) + v;
      }
    }
    if (Object.keys(sum).length > 0) totals = sum;
  }

  // Defensively pick only the 4 bound fields — callers may pass a richer object
  // (e.g. RegionBlock from table-capture has an extra `regions[]` field).
  const rawBounds = options?.dataBounds ?? computeDataBounds(sheet);
  const dataBounds = rawBounds
    ? {
        startRow: rawBounds.startRow,
        endRow: rawBounds.endRow,
        startCol: rawBounds.startCol,
        endCol: rawBounds.endCol,
      }
    : undefined;
  const dataRange = dataBounds
    ? `${colLetter(dataBounds.startCol)}${dataBounds.startRow}:${colLetter(dataBounds.endCol)}${dataBounds.endRow}`
    : undefined;
  const headerRows = classified
    .filter(r => r.type === RowType.HEADER)
    .map(r => r.rowNum);

  const baseMeta: TableMeta = {
    name: sheetName,
    description: options?.description ?? '',
    image: options?.image,
    dimensions: { rows: sheet.maxRow, cols: sheet.maxCol },
    data_range: dataRange,
    data_bounds: dataBounds,
    header_rows: headerRows.length > 0 ? headerRows : undefined,
    sql_indexable: sqlCheck.sql_indexable,
    sql_indexable_reason: sqlCheck.reason,
    structure_notes: sqlCheck.reason,
  };

  // ── SQL-indexable path ──
  if (sqlCheck.sql_indexable) {
    const flat = buildFlatData(classified, headers);
    const index: TableIndex = {
      table_meta: baseMeta,
      flat_data: flat,
      totals,
    };
    return {
      indexFileName: `tables/${filePrefix}_index.json`,
      index,
      chunks: [],
    };
  }

  // ── Hierarchical path ──
  const rawGroups = buildRawGroups(classified);

  const ctx: BuildContext = {
    headers,
    detailChunks: [],
    maxLinesPerFile: opts.maxLinesPerFile,
    filePrefix,
    chunkFileNames: new Map(),
  };

  const topSummaries = rawGroups.map(g => buildSummaryAndDetails(g, ctx));
  const summary_index = flattenSummaries(topSummaries);

  // Decide inline vs split
  const indexCandidate: TableIndex = {
    table_meta: baseMeta,
    summary_index,
    totals,
    detail_chunks_inline: ctx.detailChunks,
  };

  if (jsonLineCount(indexCandidate) <= opts.inlineThreshold) {
    // Inline everything — no separate chunk files
    return {
      indexFileName: `tables/${filePrefix}_index.json`,
      index: indexCandidate,
      chunks: [],
    };
  }

  // Split: index references chunk files
  const chunkFiles = ctx.detailChunks.map(c => ({
    fileName: ctx.chunkFileNames.get(c.chunk_id)!,
    chunk: c,
  }));

  let index: TableIndex = {
    table_meta: baseMeta,
    summary_index,
    totals,
  };

  let summaryPages: SummaryPageFile[] | undefined;

  // If index file still too big, paginate summary_index
  if (jsonLineCount(index) > opts.maxLinesPerFile) {
    summaryPages = paginateSummary(summary_index, filePrefix, opts.maxLinesPerFile);
    index = {
      table_meta: baseMeta,
      summary_index_pages: summaryPages.map(p => p.fileName),
      totals,
    };
  }

  return {
    indexFileName: `tables/${filePrefix}_index.json`,
    index,
    chunks: chunkFiles,
    summaryPages,
  };
}

/** Split summary_index into pages so each page file ≤ maxLines. */
function paginateSummary(
  entries: SummaryChunk[],
  filePrefix: string,
  maxLines: number,
): SummaryPageFile[] {
  // Greedy fill: pack entries into a page until adding one would exceed maxLines.
  const pages: SummaryPageFile[] = [];
  let pageNo = 1;
  let buf: SummaryChunk[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const fileName = `tables/${filePrefix}_summary_p${pageNo}.json`;
    pages.push({ fileName, page: { page_id: `summary_p${pageNo}`, entries: buf } });
    pageNo++;
    buf = [];
  };

  for (const e of entries) {
    const trial = [...buf, e];
    const lines = jsonLineCount({ page_id: `summary_p${pageNo}`, entries: trial });
    if (lines > maxLines && buf.length > 0) {
      flush();
    }
    buf.push(e);
  }
  flush();
  return pages;
}

export interface WriteArtifactResult {
  /** Storage ref for the index file (e.g. "<documentId>/<name>"). */
  indexRef: string;
  /** Storage refs for each detail-chunk file. */
  chunkRefs: string[];
  /** Storage refs for each summary-page file. */
  summaryPageRefs: string[];
  /** Convenience: all refs (index + chunks + summary pages). */
  all: string[];
}

/**
 * Persist artifact via the Storage abstraction. Each file is written under
 * `<documentId>/<fileName>` so that the caller can resolve later via storage.resolve().
 */
export async function writeArtifact(
  artifact: TableOutputArtifact,
  storage: import('@tinyweb_dev/doc-indexer-core').Storage,
  documentId: string,
): Promise<WriteArtifactResult> {
  const indexRef = await storage.putJson(documentId, artifact.indexFileName, artifact.index);

  const chunkRefs: string[] = [];
  for (const c of artifact.chunks) {
    const ref = await storage.putJson(documentId, c.fileName, c.chunk);
    chunkRefs.push(ref);
  }

  const summaryPageRefs: string[] = [];
  if (artifact.summaryPages) {
    for (const sp of artifact.summaryPages) {
      const ref = await storage.putJson(documentId, sp.fileName, sp.page);
      summaryPageRefs.push(ref);
    }
  }

  return {
    indexRef,
    chunkRefs,
    summaryPageRefs,
    all: [indexRef, ...chunkRefs, ...summaryPageRefs],
  };
}
