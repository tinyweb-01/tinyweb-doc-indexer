// Vision Triage — sends Excel sheet image to Vision LLM for structure assessment
// Returns structured JSON describing complexity, structure type, and recommended extraction strategy

import type { LLMProvider } from '@tinyweb_dev/doc-indexer-core';

export interface SheetTriage {
  sheetType: 'hierarchical-table' | 'simple-list' | 'form-layout' | 'dashboard' | 'mixed' | 'unknown';
  complexity: 'low' | 'medium' | 'high';
  language: string;
  structure: {
    hasHeader: boolean;
    headerRowCount: number;
    hasCategories: boolean;
    categoryCount: number;
    hasSubtotals: boolean;
    hasMergedCells: boolean;
    estimatedColumns: number;
    estimatedRows: number;
  };
  description: string;
  recommendedStrategy: string;
}

const TRIAGE_PROMPT = `You are an Excel spreadsheet structure analyst. Look at this spreadsheet image and analyze its structure.

Return a JSON object with this exact schema (no markdown, just raw JSON):
{
  "sheetType": "hierarchical-table" | "simple-list" | "form-layout" | "dashboard" | "mixed" | "unknown",
  "complexity": "low" | "medium" | "high",
  "language": "<primary language code: vi, ja, en, zh, ko, etc>",
  "structure": {
    "hasHeader": true/false,
    "headerRowCount": <number>,
    "hasCategories": true/false,
    "categoryCount": <number>,
    "hasSubtotals": true/false,
    "hasMergedCells": true/false,
    "estimatedColumns": <number>,
    "estimatedRows": <number>
  },
  "description": "<1-2 sentence business description of what this spreadsheet contains>",
  "recommendedStrategy": "<one of: hierarchical-table-extraction, simple-list-extraction, form-extraction, dashboard-extraction, generic-extraction>"
}

Guidelines:
- "hierarchical-table": has numbered categories, subcategories, task rows, subtotals
- "simple-list": flat table with header + data rows, no hierarchy
- "form-layout": input form with labels and value cells, not tabular
- "dashboard": charts, KPIs, mixed layouts
- "mixed": multiple distinct regions or table types
- Assess complexity based on: merged cells, hierarchy depth, formula density, multi-language`;

export interface TriageOptions {
  /** LLM provider (must support vision/image messages). */
  llm: LLMProvider;
  model?: string;
}

/**
 * Send a sheet image to Vision LLM and get structured triage result.
 */
export async function triageSheetWithVision(
  pngBuffer: Buffer,
  options: TriageOptions,
): Promise<SheetTriage> {
  const { llm, model } = options;
  if (!llm) throw new Error('triageSheetWithVision: llm provider is required');

  const base64Image = pngBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64Image}`;

  const response = await llm.chat({
    model,
    maxTokens: 1000,
    temperature: 0,
    jsonSchema: { type: 'object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRIAGE_PROMPT },
          { type: 'image', url: dataUrl, detail: 'high' },
        ],
      },
    ],
  });

  const text = (response.content ?? '').trim();

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Vision LLM returned no valid JSON. Response: ${text.slice(0, 200)}`);
  }

  try {
    const triage = JSON.parse(jsonMatch[0]) as SheetTriage;
    return triage;
  } catch (e) {
    throw new Error(`Failed to parse Vision LLM JSON: ${(e as Error).message}. Raw: ${jsonMatch[0].slice(0, 200)}`);
  }
}
