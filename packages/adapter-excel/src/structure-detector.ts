// Structure detector - builds mindmap tree from parsed workbook
// Multi-signal scoring approach for hierarchy detection
import type { ParsedWorkbook, ParsedSheet, ParsedCell, MindmapNode } from './types';
import type { Region } from './region-detector';

let nodeCounter = 0;
function nextId(): string {
  return `node-${++nodeCounter}`;
}

// ── Numbering detection ───────────────────────────────────────

// Matches: "1.", "1.概要", "2.作業範囲", "5.1.", "5.1.前提条件", "5.1.1" etc.
// REQUIRES a dot after number. Does NOT match bare "1", "2", "3".
const NUMBERING_RE = /^[\s\u3000]*([０-９0-9]+(?:[.．][０-９0-9]+)*)[.．]\s*(.*)$/;

// Matches "Step N:" or "Step N：" patterns (common in table-based sheets)
const STEP_RE = /^[\s\u3000]*(Step\s*\d+)\s*[:：]\s*(.*)$/i;

function normalizeNumber(s: string): string {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
          .replace(/．/g, '.');
}

function parseNumbering(text: string): { depth: number; prefix: string; rest: string } | null {
  const m = String(text).match(NUMBERING_RE);
  if (!m) return null;
  const raw = normalizeNumber(m[1]);
  const parts = raw.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every(p => /^\d+$/.test(p))) return null;
  return { depth: parts.length, prefix: parts.join('.'), rest: m[2].trim() };
}

// ── Heading detection ─────────────────────────────────────────

interface HeadingInfo {
  cell: ParsedCell;
  depth: number;
  prefix: string | null; // numbering prefix like "5.1"
}

