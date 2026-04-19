import type { Readable } from 'node:stream';

/**
 * Storage abstraction for assets (images, snapshots) and side-car JSON.
 * Implementations: FsStorage (default), MemoryStorage (tests), S3Storage (extension).
 */
export interface Storage {
  /** Persist a binary asset. Returns a stable `ref` usable in `AssetRef.ref`. */
  putAsset(
    documentId: string,
    name: string,
    data: Uint8Array | Readable,
    opts?: { mime?: string }
  ): Promise<string>;

  /** Persist arbitrary JSON. Returns a stable `ref`. */
  putJson(documentId: string, name: string, data: unknown): Promise<string>;

  /** Read JSON back (used by cache / inspect). */
  getJson<T = unknown>(documentId: string, name: string): Promise<T | null>;

  /** List all stored entries for a document. */
  list(documentId: string): Promise<string[]>;

  /** Resolve a `ref` to an absolute or fully-qualified URI for consumers. */
  resolve(ref: string): string;
}
