# @tinyweb_dev/doc-indexer-cli

## 0.0.2

### Patch Changes

- 0fc306a: fix(adapter-excel): move `tinyweb-office-cells` from `peerDependencies` to `dependencies`, and `puppeteer` to `optionalDependencies`.

  Previously when users installed `@tinyweb_dev/doc-indexer-cli` via `npx -y`, npm did not install peer deps, so the Excel adapter failed to register at runtime:

  ```
  excel adapter not available: Cannot find package 'tinyweb-office-cells'
  ✖  No adapter registered for source type "excel". Registered: [pdf]
  ```

  Now `tinyweb-office-cells` is pulled automatically. `puppeteer` (only required for `options.render = true`) is kept optional to avoid forcing a Chromium download on every install.

- Updated dependencies [0fc306a]
  - @tinyweb_dev/doc-indexer-core@0.0.2
  - @tinyweb_dev/doc-indexer-excel@0.0.2
  - @tinyweb_dev/doc-indexer-pdf@0.0.2
  - @tinyweb_dev/doc-indexer-llm-openai@0.0.2