function detectHeadingsAndContent(sheet: ParsedSheet): {
  headings: HeadingInfo[];
  contentByRow: Map<number, ParsedCell[]>;
} {
  const allByRow = new Map<number, ParsedCell[]>();
  for (const cell of sheet.cells) {
    if (cell.value === null || cell.value === '') continue;
    if (!allByRow.has(cell.row)) allByRow.set(cell.row, []);
    allByRow.get(cell.row)!.push(cell);
  }

  // Sort rows by row number
  const sortedRows = [...allByRow.keys()].sort((a, b) => a - b);

  // Count columns per row to determine sheet type
  const colCountPerRow = new Map<number, number>();
  for (const row of sortedRows) {
    colCountPerRow.set(row, new Set(allByRow.get(row)!.map(c => c.col)).size);
  }

  // Determine if sheet is primarily table-based (>40% of rows have 4+ columns)
  const wideRowCount = [...colCountPerRow.values()].filter(c => c >= 4).length;
  const isTableSheet = sortedRows.length > 4 && wideRowCount / sortedRows.length > 0.4;

  // For non-table sheets: detect table regions the old way
  const tableRows = new Set<number>();
  if (!isTableSheet) {
    for (const row of sortedRows) {
      const cells = allByRow.get(row)!;
      const distinctCols = new Set(cells.map(c => c.col));
      if (distinctCols.size >= 3) tableRows.add(row);
      const boldCount = cells.filter(c => c.isBold).length;
      if (boldCount >= 2) tableRows.add(row);
    }
    // Expand table regions
    const tableRowsSorted = [...tableRows].sort((a, b) => a - b);
    for (let i = 0; i < tableRowsSorted.length - 1; i++) {
      const gap = tableRowsSorted[i + 1] - tableRowsSorted[i];
      if (gap <= 3) {
        for (let r = tableRowsSorted[i] + 1; r < tableRowsSorted[i + 1]; r++) {
          tableRows.add(r);
        }
      }
    }
  }

  // Compute median font size from all cells
  const fontSizes = [...allByRow.values()]
    .flat()
    .map(c => c.fontSize)
    .filter((f): f is number => f !== null && f > 0);
  const medianFontSize = fontSizes.length > 0
    ? fontSizes.sort((a, b) => a - b)[Math.floor(fontSizes.length / 2)]
    : 11;

  // Subtotal pattern - these are never headings
  const SUBTOTAL_RE = /合計|小計|subtotal|total/i;

  const headings: HeadingInfo[] = [];
  const contentRows = new Map<number, ParsedCell[]>();

  for (const row of sortedRows) {
    const cells = allByRow.get(row)!;
    const sorted = cells.sort((a, b) => a.col - b.col);
    const numCols = colCountPerRow.get(row) || 1;

    // Collect text from all cells for pattern matching
    const allTexts = sorted.map(c => String(c.value ?? '').trim());
    const firstText = allTexts[0];

    // Skip empty/trivial first cell
    if (!firstText || /^[0-9０-９]+$/.test(firstText) || (firstText.length <= 1 && !/[a-zA-Z\u3000-\u9FFF]/.test(firstText))) {
      // But check other cells for Step/numbering patterns (e.g., Step N: in col C)
      let found = false;
      for (let ci = 1; ci < sorted.length; ci++) {
        const t = String(sorted[ci].value ?? '').trim();
        if (!t) continue;
        const stepM = t.match(STEP_RE);
        const numM = parseNumbering(t);
        if (stepM && !SUBTOTAL_RE.test(t)) {
          const stepNum = stepM[1].replace(/\s+/g, '').match(/\d+/)?.[0] || '1';
          const title = stepM[2].trim() ? `${stepM[1]}: ${stepM[2].trim()}` : stepM[1];
          headings.push({ cell: { ...sorted[ci], value: title }, depth: 2, prefix: `step${stepNum}` });
          const rest = sorted.filter((_, i) => i !== ci);
          if (rest.length > 0) contentRows.set(row, rest);
          found = true;
          break;
        }
        if (numM && !SUBTOTAL_RE.test(t)) {
          headings.push({ cell: sorted[ci], depth: numM.depth, prefix: numM.prefix });
          const rest = sorted.filter((_, i) => i !== ci);
          if (rest.length > 0) contentRows.set(row, rest);
          found = true;
          break;
        }
      }
      if (found) continue;
      contentRows.set(row, sorted);
      continue;
    }

    // Check for "Step N:" pattern in first cell
    const stepMatch = firstText.match(STEP_RE);
    if (stepMatch && !SUBTOTAL_RE.test(firstText)) {
      const stepNum = stepMatch[1].replace(/\s+/g, '').match(/\d+/)?.[0] || '1';
      const title = stepMatch[2].trim() ? `${stepMatch[1]}: ${stepMatch[2].trim()}` : stepMatch[1];
      headings.push({ cell: { ...sorted[0], value: title }, depth: 2, prefix: `step${stepNum}` });
      if (sorted.length > 1) contentRows.set(row, sorted.slice(1));
      continue;
    }

    // Check for numbering pattern (strongest signal)
    const numbering = parseNumbering(firstText);
    if (numbering && !SUBTOTAL_RE.test(firstText)) {
      headings.push({ cell: sorted[0], depth: numbering.depth, prefix: numbering.prefix });
      if (sorted.length > 1) contentRows.set(row, sorted.slice(1));
      continue;
    }

    // ── Table-sheet specific logic ──
    if (isTableSheet) {
      // Skip subtotal rows
      if (SUBTOTAL_RE.test(firstText) || allTexts.some(t => SUBTOTAL_RE.test(t))) {
        contentRows.set(row, sorted);
        continue;
      }

      // Category heading: bold number in col A + bold text in col B
      // e.g., A:[B]2 | B:[B]COBOL変換...
      if (sorted[0].isBold && /^[0-9０-９]+$/.test(firstText) && sorted.length >= 2 && sorted[1].isBold) {
        const catTitle = `${firstText}. ${String(sorted[1].value ?? '').trim()}`;
        headings.push({ cell: { ...sorted[0], value: catTitle }, depth: 1, prefix: normalizeNumber(firstText) });
        // Check if Step heading on same row (col C)
        if (sorted.length >= 3) {
          const cText = String(sorted[2].value ?? '').trim();
          const cStep = cText.match(STEP_RE);
          if (cStep && sorted[2].isBold) {
            const sn = cStep[1].replace(/\s+/g, '').match(/\d+/)?.[0] || '1';
            const sTitle = cStep[2].trim() ? `${cStep[1]}: ${cStep[2].trim()}` : cStep[1];
            headings.push({ cell: { ...sorted[2], value: sTitle }, depth: 2, prefix: `${normalizeNumber(firstText)}.step${sn}` });
          }
          if (sorted.length > 3) contentRows.set(row, sorted.slice(3));
        }
        continue;
      }

      // Bold-only row with few columns = section label heading
      // e.g., C:[B]FORM表示/印刷設定 (1-2 cols, bold)
      if (numCols <= 2 && sorted[0].isBold && firstText.length > 1 && firstText.length <= 80) {
        // Check for Step pattern in any cell
        let isStep = false;
        for (const c of sorted) {
          const t = String(c.value ?? '').trim();
          const sm = t.match(STEP_RE);
          if (sm) {
            const sn = sm[1].replace(/\s+/g, '').match(/\d+/)?.[0] || '1';
            const sTitle = sm[2].trim() ? `${sm[1]}: ${sm[2].trim()}` : sm[1];
            headings.push({ cell: { ...c, value: sTitle }, depth: 2, prefix: `step${sn}` });
            isStep = true;
            break;
          }
        }
        if (!isStep) {
          headings.push({ cell: sorted[0], depth: 3, prefix: null });
        }
        if (sorted.length > 1) contentRows.set(row, sorted.slice(1));
        continue;
      }

      // Wide data row → content
      contentRows.set(row, sorted);
      continue;
    }

    // ── Non-table sheet logic ──

    // Skip table rows entirely (they become content of preceding heading)
    if (tableRows.has(row)) {
      contentRows.set(row, sorted);
      continue;
    }

    // Check bold + in column A or B + not too long (section heading without numbering)
    if (sorted[0].isBold && sorted[0].col <= 2 && firstText.length <= 60) {
      let depth = 1;
      if (sorted[0].fontSize !== null && sorted[0].fontSize >= medianFontSize + 4) depth = 0;
      else if (sorted[0].fontSize !== null && sorted[0].fontSize >= medianFontSize + 2) depth = 1;
      else depth = 2;

      headings.push({ cell: sorted[0], depth, prefix: null });
      if (sorted.length > 1) contentRows.set(row, sorted.slice(1));
      continue;
    }

    // Not a heading → content
    contentRows.set(row, sorted);
  }

  return { headings, contentByRow: contentRows };
}

