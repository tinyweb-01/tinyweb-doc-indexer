import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { SourceAdapter } from './adapter.js';
import { collectDocument } from './adapter.js';
import type { LLMProvider, VisionProvider } from './llm.js';
import { ConsoleLogger } from './logger.js';
import type { Storage } from './storage/interface.js';
import { FsStorage } from './storage/fs.js';
import type {
  IndexedDocument,
  IndexedEvent,
  Logger,
  SourceInput,
  SourceType,
} from './types.js';

export interface IndexerOptions {
  adapters: SourceAdapter[];
  llm?: LLMProvider;
  vision?: VisionProvider;
  storage?: Storage;
  logger?: Logger;
}

export interface IndexCallOptions {
  /** Override or supply per-call adapter options. */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Provide a stable id (otherwise derived from input). */
  documentId?: string;
}

const EXT_MAP: Record<string, SourceType> = {
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.xlsm': 'excel',
  '.csv': 'excel',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.docx': 'docx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
};

export class Indexer {
  private readonly adapters: Map<SourceType, SourceAdapter>;
  private readonly llm?: LLMProvider;
  private readonly vision?: VisionProvider;
  private readonly storage: Storage;
  private readonly logger: Logger;

  constructor(opts: IndexerOptions) {
    this.adapters = new Map();
    for (const a of opts.adapters) this.adapters.set(a.type, a);
    this.llm = opts.llm;
    this.vision = opts.vision;
    this.storage = opts.storage ?? new FsStorage('./.doc-indexer-out');
    this.logger = opts.logger ?? new ConsoleLogger();
  }

  /** Promise mode: run to completion and return the document. */
  async index(input: SourceInput, opts: IndexCallOptions = {}): Promise<IndexedDocument> {
    const { adapter, resolved, documentId } = await this.resolve(input, opts);
    const ctx = this.makeContext(documentId, opts);
    const events = adapter.index(resolved, ctx);
    return collectDocument(events, {
      id: documentId,
      title: this.deriveTitle(resolved),
      sourceType: adapter.type,
    });
  }

  /** Streaming mode: yield events as the adapter produces them. */
  async *indexStream(
    input: SourceInput,
    opts: IndexCallOptions = {}
  ): AsyncIterable<IndexedEvent> {
    const { adapter, resolved, documentId } = await this.resolve(input, opts);
    const ctx = this.makeContext(documentId, opts);
    yield* adapter.index(resolved, ctx);
  }

  // -------------------------------------------------------------------------

  private makeContext(documentId: string, opts: IndexCallOptions) {
    const emit = (_ev: IndexedEvent): void => {
      // Reserved hook; today events flow through the async generator only.
    };
    return {
      documentId,
      llm: this.llm,
      vision: this.vision,
      storage: this.storage,
      logger: this.logger,
      signal: opts.signal,
      options: opts.options ?? {},
      emit,
    };
  }

  private async resolve(input: SourceInput, opts: IndexCallOptions) {
    const detectedType = await this.detectType(input);
    const adapter = this.adapters.get(detectedType);
    if (!adapter) {
      throw new Error(
        `No adapter registered for source type "${detectedType}". ` +
          `Registered: [${[...this.adapters.keys()].join(', ')}]`
      );
    }
    const resolved: SourceInput = { ...input, type: detectedType };
    const documentId = opts.documentId ?? this.deriveId(resolved);
    return { adapter, resolved, documentId };
  }

  private async detectType(input: SourceInput): Promise<SourceType> {
    if (input.type && input.type !== 'auto') return input.type;
    if (input.url) {
      if (input.url.startsWith('gsheet://')) return 'gsheet';
      if (input.url.startsWith('gdoc://')) return 'gdoc';
      return 'url';
    }
    if (input.path) {
      const ext = path.extname(input.path).toLowerCase();
      const fromExt = EXT_MAP[ext];
      if (fromExt) return fromExt;
    }
    // Try adapter-level detect()
    for (const a of this.adapters.values()) {
      if (a.detect && (await a.detect(input))) return a.type;
    }
    throw new Error(
      `Unable to auto-detect source type for input. Provide \`type\` explicitly.`
    );
  }

  private deriveId(input: SourceInput): string {
    const base = input.path ?? input.url ?? randomUUID();
    return createHash('sha1').update(base).digest('hex').slice(0, 16);
  }

  private deriveTitle(input: SourceInput): string {
    if (input.path) return path.basename(input.path);
    if (input.url) return input.url;
    return 'Untitled document';
  }
}
