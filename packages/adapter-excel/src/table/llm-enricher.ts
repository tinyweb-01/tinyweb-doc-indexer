// Table LLM Enricher — generates business-level description with strict token budget.
//
// Strategy for large sheets (token-efficient):
//   Tier 1 (≤ small): full skeleton + top-20 summaries + 5 sample rows.
//   Tier 2 (medium): top-level groups only (depth=1) + 3 sample rows.
//   Tier 3 (large):  only sheet-level skeleton (name, dims, totals, top categories) — NO samples.
//   Map-reduce (xl): per-page mini-summary → aggregate via second LLM call.
//
// Default hard cap: 1500 prompt tokens. Configurable via maxPromptTokens.
//
import type { LLMProvider } from '@tinyweb_dev/doc-indexer-core';
import type { TableIndex, ParsedSheet, SummaryChunk } from '../types';
import { classifyRows, RowType, type ClassifiedRow } from './row-classifier';

export interface EnrichOptions {
  enabled?: boolean;
  /** LLM provider (from ctx.llm). When omitted, enrichment is skipped. */
  llm?: LLMProvider;
  model?: string;
  maxTokens?: number;            // LLM completion cap, default 300
  maxPromptTokens?: number;      // Hard cap on prompt size, default 1500
  /** Force a specific tier (debug). 'auto' picks based on size. */
  tier?: 'auto' | 'full' | 'top-only' | 'skeleton' | 'map-reduce';
  /** When using map-reduce, max chars per group summary in pass 1. */
  mapChunkChars?: number;
}

const DEFAULT_OPTS: Required<Omit<EnrichOptions, 'llm'>> = {
  enabled: false,
  model: 'gpt-4o-mini',
  maxTokens: 300,
  maxPromptTokens: 1500,
  tier: 'auto',
  mapChunkChars: 400,
};

export interface EnrichResult {
  /** Business-level name in Vietnamese (e.g. "Bảng kế hoạch sản xuất Q1"). */
  name?: string;
  description?: string;
  sql_indexable_override?: boolean;
  sql_indexable_reason?: string;
  raw?: string;
  promptTokensApprox: number;
  tierUsed: string;
  llmCalls: number;
}

// ── Token estimate ─────────────────────────────────────────────

function approxTokens(s: string): number {
  // Rough heuristic: 1 token ≈ 3.5 chars for mixed VN/EN/Japanese.
  return Math.ceil(s.length / 3.5);
}

// ── Sample rows (used by Tier 1 only) ──────────────────────────

