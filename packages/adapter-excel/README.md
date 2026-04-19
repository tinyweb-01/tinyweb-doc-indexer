# @tinyweb_dev/doc-indexer-excel

Excel adapter for `@tinyweb_dev/doc-indexer`.

> **Status:** Phase 0 scaffold. Full pipeline (region detection, structure detection, table tree builder, LLM enrichment) will be ported from `excel-knowledge-absorber/src/lib/**` in Phase 1.

Optional peer deps:
- `tinyweb-office-cells` — high-fidelity workbook reader (Aspose-backed). Required for production-quality output.
- `puppeteer` — needed when `options.render = true` (sheet/table snapshots).