// ── Tree building ─────────────────────────────────────────────

function buildSheetTree(sheet: ParsedSheet, sheetName: string): MindmapNode[] {
  const { headings, contentByRow } = detectHeadingsAndContent(sheet);

  if (headings.length === 0) {
    // No headings: create flat content nodes (limit to meaningful ones)
    const items: MindmapNode[] = [];
    for (const [, cells] of contentByRow) {
      const text = cells.map(c => String(c.value)).join(' | ');
      if (text.trim()) {
        items.push({
          id: nextId(),
          title: truncate(text, 80),
          children: [],
          depth: 2,
        });
      }
    }
    return items.slice(0, 50); // cap
  }

  // Sort headings by row
  const sortedHeadings = [...headings].sort((a, b) => a.cell.row - b.cell.row);

  // Assign content rows to headings (each heading owns rows until next heading)
  const contentRowsSorted = [...contentByRow.keys()].sort((a, b) => a - b);

  interface Section {
    heading: HeadingInfo;
    contentTexts: string[];
    contentCells: ParsedCell[];
  }

  const sections: Section[] = [];
  for (let i = 0; i < sortedHeadings.length; i++) {
    const hRow = sortedHeadings[i].cell.row;
    const nextHRow = i + 1 < sortedHeadings.length ? sortedHeadings[i + 1].cell.row : Infinity;

    const texts: string[] = [];
    const cells: ParsedCell[] = [];
    for (const cr of contentRowsSorted) {
      if (cr > hRow && cr < nextHRow) {
        const rowCells = contentByRow.get(cr)!;
        cells.push(...rowCells);
        const text = rowCells
          .filter(c => c.value !== null && c.value !== '')
          .map(c => String(c.value))
          .join(' | ');
        if (text.trim()) texts.push(text);
      }
    }

    sections.push({ heading: sortedHeadings[i], contentTexts: texts, contentCells: cells });
  }

  // Build nodes with proper nesting using numbering prefix
  // NO deep child nodes - content is stored as summary/sourceData for DetailPanel
  const nodeMap = new Map<string, MindmapNode>(); // prefix -> node
  const topNodes: MindmapNode[] = [];

  // Track numbered-list restart context: when a sibling sequence (1., 2., 3.)
  // is followed by a *new* sibling sequence that restarts at "1.", the new
  // sequence is almost always a nested sub-list under the most recent heading
  // (e.g. "2. Test Batch" → 1./2./.../7. of その実施手順).
  // numberedListContext maps "depth-of-prefix" → { lastNum, parentNode }
  // parentNode is the parent under which the sequence is being attached.
  interface NumCtx { lastNum: number; parentNode: MindmapNode | null; }
  const numberedListContext = new Map<number, NumCtx>();
  let lastInsertedNode: MindmapNode | null = null;

  // Helper: extract last numeric segment of a dotted-numbering prefix ("5.1" → 1)
  const tailNumber = (prefix: string): number | null => {
    if (!/^[\d.]+$/.test(prefix)) return null;
    const parts = prefix.split('.').filter(Boolean);
    if (parts.length === 0) return null;
    const n = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(n) ? n : null;
  };

  for (const section of sections) {
    const h = section.heading;
    const title = truncate(String(h.cell.value), 80);

    // Build summary: first few lines of content
    let summary: string | undefined;
    if (section.contentTexts.length > 0) {
      const preview = section.contentTexts.slice(0, 3).map(t => truncate(t, 80)).join('\n');
      summary = section.contentTexts.length > 3
        ? `${preview}\n... (+${section.contentTexts.length - 3} more)`
        : preview;
    }

    const node: MindmapNode = {
      id: nextId(),
      title,
      summary,
      children: [], // children come only from sub-headings, not content
      sourceRange: `${sheetName}!${h.cell.ref}`,
      sourceData: section.contentCells.length > 0 ? section.contentCells : undefined,
      depth: h.depth + 1,
    };

    // 1) Try parent by numbering prefix (e.g., "5.1" → parent "5")
    if (h.prefix !== null) {
      nodeMap.set(h.prefix, node);
      const parentPrefix = findParentPrefix(h.prefix, nodeMap);
      if (parentPrefix !== null) {
        nodeMap.get(parentPrefix)!.children.push(node);
        lastInsertedNode = node;
        continue;
      }
    }

    // 2) Numbered-list restart detection: a top-level dotted prefix ("1", "2", …)
    //    that restarts at "1" after a previous numbered item at the same depth
    //    (with possibly a non-numbered heading like "実施方法" in between)
    //    means the list is a SUB-list of the most recent heading, not a sibling.
    const tail = h.prefix !== null ? tailNumber(h.prefix) : null;
    if (h.prefix !== null && tail !== null) {
      const ctx = numberedListContext.get(h.depth);
      if (ctx && tail === 1 && ctx.lastNum >= 1 && lastInsertedNode) {
        // List restart at "1." → sub-list under the most-recently-inserted node
        // (which may be a non-numbered intermediate heading like "実施方法").
        // Skip restart only when lastInsertedNode IS itself a same-depth sibling
        // of the prior numbered item — then "1." is genuinely a new top-level run.
        const newParent = lastInsertedNode;
        if (newParent !== ctx.parentNode) {
          newParent.children.push(node);
          numberedListContext.set(h.depth, { lastNum: tail, parentNode: newParent });
          lastInsertedNode = node;
          continue;
        }
      }
      if (ctx && tail > ctx.lastNum && ctx.parentNode) {
        // Continuation of the current sub-list → keep attaching to same parent.
        ctx.parentNode.children.push(node);
        ctx.lastNum = tail;
        lastInsertedNode = node;
        continue;
      }
      // Fresh sequence start — record tentative context (parent decided below).
      numberedListContext.set(h.depth, { lastNum: tail, parentNode: ctx?.parentNode ?? null });
    }
    // NOTE: deliberately do NOT clear context on non-numbered headings —
    // we need the {lastNum} memory so the next "1." can be detected as a restart.

    // 3) Try parent by depth (stack approach on topNodes)
    let inserted = false;
    const stack = flattenForStack(topNodes);
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].depth < node.depth) {
        stack[i].children.push(node);
        inserted = true;
        // If this is the start of a numbered sequence, remember the parent
        // so subsequent siblings attach here too.
        if (h.prefix !== null && tail !== null) {
          numberedListContext.set(h.depth, { lastNum: tail, parentNode: stack[i] });
        }
        break;
      }
    }
    if (!inserted) {
      topNodes.push(node);
      if (h.prefix !== null && tail !== null) {
        numberedListContext.set(h.depth, { lastNum: tail, parentNode: null });
      }
    }
    lastInsertedNode = node;
  }

  return topNodes;
}

