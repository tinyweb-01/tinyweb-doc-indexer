/**
 * Markdown Tree Exporter
 * ──────────────────────
 * Mirrors the parsed mindmap tree as a folder/markdown hierarchy under
 * `<documentId>/contents/`. Every branch becomes a folder; every leaf becomes
 * a `.md` file. A top-level `README.md` is also written with a TOC.
 *
 * Layout produced (when combined with the `images/` and `table_contents/`
 * subdirs that capture/output-formatter already emit):
 *
 *   <documentId>/
 *     index.json
 *     README.md                                  ← TOC + summary
 *     images/                                    ← all PNG snapshots
 *     tables/                            ← all per-table JSON
 *     contents/
 *       01_<sheet>/
 *         _index.md                              ← branch summary (optional)
 *         01_<heading>/
 *           01_<table>.md                        ← leaf, links to table JSON + image
 *
 * All file names are sanitized to be filesystem-safe across Windows / macOS /
 * Linux while preserving CJK characters. Sibling order is encoded as a
 * zero-padded numeric prefix so the on-disk listing matches the mindmap.
 */

import type { Storage } from '@tinyweb_dev/doc-indexer-core';
import type {
  MindmapNode,
  ParsedCell,
  TableNodePayload,
  SheetNodePayload,
} from './types';

// ── Filename sanitization ──────────────────────────────────────

const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_LEN = 80;

/**
 * Make a single path segment safe for any common filesystem.
 * Preserves CJK, strips forbidden chars, trims leading/trailing dots & spaces,
 * caps length, and avoids Windows reserved names.
 */
function sanitizeSegment(raw: string): string {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(FORBIDDEN_CHARS, '_');
  // Replace path separators that may have slipped in
  s = s.replace(/[/\\]/g, '_');
  // Trim trailing dots / spaces (illegal on Windows)
  s = s.replace(/[.\s]+$/g, '').replace(/^[.\s]+/g, '');
  if (!s) s = 'untitled';
  if (RESERVED_WIN.test(s)) s = `_${s}`;
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN).replace(/[.\s]+$/g, '');
  return s;
}

/** Pad a 1-based sibling index to a width that fits the largest sibling. */
function pad(idx: number, total: number): string {
  const w = Math.max(2, String(total).length);
  return String(idx).padStart(w, '0');
}

/** Short-id fallback to disambiguate colliding sanitized names. */
function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'x';
}

/**
 * Build a unique, ordered name for a single sibling node.
 * Format: `<NN>_<sanitized-title>` (+ `__<shortId>` only on collision).
 */
function nameSibling(
  node: MindmapNode,
  idx: number,
  total: number,
  used: Set<string>,
): string {
  const base = `${pad(idx, total)}_${sanitizeSegment(node.title)}`;
  let name = base;
  if (used.has(name)) name = `${base}__${shortId(node.id)}`;
  // Guard a second collision
  while (used.has(name)) name = `${name}_`;
  used.add(name);
  return name;
}

// ── Path helpers ───────────────────────────────────────────────

/**
 * Compute a POSIX-style relative path FROM `fromFile` TO `toFile`,
 * where both are paths inside the same document directory.
 *
 * Both are slash-separated, no leading slash, and `fromFile` is the
 * markdown file's location; we resolve relative to its parent dir.
 */
function relPath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toParts = toFile.split('/');
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  const up = new Array(fromDir.length - i).fill('..');
  const down = toParts.slice(i);
  const rel = [...up, ...down].join('/');
  return rel || '.';
}

