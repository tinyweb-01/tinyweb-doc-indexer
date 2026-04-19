# Publishing guide

This monorepo publishes 5 npm packages under the `@tinyweb_dev` scope:

| Package | Purpose |
|---|---|
| `@tinyweb_dev/doc-indexer-core` | Pipeline + types + interfaces |
| `@tinyweb_dev/doc-indexer-excel` | Excel/xlsx adapter |
| `@tinyweb_dev/doc-indexer-pdf` | PDF adapter |
| `@tinyweb_dev/doc-indexer-llm-openai` | OpenAI provider |
| `@tinyweb_dev/doc-indexer-cli` | `doc-index` CLI binary |

Versions are kept in lock-step (see `fixed` group in `.changeset/config.json`).

---

## One-time setup (maintainers)

### 1. npm org & token

```bash
# create the @tinyweb_dev scope
npm login
npm org create tinyweb_dev          # only first time
```

Then create a **Granular Access Token** at https://www.npmjs.com/settings/<you>/tokens with:
- *Read and write* permission
- Scope limited to `@tinyweb_dev/*`

### 2. GitHub secrets

Go to **Settings → Secrets and variables → Actions** of the repo and add:

| Secret | Value |
|---|---|
| `NPM_TOKEN` | the granular token above |

`GITHUB_TOKEN` is provided automatically by Actions.

### 3. Repo settings

- **Settings → Actions → General → Workflow permissions**: pick *Read and write permissions* and tick *Allow GitHub Actions to create and approve pull requests* (Changesets needs this to open the "Version Packages" PR).
- **Settings → Branches**: keep `main` protected; the release workflow commits via PR (no force-push).

---

## Day-to-day workflow

1. Create a feature branch, make code changes.
2. **Add a changeset:**

   ```bash
   pnpm changeset
   ```

   Pick affected packages, bump type, and short description. Commit the generated `.changeset/<name>.md`.
3. Open a PR. CI runs:
   - matrix build/test on Node 20 & 22
   - `changeset status` ensures a changeset is included
4. Merge to `main`. The `release.yml` workflow will:
   - Open (or update) a **"Version Packages" PR** that bumps `package.json` versions and writes `CHANGELOG.md` files.
5. Merge that release PR. The same workflow re-runs and:
   - Builds all packages (`pnpm -r build`)
   - Runs `pnpm changeset publish` → publishes to npm with `--access public --provenance`
   - Creates GitHub Releases tagged per package

No manual `npm publish` is needed.

---

## Manual / emergency publish

If automation is down:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm changeset version           # apply pending changesets
git add -A && git commit -m "chore(release): version packages"
NPM_TOKEN=xxx pnpm changeset publish
git push --follow-tags
```

---

## Pre-release / canary

```bash
pnpm changeset pre enter next     # opens a 'next' pre-release window
pnpm changeset                    # add a changeset as usual
pnpm changeset version            # produces 0.2.0-next.0 etc.
pnpm changeset publish --tag next
pnpm changeset pre exit           # back to stable releases
```

---

## Verifying after publish

```bash
npx -y @tinyweb_dev/doc-indexer-cli@latest --help
```

The VS Code extension (`tinyweb-doc-indexer-cloud/vscode-extension`) resolves the CLI via this same npx spec.
