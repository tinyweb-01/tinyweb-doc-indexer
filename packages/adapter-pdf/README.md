# @tinyweb_dev/doc-indexer-pdf

PDF source adapter for [`@tinyweb_dev/doc-indexer`](../core).

MVP:
- Extracts text page-by-page via [`pdfjs-dist`](https://github.com/mozilla/pdfjs-dist) (legacy build, no DOM required).
- Emits **one `Chunk` per page** + a 2-level `TreeNode` skeleton (`document → pages[]`).
- Detects `application/pdf` by extension or sniff.

Roadmap (deferred):
- Heading detection from font-size statistics → multi-level outline tree.
- Page-image render to PNG via `pdfjs-dist` + `canvas` (asset emission).
- OCR fallback (`tesseract.js`) for scanned PDFs with no text layer.
- Vision-LLM triage for image-only PDFs.

## Usage

```ts
import { Indexer, FsStorage } from '@tinyweb_dev/doc-indexer-core';
import { PdfAdapter } from '@tinyweb_dev/doc-indexer-pdf';

const indexer = new Indexer({
  adapters: [new PdfAdapter()],
  storage: new FsStorage('./out'),
});
const doc = await indexer.index({ path: './sample.pdf' });
console.log(doc.stats);
```
