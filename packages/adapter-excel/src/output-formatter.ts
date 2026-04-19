// Output formatter - converts MindmapNode tree to human/agent-readable formats
import type { MindmapNode } from './types';

/**
 * Convert tree to indented Markdown for human reading.
 */
export function treeToMarkdown(node: MindmapNode, level = 0): string {
  const lines: string[] = [];

  if (level === 0) {
    lines.push(`# ${node.title}`);
  } else if (level <= 3) {
    lines.push(`${'#'.repeat(Math.min(level + 1, 6))} ${node.title}`);
  } else {
    const indent = '  '.repeat(level - 4);
    const summary = node.summary ? ` *(${node.summary})*` : '';
    lines.push(`${indent}- ${node.title}${summary}`);
  }

  for (const child of node.children) {
    lines.push(treeToMarkdown(child, level + 1));
  }

  return lines.join('\n');
}

/**
 * Convert tree to a clean JSON structure for agent consumption.
 * Strips sourceData to keep output compact.
 */
export function treeToJSON(node: MindmapNode): any {
  const result: any = { title: node.title };
  if (node.summary) result.summary = node.summary;
  if (node.sourceRange) result.sourceRange = node.sourceRange;
  if (node.children.length > 0) {
    result.children = node.children.map(c => treeToJSON(c));
  }
  return result;
}

/**
 * Convert tree to a flat table (array of rows) for CSV/tabular output.
 */
export function treeToFlatRows(node: MindmapNode): Array<{ depth: number; title: string; summary: string }> {
  const rows: Array<{ depth: number; title: string; summary: string }> = [];

  function walk(n: MindmapNode) {
    rows.push({ depth: n.depth, title: n.title, summary: n.summary ?? '' });
    for (const child of n.children) walk(child);
  }

  walk(node);
  return rows;
}