function pickSampleRows(classified: ClassifiedRow[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  const take = (pred: (r: ClassifiedRow) => boolean) => {
    for (const r of classified) {
      if (out.length >= limit) return;
      if (seen.has(r.rowNum)) continue;
      if (!pred(r)) continue;
      const cells = r.cells
        .filter(c => c.value != null && String(c.value).trim() !== '')
        .sort((a, b) => a.col - b.col)
        .map(c => `${c.col}:${String(c.value).slice(0, 30)}`)
        .join('|');
      out.push(`R${r.rowNum}|${r.type}|${cells}`);
      seen.add(r.rowNum);
    }
  };
  take(r => r.type === RowType.HEADER);
  take(r => r.type === RowType.CATEGORY);
  take(r => r.type === RowType.TASK);
  return out;
}

// ── Tier builders ──────────────────────────────────────────────

function topLevelGroups(summary: SummaryChunk[]): SummaryChunk[] {
  // A "top-level" group is one whose chunk_id has no underscore-suffix segment beyond the first.
  return summary.filter(s => /^group_\d+$/.test(s.chunk_id));
}

function buildSkeleton(index: TableIndex): string[] {
  const m = index.table_meta;
  const lines: string[] = [];
  lines.push(`Sheet: "${m.name}"  (${m.dimensions.rows}r × ${m.dimensions.cols}c)`);
  if (index.totals) lines.push(`Totals: ${JSON.stringify(index.totals)}`);
  const tops = topLevelGroups(index.summary_index ?? []);
  if (tops.length > 0) {
    lines.push(`Top-level groups (${tops.length}):`);
    for (const g of tops.slice(0, 12)) {
      lines.push(`  - ${g.path.slice(0, 80)}`);
    }
    if (tops.length > 12) lines.push(`  - ... (${tops.length - 12} more)`);
  }
  return lines;
}

function buildTier1Full(index: TableIndex, sheet: ParsedSheet): string[] {
  const lines = buildSkeleton(index);
  const summaries = (index.summary_index ?? []).slice(0, 20);
  if (summaries.length > 0) {
    lines.push('', 'Summary entries (truncated):');
    for (const s of summaries) {
      lines.push(`  [${s.chunk_id}] ${s.path.slice(0, 70)}` +
        (s.subtotal ? `  subtotal=${JSON.stringify(s.subtotal)}` : ''));
    }
  }
  const samples = pickSampleRows(classifyRows(sheet), 5);
  if (samples.length > 0) {
    lines.push('', 'Sample rows (R<row>|<type>|<col>:<val>):');
    for (const s of samples) lines.push(`  ${s}`);
  }
  return lines;
}

function buildTier2TopOnly(index: TableIndex, sheet: ParsedSheet): string[] {
  const lines = buildSkeleton(index);
  const tops = topLevelGroups(index.summary_index ?? []);
  if (tops.length > 0) {
    lines.push('', 'Top-level groups detail:');
    for (const g of tops) {
      lines.push(`  [${g.chunk_id}] ${g.path.slice(0, 80)}` +
        (g.subtotal ? `  subtotal=${JSON.stringify(g.subtotal)}` : '') +
        `  (${g.children_count} children)`);
    }
  }
  const samples = pickSampleRows(classifyRows(sheet), 3);
  if (samples.length > 0) {
    lines.push('', 'Sample rows:');
    for (const s of samples) lines.push(`  ${s}`);
  }
  return lines;
}

function buildTier3Skeleton(index: TableIndex): string[] {
  return buildSkeleton(index);
}

// ── Prompt assembly ────────────────────────────────────────────

function wrapPrompt(bodyLines: string[]): string {
  return [
    `You summarize a parsed Excel sheet for an AI agent index.`,
    `Goal: produce a BUSINESS NAME and BUSINESS DESCRIPTION for the table (in Vietnamese).`,
    `Do NOT describe technical structure (merged cells, row counts) — that is recorded separately.`,
    ``,
    ...bodyLines,
    ``,
    `Return STRICT JSON:`,
    `{`,
    `  "name": "tên nghiệp vụ ngắn gọn (3-8 từ tiếng Việt), KHÔNG dùng tên sheet kỹ thuật như Sheet1",`,
    `  "description": "1-2 câu tiếng Việt: bảng này nói về cái gì, dùng để làm gì",`,
    `  "sql_indexable_override": null | true | false,`,
    `  "sql_indexable_reason": "ngắn gọn nếu override, ngược lại null"`,
    `}`,
  ].join('\n');
}

interface TierResult { prompt: string; tier: string; tokens: number }

function pickTier(
  index: TableIndex,
  sheet: ParsedSheet,
  budget: number,
  forced: EnrichOptions['tier'],
): TierResult {
  const tryTier = (tier: string, body: string[]): TierResult => {
    const prompt = wrapPrompt(body);
    return { prompt, tier, tokens: approxTokens(prompt) };
  };

  const tiers: Array<() => TierResult> = [
    () => tryTier('full', buildTier1Full(index, sheet)),
    () => tryTier('top-only', buildTier2TopOnly(index, sheet)),
    () => tryTier('skeleton', buildTier3Skeleton(index)),
  ];

  if (forced && forced !== 'auto' && forced !== 'map-reduce') {
    const idx = ['full', 'top-only', 'skeleton'].indexOf(forced);
    if (idx >= 0) return tiers[idx]();
  }

  // Auto: pick smallest tier that fits, prefer richer first.
  for (const t of tiers) {
    const r = t();
    if (r.tokens <= budget) return r;
  }
  // Even skeleton too big? Truncate skeleton hard.
  const fallback = tryTier('skeleton', buildTier3Skeleton(index).slice(0, 8));
  return fallback;
}

// ── Map-reduce for XL sheets ───────────────────────────────────

async function mapReduce(
  index: TableIndex,
  sheet: ParsedSheet,
  opts: Required<Omit<EnrichOptions, 'llm'>>,
  llm: LLMProvider,
): Promise<{ result: EnrichResult; calls: number }> {
  const tops = topLevelGroups(index.summary_index ?? []);
  // Pass 1: ask LLM to summarize each top-level group in <=1 sentence.
  const miniSummaries: string[] = [];
  let calls = 0;
  for (const g of tops) {
    const body = [
      `Group: [${g.chunk_id}] ${g.path}`,
      g.subtotal ? `Subtotal: ${JSON.stringify(g.subtotal)}` : '',
      `Children: ${g.children_count}`,
      g.keywords.length ? `Keywords: ${g.keywords.join(', ')}` : '',
    ].filter(Boolean);
    const prompt = [
      `Tóm tắt nhóm này trong 1 câu tiếng Việt (<= ${opts.mapChunkChars} ký tự).`,
      `Chỉ trả về 1 câu, không JSON.`,
      ``,
      ...body,
    ].join('\n');
    const r = await llm.chat({
      model: opts.model,
      maxTokens: 80,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });
    calls++;
    const text = (r.content ?? '').trim().slice(0, opts.mapChunkChars);
    miniSummaries.push(`[${g.chunk_id}] ${text}`);
  }

  // Pass 2: aggregate.
  const m = index.table_meta;
  const aggBody = [
    `Sheet: "${m.name}" (${m.dimensions.rows}r × ${m.dimensions.cols}c)`,
    index.totals ? `Totals: ${JSON.stringify(index.totals)}` : '',
    ``,
    `Per-group mini-summaries:`,
    ...miniSummaries.map(s => `  - ${s}`),
  ].filter(Boolean);
  const prompt = wrapPrompt(aggBody);
  const tokens = approxTokens(prompt);
  const r = await llm.chat({
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: 0.2,
    jsonSchema: { type: 'object' },
    messages: [
      { role: 'system', content: 'You output strict JSON only.' },
      { role: 'user', content: prompt },
    ],
  });
  calls++;
  const content = r.content ?? '{}';
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch { /* */ }
  return {
    result: {
      name: typeof parsed.name === 'string' ? parsed.name.trim() : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      sql_indexable_override:
        parsed.sql_indexable_override === true || parsed.sql_indexable_override === false
          ? parsed.sql_indexable_override : undefined,
      sql_indexable_reason: typeof parsed.sql_indexable_reason === 'string' ? parsed.sql_indexable_reason : undefined,
      raw: content,
      promptTokensApprox: tokens,
      tierUsed: 'map-reduce',
      llmCalls: calls,
    },
    calls,
  };
}

// ── Main entrypoint ────────────────────────────────────────────

export async function enrichWithLLM(
  index: TableIndex,
  sheet: ParsedSheet,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const { llm, ...rest } = options;
  const opts = { ...DEFAULT_OPTS, ...rest };

  // Decide if XL sheet → map-reduce.
  const summaryCount = (index.summary_index ?? []).length;
  const useMapReduce =
    opts.tier === 'map-reduce' ||
    (opts.tier === 'auto' && summaryCount > 60);

  // Pick tier upfront for budget reporting (used when not map-reduce).
  const picked = pickTier(index, sheet, opts.maxPromptTokens, opts.tier);

  if (!opts.enabled || !llm) {
    return {
      promptTokensApprox: picked.tokens,
      tierUsed: useMapReduce ? 'map-reduce(skipped)' : `${picked.tier}(skipped)`,
      llmCalls: 0,
    };
  }

  if (useMapReduce) {
    const { result } = await mapReduce(index, sheet, opts, llm);
    return result;
  }

  if (picked.tokens > opts.maxPromptTokens) {
    return {
      promptTokensApprox: picked.tokens,
      tierUsed: `${picked.tier}(over-budget-skipped)`,
      raw: `SKIPPED: prompt ${picked.tokens} > ${opts.maxPromptTokens}`,
      llmCalls: 0,
    };
  }

  const resp = await llm.chat({
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: 0.2,
    jsonSchema: { type: 'object' },
    messages: [
      { role: 'system', content: 'You output strict JSON only.' },
      { role: 'user', content: picked.prompt },
    ],
  });
  const content = resp.content ?? '{}';
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch { /* */ }

  return {
    name: typeof parsed.name === 'string' ? parsed.name.trim() : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    sql_indexable_override:
      parsed.sql_indexable_override === true || parsed.sql_indexable_override === false
        ? parsed.sql_indexable_override : undefined,
    sql_indexable_reason: typeof parsed.sql_indexable_reason === 'string' ? parsed.sql_indexable_reason : undefined,
    raw: content,
    promptTokensApprox: picked.tokens,
    tierUsed: picked.tier,
    llmCalls: 1,
  };
}

/** Apply LLM result to an index, mutating table_meta. */
export function applyEnrichment(index: TableIndex, result: EnrichResult): TableIndex {
  if (result.name) {
    index.table_meta.name = result.name;
  }
  if (result.description) {
    index.table_meta.description = result.description;
  }
  if (result.sql_indexable_override !== undefined &&
      result.sql_indexable_override !== index.table_meta.sql_indexable) {
    index.table_meta.sql_indexable = result.sql_indexable_override;
    if (result.sql_indexable_reason) {
      index.table_meta.sql_indexable_reason =
        `LLM override: ${result.sql_indexable_reason}`;
    }
  }
  return index;
}
