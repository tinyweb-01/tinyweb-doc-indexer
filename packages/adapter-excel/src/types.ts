// Shared types for Excel Knowledge Absorber

export interface ParsedCell {
  ref: string; // A1 reference
  value: string | number | boolean | null;
  formula: string | null;
  isBold: boolean;
  fontSize: number | null;
  isMerged: boolean;
  row: number;
  col: number;
  fillColor?: string;       // e.g. "#D9E6FC"
  fontColor?: string;        // e.g. "#FF0000"
  isStrikethrough?: boolean;
}

export interface ParsedSheet {
  name: string;
  cells: ParsedCell[];
  mergedCells: string[];
  maxRow: number;
  maxCol: number;
  /** True if the worksheet was hidden (or veryHidden) in the source workbook. */
  hidden?: boolean;
}

export interface ParsedWorkbook {
  fileName: string;
  sheets: ParsedSheet[];
}

export type NodeKind = 'document' | 'sheet' | 'heading' | 'table';

export interface SheetNodePayload {
  kind: 'sheet';
  /** Public URL (or absolute fs path when no publicPrefix) of the full-sheet PNG. */
  pngPath?: string;
  /** Sheet display name (== node.title, kept for symmetry). */
  sheetName: string;
  /** True if the sheet was hidden in the source workbook (skipped from analysis). */
  hidden?: boolean;
}

export interface TableNodePayload {
  kind: 'table';
  /** A1 range within the sheet, e.g. "A1:L40" */
  range: string;
  /** Public-relative path to the captured PNG, e.g. "/assets/<docId>/Sheet1_table_0.png" */
  pngPath?: string;
  /** Filesystem or public path to the table index JSON */
  indexFile?: string;
  /** Lightweight metadata derived from TableMeta (lifted for quick rendering) */
  tableMeta?: {
    name: string;
    description: string;
    sql_indexable: boolean;
    rows: number;
    cols: number;
  };
}

export interface HeadingNodePayload {
  kind: 'heading';
  cells?: ParsedCell[];
}

export interface MindmapNode {
  id: string;
  title: string;
  summary?: string;
  translatedTitle?: string;
  translatedSummary?: string;
  children: MindmapNode[];
  sourceRange?: string; // e.g. "Sheet1!A1:D10"
  /** @deprecated use payload.cells (heading) or payload.tableMeta (table) instead */
  sourceData?: ParsedCell[];
  depth: number;
  /** Discriminator for rendering / behaviour. Defaults to 'heading' for back-compat. */
  kind?: NodeKind;
  /** Optional kind-specific payload. */
  payload?: TableNodePayload | HeadingNodePayload | SheetNodePayload;
}

export interface AnalyzeRequest {
  workbook: ParsedWorkbook;
  useLLM?: boolean;
}

export interface AnalyzeResponse {
  tree: MindmapNode;
}

// ── Table Representation for AI Retrieval ──────────────────────
// See: experiences/table-indexing/complex-table-representation-for-ai.md

export interface TableMeta {
  name: string;
  /** Business-level description (what the table represents in business terms). Filled by LLM enricher or caller. */
  description: string;
  /** Optional path / URL to a rendered image of the table for visual reference. */
  image?: string;
  /** Sheet dimensions (full sheet size, including empty surrounding cells). */
  dimensions: { rows: number; cols: number };
  /** A1-style range of the actual table data area, e.g. "A2:L100". Excludes empty surrounding rows/cols. */
  data_range?: string;
  /** Structured form of data_range (1-based, inclusive) for programmatic use. */
  data_bounds?: { startRow: number; endRow: number; startCol: number; endCol: number };
  /** Header row numbers (1-based). Empty if no clear header. */
  header_rows?: number[];
  sql_indexable: boolean;
  sql_indexable_reason?: string;
  /** Structural notes (merged cells, subtotal rows, ...) — kept separate from business description. */
  structure_notes?: string;
  chunk_files?: string[];
}

export interface TaskRecord {
  task: string;
  cancelled: boolean;
  [key: string]: any;
}

export interface SummaryChunk {
  chunk_id: string;
  path: string;
  subtotal?: Record<string, number>;
  row_range: string;
  children_count: number;
  keywords: string[];
  chunk_file?: string;
  sub_chunks?: string[];
}

export interface DetailChunk {
  chunk_id: string;
  path: string;
  parent_chunk: string | null;
  subtotal?: Record<string, number>;
  tasks: TaskRecord[];
}

export interface FlatColumnDef {
  key: string;
  label: string;
  dataType: 'string' | 'number' | 'boolean' | 'date' | 'mixed';
}

export interface TableIndex {
  table_meta: TableMeta;
  // For sql_indexable = true
  flat_data?: {
    columns: FlatColumnDef[];
    records: Record<string, any>[];
  };
  // For sql_indexable = false
  summary_index?: SummaryChunk[];
  // When summary_index itself exceeds size cap, it is split into pages
  summary_index_pages?: string[];
  totals?: Record<string, number | string>;
  // Inlined chunks if total output ≤ inline_threshold
  detail_chunks_inline?: DetailChunk[];
}

export interface SummaryPageFile {
  fileName: string;
  page: { page_id: string; entries: SummaryChunk[] };
}

export interface TableOutputArtifact {
  indexFileName: string;
  index: TableIndex;
  // Detail chunks written separately when output is split
  chunks: Array<{ fileName: string; chunk: DetailChunk }>;
  // Summary index pages when summary itself exceeds size cap
  summaryPages?: SummaryPageFile[];
}
