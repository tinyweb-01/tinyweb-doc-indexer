import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import type { Storage } from './interface.js';

/** Filesystem storage. Layout: `<root>/<documentId>/<name>`. */
export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private docDir(documentId: string): string {
    return path.join(this.root, documentId);
  }

  private async ensureDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  private async writeStream(target: string, stream: Readable): Promise<void> {
    const { createWriteStream } = await import('node:fs');
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(target);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
  }

  async putAsset(
    documentId: string,
    name: string,
    data: Uint8Array | Readable
  ): Promise<string> {
    const dir = this.docDir(documentId);
    await this.ensureDir(path.dirname(path.join(dir, name)));
    const target = path.join(dir, name);
    if (data instanceof Uint8Array) {
      await fs.writeFile(target, data);
    } else {
      await this.writeStream(target, data);
    }
    return `${documentId}/${name}`;
  }

  async putJson(documentId: string, name: string, data: unknown): Promise<string> {
    const dir = this.docDir(documentId);
    await this.ensureDir(path.dirname(path.join(dir, name)));
    const target = path.join(dir, name);
    await fs.writeFile(target, JSON.stringify(data, null, 2), 'utf8');
    return `${documentId}/${name}`;
  }

  async getJson<T = unknown>(documentId: string, name: string): Promise<T | null> {
    const target = path.join(this.docDir(documentId), name);
    try {
      const raw = await fs.readFile(target, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(documentId: string): Promise<string[]> {
    const dir = this.docDir(documentId);
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const abs = path.join(dir, rel);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(next);
        else out.push(next);
      }
    };
    await walk('');
    return out;
  }

  resolve(ref: string): string {
    return path.resolve(this.root, ref);
  }
}