/** Get a flat list of the rightmost path through the tree (for depth-based nesting) */
function flattenForStack(nodes: MindmapNode[]): MindmapNode[] {
  const result: MindmapNode[] = [];
  for (const n of nodes) {
    result.push(n);
    if (n.children.length > 0) {
      result.push(...flattenForStack([n.children[n.children.length - 1]]));
    }
  }
  return result;
}

function findParentPrefix(prefix: string, nodeMap: Map<string, MindmapNode>): string | null {
  const parts = prefix.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(0, i).join('.');
    if (nodeMap.has(candidate)) return candidate;
  }
  return null;
}

// ── Deduplication pass ────────────────────────────────────────

function normalizeTitle(t: string): string {
  // Strip numbering prefix for comparison
  const stripped = t.replace(/^[\s\u3000]*[０-９0-9]+(?:[.．][０-９0-9]+)*[.．]?\s*/, '');
  return stripped.replace(/[\s\u3000.．、,，:：]+/g, '').toLowerCase();
}

function deduplicateTree(node: MindmapNode): MindmapNode {
  node.children = node.children.map(c => deduplicateTree(c));

  const parentNorm = normalizeTitle(node.title);
  if (!parentNorm) return node; // skip if title is only numbering

  const filtered: MindmapNode[] = [];
  for (const child of node.children) {
    const childNorm = normalizeTitle(child.title);
    if (childNorm && (childNorm === parentNorm || parentNorm.includes(childNorm) || childNorm.includes(parentNorm))) {
      if (!node.summary && child.summary) node.summary = child.summary;
      filtered.push(...child.children);
    } else {
      filtered.push(child);
    }
  }
  node.children = filtered;

  return node;
}

