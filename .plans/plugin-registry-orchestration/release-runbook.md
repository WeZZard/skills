# v1 release runbook

Operational steps for the two end-to-end amplify release cycles that gate v2 work.

## Secrets

| Repo | Secret | Purpose |
|------|--------|---------|
| `WeZZard/amplify` | `AMPLIFY_RELEASE_TOKEN` | PAT with **Contents: write** on `WeZZard/amplify` — push release tags and create GitHub Releases (`GITHUB_TOKEN` gets 403) |
| `WeZZard/amplify` | `SKILLS_DISPATCH_TOKEN` | PAT with access to dispatch `sync-plugin` on `WeZZard/skills` |
| `WeZZard/skills` | `CATALOG_SYNC_TOKEN` | PAT with **Contents** + **Pull requests** write on `WeZZard/skills` — opens catalog bot PRs |

A single **classic** PAT with `repo` scope can be copied to all three secrets. Fine-grained PATs must grant the scopes above on each repo separately — a skills-only token can dispatch but **cannot** push tags on amplify.

`GITHUB_TOKEN` is **not** used for PR creation: GitHub blocks it unless the repo enables [Allow GitHub Actions to create and approve pull requests](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests). A dedicated PAT avoids that setting (and org policy overrides).

### Create `CATALOG_SYNC_TOKEN`

**Classic PAT:** scope `repo` (or `public_repo` if the repo is public).

**Fine-grained PAT** on `WeZZard/skills`:

- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read

Set on skills:

```bash
gh secret set CATALOG_SYNC_TOKEN --repo WeZZard/skills --body 'ghp_...'
```

The same classic PAT can be used for `AMPLIFY_RELEASE_TOKEN`, `SKILLS_DISPATCH_TOKEN`, and `CATALOG_SYNC_TOKEN` if it has access to both repos.

### Pin shape (standalone vs monorepo)

| Plugin location | Marketplace `source` | Notes |
|-----------------|---------------------|-------|
| Whole repo is the plugin (`WeZZard/amplify`) | `github` with `repo`, `ref`, `sha` | Correct install — full tree including `skills/` |
| Plugin in monorepo subpath | `git-subdir` with `url`, `path`, `ref`, `sha` | Never use `path: "."` — sparse-checkout omits directories |

## Release cycle (repeat twice for v1 exit)

### A. Plugin release (`WeZZard/amplify`)

1. Open a release PR bumping `.claude-plugin/plugin.json` `version` (e.g. `1.2.60` → `1.2.61`).
2. Merge to `main`.
3. [`.github/workflows/release.yml`](https://github.com/WeZZard/amplify/blob/main/.github/workflows/release.yml) runs:
   - Creates tag `vX.Y.Z` and GitHub Release
   - Dispatches `sync-plugin` to `WeZZard/skills`

### B. Catalog sync (`WeZZard/skills`)

1. [`catalog-sync.yml`](../../.github/workflows/catalog-sync.yml) runs on dispatch (or manual recovery below).
2. Bot opens PR: `chore(catalog): sync amplify vX.Y.Z`
3. [`preview-website.yml`](../../.github/workflows/preview-website.yml) deploys to **https://pr-&lt;number&gt;.skills-website-staging.pages.dev** (one URL per open PR).
4. Review diff:
   - `.claude-plugin/marketplace.json` pin + marketplace patch bump
   - `catalog/lock.json`
   - `website/src/content/generated/**` for amplify
   - `README.md`
5. Merge PR → [`deploy-website.yml`](../../.github/workflows/deploy-website.yml) deploys **production** (https://skills.wezzard.com).

### C. Verification

Run [smoke-test.md](./smoke-test.md) steps 3–4 after catalog PR merge.

### Recovery (tag push or dispatch failed)

**Catalog sync only** (tag already exists):

```bash
gh workflow run catalog-sync.yml \
  --repo WeZZard/skills \
  -f plugin=amplify \
  -f tag=v1.2.62 \
  -f version=1.2.62 \
  -f repo=WeZZard/amplify
```

**Full release recovery** (validate passed but tag/dispatch failed):

```bash
gh workflow run release.yml \
  --repo WeZZard/amplify \
  -f tag=v1.2.62 \
  -f version=1.2.62
```

Requires `AMPLIFY_RELEASE_TOKEN` on amplify. Or manually: `git tag` → `gh release create` → dispatch as above.

## v1 exit checklist

- [x] Release cycle 1 complete (`v1.2.61` — manual tag/dispatch + `github` pin hotfix; smoke test passed)
- [x] Release cycle 2 complete (`v1.2.62` — catalog chain automated via `repository_dispatch`; tag push recovered manually pending `AMPLIFY_RELEASE_TOKEN`)
- [x] Website shows amplify content from generated JSON at pinned tag (`v1.2.62`)
- [x] No callback workflow in v1 (plugin release succeeds on dispatch accept only)

## After v1 gate

Proceed to v2: `WeZZard/workflows` repo, callbacks, preview deploy, LLM website path, skill-kit extract.
