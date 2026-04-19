# @tinyweb_dev/doc-indexer-core

Core types, pipeline orchestrator and pluggable interfaces for `@tinyweb_dev/doc-indexer`.

- `Indexer` — orchestrator (promise + streaming modes)
- `SourceAdapter` — interface to implement for new sources
- `LLMProvider`, `VisionProvider` — pluggable LLM
- `Storage` (`FsStorage` default) — pluggable asset/JSON sink
- `IndexedDocument`, `Chunk`, `TreeNode`, `IndexedEvent` — public types

See repository root README for usage.