// ── Depth reassignment pass ───────────────────────────────────

function reassignDepths(node: MindmapNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    reassignDepths(child, depth + 1);
  }
}

// ── Utility ───────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Build a mindmap tree using multi-signal scoring.
 */
export function buildTreeHeuristic(workbook: ParsedWorkbook): MindmapNode {
  nodeCounter = 0;
  const root: MindmapNode = {
    id: nextId(),
    title: workbook.fileName,
    summary: `Workbook with ${workbook.sheets.length} sheet(s)`,
    children: [],
    depth: 0,
  };

  for (const sheet of workbook.sheets) {
    const sheetChildren = buildSheetTree(sheet, sheet.name);

    const sheetNode: MindmapNode = {
      id: nextId(),
      title: sheet.name,
      summary: `${sheet.cells.length} cells`,
      children: sheetChildren,
      sourceRange: `${sheet.name}!A1`,
      depth: 1,
    };
    root.children.push(deduplicateTree(sheetNode));
  }

  reassignDepths(root, 0);
  return root;
}

/**
 * Build a heading-only mindmap subtree for a single sheet, optionally restricted
 * to rows that fall outside given table regions (so table areas can be inserted
 * separately as leaf nodes by the orchestrator).
 *
 * @param sheet            The parsed sheet
 * @param allowedRegions   If provided, only rows NOT covered by a region of
 *                          type === 'table' will be considered. Pass `undefined`
 *                          (or empty) to include the full sheet.
 */
