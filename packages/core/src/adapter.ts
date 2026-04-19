import type {
  Chunk,
  IndexedDocument,
  IndexedEvent,
  Logger,
  SourceInput,
  SourceType,
  TreeNode,
  AssetManifest,
} from './types.js';
import type { LLMProvider, VisionProvider } from './llm.js';
import type { Storage } from './storage/interface.js';

/**
 * Adapter contract. Each adapter is responsible for ONE source type.
 * Adapters yield `IndexedEvent`s as they progress; the orchestrator
 * (`Indexer`) collects those events into a final `IndexedDocument`.
 */
export interface SourceAdapter {
  readonly type: SourceType;

  /** Used by `type: 'auto'` detection. Cheap inspection only (mime, ext). */
  detect?(input: SourceInput): boolean | Promise<boolean>;

  /** Streaming index. MUST end with a `{ kind: 'done', doc }` event. */
  index(input: SourceInput, ctx: IndexContext): AsyncIterable<IndexedEvent>;
}

export interface IndexContext {
  documentId: string;
  llm?: LLMProvider;
  vision?: VisionProvider;
  storage: Storage;
  logger: Logger;
  signal?: AbortSignal;
  /** Adapter-specific options (passthrough from `Indexer.index({ options })`). */
  options: Record<string, unknown>;
  emit(ev: IndexedEvent): void;
}

/** Helpers used by adapters to build common parts of the document. */
export interface AdapterHelpers {
  newChunkId(prefix?: string): string;
}

/** Convenience: gather all events into an in-memory `IndexedDocument`. */
export function collectDocument(
  events: AsyncIterable<IndexedEvent>,
  base: Pick<IndexedDocument, 'id' | 'title' | 'sourceType'>
): Promise<IndexedDocument> {
  return (async () => {
    const start = Date.now();
    const chunks: Chunk[] = [];
    const assets: AssetManifest[] = [];
    let tree: TreeNode | undefined;
    let final: IndexedDocument | undefined;

    for await (const ev of events) {
      switch (ev.kind) {
        case 'chunk':
          chunks.push(ev.chunk);
          break;
        case 'asset':
          assets.push(ev.asset);
          break;
        case 'tree':
          tree = ev.tree;
          break;
        case 'done':
          final = ev.doc;
          break;
        default:
          break;
      }
    }

    if (final) return final;
    return {
      ...base,
      createdAt: new Date().toISOString(),
      chunks,
      tree,
      assets,
      stats: {
        chunkCount: chunks.length,
        tokenEstimate: chunks.reduce((s, c) => s + (c.tokens ?? 0), 0),
        durationMs: Date.now() - start,
      },
    };
  })();
}
