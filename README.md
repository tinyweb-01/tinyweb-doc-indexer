# @tinyweb_dev/doc-indexer

Universal document indexing library for building RAG pipelines.

Supports (planned): Excel, Google Sheet, PDF, Image, URL, Google Docs, DOCX, Markdown — produces normalized `IndexedDocument` (chunks + tree + assets) ready to be embedded.

## Packages

| Package | Description |
|---------|-------------|
| [`@tinyweb_dev/doc-indexer-core`](./packages/core) | Pipeline orchestrator, types, interfaces (`SourceAdapter`, `LLMProvider`, `Storage`). |
| [`@tinyweb_dev/doc-indexer-excel`](./packages/adapter-excel) | Excel & xlsx adapter (ported from `excel-knowledge-absorber`). |
| [`@tinyweb_dev/doc-indexer-llm-openai`](./packages/llm-openai) | OpenAI provider (chat + vision). |
| [`@tinyweb_dev/doc-indexer-cli`](./packages/cli) | `doc-index` CLI. |

## Quick start

```bash
pnpm install
pnpm build

# CLI
pnpm cli ./sample.xlsx --out ./out
```

## SDK

```ts
import { Indexer } from '@tinyweb_dev/doc-indexer-core';
import { ExcelAdapter } from '@tinyweb_dev/doc-indexer-excel';
import { OpenAIProvider } from '@tinyweb_dev/doc-indexer-llm-openai';

const indexer = new Indexer({
  adapters: [new ExcelAdapter()],
  llm: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' }),
});

const doc = await indexer.index({ path: './sample.xlsx' });
console.log(doc.chunks.length);
```

See [`plans/doc-indexer-library.md`](../excel-knowledge-absorber/plans/doc-indexer-library.md) for the full architecture plan.

## Status

🚧 Phase 0 — scaffolding. Not yet published.