export function buildHeadingTreeForSheet(
  sheet: ParsedSheet,
  allowedRegions?: Region[],
): MindmapNode[] {
  const tableRowSet = new Set<number>();
  if (allowedRegions && allowedRegions.length > 0) {
    for (const r of allowedRegions) {
      if (r.type !== 'table') continue;
      for (let row = r.startRow; row <= r.endRow; row++) tableRowSet.add(row);
    }
  }

  const filteredSheet: ParsedSheet =
    tableRowSet.size === 0
      ? sheet
      : {
          ...sheet,
          cells: sheet.cells.filter(c => !tableRowSet.has(c.row)),
        };

  const nodes = buildSheetTree(filteredSheet, sheet.name);
  // Tag heading nodes with kind so renderer knows.
  for (const n of nodes) tagHeadingKind(n);
  return nodes;
}

function tagHeadingKind(n: MindmapNode): void {
  if (!n.kind) n.kind = 'heading';
  for (const c of n.children) tagHeadingKind(c);
}

// Re-export internal id allocator so orchestrator can keep id namespace consistent
export function _resetNodeCounter(): void {
  nodeCounter = 0;
}
export function _nextNodeId(): string {
  return nextId();
}

/**
 * Build prompt for LLM-based structure detection.
 */
export function buildLLMPrompt(workbook: ParsedWorkbook): string {
  let content = `Analyze this Excel workbook and return a JSON mindmap tree structure.\n\n`;
  content += `Workbook: ${workbook.fileName}\n\n`;

  for (const sheet of workbook.sheets) {
    content += `## Sheet: ${sheet.name}\n`;
    const sortedCells = [...sheet.cells]
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .slice(0, 200);

    for (const cell of sortedCells) {
      if (cell.value === null || cell.value === '') continue;
      const bold = cell.isBold ? ' [BOLD]' : '';
      const merged = cell.isMerged ? ' [MERGED]' : '';
      const fs = cell.fontSize && cell.fontSize > 11 ? ` [FONT:${cell.fontSize}]` : '';
      content += `${cell.ref}: ${cell.value}${bold}${merged}${fs}\n`;
    }
    content += '\n';
  }

  content += `\nReturn JSON matching this TypeScript type:
{
  title: string;
  summary?: string;
  children: (same type recursively)[];
}

Identify the hierarchical structure: main topics, subtopics, and details.
Use numbering patterns (1., 1.1, 1.1.1), bold cells, font size, and position to determine hierarchy.
If a numbered item like "5.1" appears under "5.", it should be a child of "5.".
Deduplicate nodes where a child title repeats the parent title.
Return ONLY valid JSON, no markdown.`;

  return content;
}

/**
 * Parse LLM response into MindmapNode tree.
 */
export function parseLLMResponse(json: string, workbook: ParsedWorkbook): MindmapNode {
  nodeCounter = 0;
  try {
    const cleaned = json.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return assignIds(parsed, 0);
  } catch {
    return buildTreeHeuristic(workbook);
  }
}

function assignIds(node: any, depth: number): MindmapNode {
  return {
    id: nextId(),
    title: node.title || 'Untitled',
    summary: node.summary,
    children: (node.children || []).map((c: any) => assignIds(c, depth + 1)),
    sourceRange: node.sourceRange,
    depth,
  };
}
