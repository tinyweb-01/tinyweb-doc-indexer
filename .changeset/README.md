# Changesets

Hi! We use [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs across this monorepo.

## Workflow

1. **Add a changeset** when you make user-facing changes to one or more packages:

   ```bash
   pnpm changeset
   ```

   Pick the affected packages, choose the bump type (`patch` / `minor` / `major`), and write a short description. A markdown file is created under `.changeset/`.

2. **Commit** the generated file alongside your code change in the same PR.

3. **Release** is fully automated by the `.github/workflows/release.yml` pipeline:

   - On every push to `main`, the `changesets/action` either
     - opens a "Version Packages" PR (when unreleased changesets exist), or
     - publishes to npm (when that PR is merged and changesets are consumed).

## Version policy

All five public packages are kept on the **same version** via the `fixed` group in [`config.json`](./config.json):

- `@tinyweb_dev/doc-indexer-core`
- `@tinyweb_dev/doc-indexer-excel`
- `@tinyweb_dev/doc-indexer-pdf`
- `@tinyweb_dev/doc-indexer-llm-openai`
- `@tinyweb_dev/doc-indexer-cli`

Any bump in one bumps all of them. This guarantees the CLI always works against a matched core/adapter set.

## Local dry-run

```bash
pnpm changeset version          # apply pending changesets locally
pnpm -r build
pnpm changeset publish --dry-run
```
