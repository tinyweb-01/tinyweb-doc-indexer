/**
 * Core public types for @tinyweb_dev/doc-indexer.
 *
 * The library normalizes any input source (excel, pdf, image, url, ...)
 * into an `IndexedDocument` made of `Chunk[]` + an optional outline `tree`
 * + `assets` (snapshots, extracted images, ...). This output is intended
 * to be fed into a downstream embedding / vector-store pipeline.
 */

export type SourceType =
  | 'excel'
  | 'gsheet'
  | 'pdf'
  | 'image'
  | 'url'
  | 'gdoc'
  | 'docx'
  | 'markdown'
  | 'text';

export interface SourceInput {
  /** Force a specific adapter; 'auto' (default) lets the registry detect. */
  type?: SourceType | 'auto';
  /** Local filesystem path. */
  path?: string;
  /** Remote URL or scheme-prefixed locator (https://, gsheet://, gdoc://, drive://). */
  url?: string;
  /** Raw bytes (when caller already has the file in memory). */
  buffer?: Uint8Array;
  /** MIME type override; helpful when `buffer` is provided. */
  mime?: string;
  /** Free-form metadata propagated to chunks. */
  meta?: Record<string, unknown>;
}

export type ChunkType =
  | 'section'
  | 'paragraph'
  | 'table'
  | 'row'
  | 'image'
  | 'caption'
  | 'summary';

export interface AssetRef {
  kind: 'image' | 'snapshot' | 'file';
  /** Storage-relative reference returned by `Storage.putAsset`. */
  ref: string;
  alt?: string;
  mime?: string;
}

export interface SourceRef {
  documentId: string;
  sourceType: SourceType;
  /** Adapter-specific locator, e.g. `Sheet1!A1:G20`, `page=3`, `url#section-2`. */
  locator: string;
  page?: number;
  sheet?: string;
  bbox?: [number, number, number, number];
}

export interface Chunk {
  id: string;
  parentId?: string;
  order: number;
  type: ChunkType;
  title?: string;
  /** Plain-text / markdown representation, ready for embedding. */
  content: string;
  /** Optional structured payload (table tree, JSON, ...). */
  contentRich?: unknown;
  /** Estimated token count (useful for chunk-budget planning). */
  tokens?: number;
  /** Optionally optimized text for embedding (otherwise use `content`). */
  embeddingsHint?: string;
  assets?: AssetRef[];
  source: SourceRef;
  metadata?: Record<string, unknown>;
}

export interface TreeNode {
  id: string;
  title: string;
  chunkId?: string;
  children: TreeNode[];
  metadata?: Record<string, unknown>;
}

export interface AssetManifest extends AssetRef {
  bytes?: number;
  description?: string;
}

export interface IndexedDocument {
  id: string;
  title: string;
  sourceType: SourceType;
  createdAt: string;
  chunks: Chunk[];
  tree?: TreeNode;
  assets: AssetManifest[];
  stats: {
    chunkCount: number;
    tokenEstimate: number;
    durationMs: number;
  };
  metadata?: Record<string, unknown>;
}

// ---- streaming events -----------------------------------------------------

export type IndexedEvent =
  | { kind: 'chunk'; chunk: Chunk }
  | { kind: 'asset'; asset: AssetManifest }
  | { kind: 'tree'; tree: TreeNode }
  | { kind: 'progress'; pct: number; message?: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'done'; doc: IndexedDocument };

export interface ProgressEvent {
  pct: number;
  message?: string;
}

// ---- logger ---------------------------------------------------------------

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}