/** Strip the leading `<documentId>/` from a storage ref to get the in-doc path. */
function stripDocPrefix(ref: string | undefined, documentId: string): string | undefined {
  if (!ref) return undefined;
  const prefix = `${documentId}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

// ── Markdown rendering ─────────────────────────────────────────

function escapeInline(s: string): string {
  return (s ?? '').replace(/\|/g, '\\|');
}

/**
 * Render the full content cells of a heading section as markdown.
 * Each cell with a non-empty value becomes a paragraph / bullet line so the
 * markdown contains the full source text (not the truncated 3-line preview
 * stored in `node.summary`).
 */
function renderFullContent(cells: ParsedCell[] | undefined): string[] {
  if (!cells || cells.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of cells) {
    if (c.value === null || c.value === undefined) continue;
    const text = String(c.value).trim();
    if (!text) continue;
    // Dedup identical consecutive lines (merged cells emit duplicates).
    if (seen.has(text)) continue;
    seen.add(text);
    // Preserve multi-line cell values as-is.
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) out.push(line);
    }
  }
  return out;
}

function renderLeafMarkdown(
  node: MindmapNode,
  filePath: string,
  documentId: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${node.title}`);
  lines.push('');

  if (node.sourceRange) {
    lines.push(`> **Source:** \`${node.sourceRange}\``);
    lines.push('');
  }

  const kind = node.kind ?? 'heading';

  // Full content for heading/leaf nodes (unless a richer kind provides its own body).
  const fullLines = renderFullContent(node.sourceData);
  if (fullLines.length > 0 && (kind === 'heading' || kind === 'sheet')) {
    for (const ln of fullLines) lines.push(ln);
    lines.push('');
  } else if (node.summary) {
    lines.push(node.summary);
    lines.push('');
  }

  if (kind === 'sheet') {
    const p = node.payload as SheetNodePayload | undefined;
    const png = stripDocPrefix(p?.pngPath, documentId);
    if (png) {
      lines.push(`![${escapeInline(node.title)}](${relPath(filePath, png)})`);
      lines.push('');
    }
    if (p?.hidden) {
      lines.push(`> ⚠️ This sheet was hidden in the source workbook.`);
      lines.push('');
    }
  } else if (kind === 'table') {
    const p = node.payload as TableNodePayload | undefined;
    if (p?.range) {
      lines.push(`- **Range:** \`${p.range}\``);
    }
    if (p?.tableMeta) {
      const m = p.tableMeta;
      lines.push(`- **Name:** ${escapeInline(m.name)}`);
      if (m.description) lines.push(`- **Description:** ${escapeInline(m.description)}`);
      lines.push(`- **Dimensions:** ${m.rows} rows × ${m.cols} cols`);
      lines.push(`- **SQL-indexable:** ${m.sql_indexable ? 'yes' : 'no'}`);
    }
    lines.push('');
    const png = stripDocPrefix(p?.pngPath, documentId);
    if (png) {
      lines.push(`![${escapeInline(node.title)}](${relPath(filePath, png)})`);
      lines.push('');
    }
    const idx = stripDocPrefix(p?.indexFile, documentId);
    if (idx) {
      lines.push(`📄 [Table data (JSON)](${relPath(filePath, idx)})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderBranchIndexMarkdown(
  node: MindmapNode,
  filePath: string,
  documentId: string,
  childEntries: Array<{ name: string; isFolder: boolean; title: string }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${node.title}`);
  lines.push('');

  if (node.sourceRange) {
    lines.push(`> **Source:** \`${node.sourceRange}\``);
    lines.push('');
  }

  const kind = node.kind ?? 'heading';
  const fullLines = renderFullContent(node.sourceData);
  if (fullLines.length > 0 && kind !== 'table') {
    for (const ln of fullLines) lines.push(ln);
    lines.push('');
  } else if (node.summary) {
    lines.push(node.summary);
    lines.push('');
  }

  // Sheet snapshot, when this branch IS a sheet.
  if ((node.kind ?? 'heading') === 'sheet') {
    const p = node.payload as SheetNodePayload | undefined;
    const png = stripDocPrefix(p?.pngPath, documentId);
    if (png) {
      lines.push(`![${escapeInline(node.title)}](${relPath(filePath, png)})`);
      lines.push('');
    }
  }

  if (childEntries.length) {
    lines.push('## Contents');
    lines.push('');
    for (const c of childEntries) {
      const target = c.isFolder ? `${c.name}/_index.md` : c.name;
      lines.push(`- [${escapeInline(c.title)}](${target})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderRootReadme(
  root: MindmapNode,
  documentId: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${root.title}`);
  lines.push('');
  lines.push(`> **Document ID:** \`${documentId}\``);
  lines.push('');
  if (root.summary) {
    lines.push(root.summary);
    lines.push('');
  }
  lines.push('## Layout');
  lines.push('');
  lines.push('- `index.json` — full indexed document (chunks + tree)');
  lines.push('- `images/` — sheet & table snapshots (PNG)');
  lines.push('- `tables/` — per-table JSON (index + chunks + summary pages)');
  lines.push('- `contents/` — markdown mirror of the parsed mindmap');
  lines.push('');
  lines.push('## Tree');
  lines.push('');

  const walk = (n: MindmapNode, depth: number, pathPrefix: string, idx: number, total: number, used: Set<string>): void => {
    const name = nameSibling(n, idx, total, used);
    const isBranch = n.children.length > 0;
    const target = isBranch
      ? `contents/${pathPrefix}${name}/_index.md`
      : `contents/${pathPrefix}${name}.md`;
    lines.push(`${'  '.repeat(depth)}- [${escapeInline(n.title)}](${target})`);
    if (isBranch) {
      const childUsed = new Set<string>();
      n.children.forEach((c, i) => walk(c, depth + 1, `${pathPrefix}${name}/`, i + 1, n.children.length, childUsed));
    }
  };

  // Render children of root directly (root itself is the document).
  const used = new Set<string>();
  root.children.forEach((c, i) => walk(c, 0, '', i + 1, root.children.length, used));
  lines.push('');

  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────

export interface ExportMarkdownTreeOptions {
  storage: Storage;
  documentId: string;
  root: MindmapNode;
}

export interface ExportMarkdownTreeResult {
  /** Storage refs of every file written. */
  refs: string[];
}

/**
 * Export the mindmap tree as a markdown folder hierarchy. Idempotent w.r.t.
 * a single call (sibling names are deterministic for a given tree).
 */
export async function exportMarkdownTree(
  opts: ExportMarkdownTreeOptions,
): Promise<ExportMarkdownTreeResult> {
  const { storage, documentId, root } = opts;
  const refs: string[] = [];

  const writeText = async (name: string, content: string): Promise<void> => {
    const ref = await storage.putAsset(documentId, name, Buffer.from(content, 'utf8'));
    refs.push(ref);
  };

  // Root README
  await writeText('README.md', renderRootReadme(root, documentId));

  // Recursive walk of children — root itself is represented by README.md.
  const walk = async (
    n: MindmapNode,
    parentDir: string,
    siblingIdx: number,
    siblingTotal: number,
    usedNames: Set<string>,
  ): Promise<{ name: string; isFolder: boolean; title: string }> => {
    const name = nameSibling(n, siblingIdx, siblingTotal, usedNames);
    const isBranch = n.children.length > 0;

    if (!isBranch) {
      const filePath = `contents/${parentDir}${name}.md`;
      await writeText(filePath, renderLeafMarkdown(n, filePath, documentId));
      return { name: `${name}.md`, isFolder: false, title: n.title };
    }

    // Branch — recurse into children, then write _index.md
    const childUsed = new Set<string>();
    const childEntries: Array<{ name: string; isFolder: boolean; title: string }> = [];
    for (let i = 0; i < n.children.length; i++) {
      const entry = await walk(n.children[i], `${parentDir}${name}/`, i + 1, n.children.length, childUsed);
      childEntries.push(entry);
    }
    const indexPath = `contents/${parentDir}${name}/_index.md`;
    await writeText(indexPath, renderBranchIndexMarkdown(n, indexPath, documentId, childEntries));
    return { name, isFolder: true, title: n.title };
  };

  const rootUsed = new Set<string>();
  for (let i = 0; i < root.children.length; i++) {
    await walk(root.children[i], '', i + 1, root.children.length, rootUsed);
  }

  return { refs };
}
