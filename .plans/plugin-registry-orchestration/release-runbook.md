# v1 release runbook

Operational steps for the two end-to-end amplify release cycles that gate v2 work.

## Secrets

| Repo | Secret | Purpose |
|------|--------|---------|
| `WeZZard/amplify` | `SKILLS_DISPATCH_TOKEN` | PAT with `repo` scope to dispatch `sync-plugin` to skills |
| `WeZZard/skills` | (default `GITHUB_TOKEN`) | Bot PR creation in `catalog-sync.yml` |

Create `SKILLS_DISPATCH_TOKEN` as a fine-grained or classic PAT owned by a bot/user with access to both repos.

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
3. Review diff:
   - `.claude-plugin/marketplace.json` pin + marketplace patch bump
   - `catalog/lock.json`
   - `website/src/content/generated/**` for amplify
   - `README.md`
4. Merge PR → [`deploy-website.yml`](../../.github/workflows/deploy-website.yml) deploys production site.

### C. Verification

Run [smoke-test.md](./smoke-test.md) steps 3–4 after catalog PR merge.

### Recovery (dispatch failed)

```bash
gh workflow run catalog-sync.yml \
  --repo WeZZard/skills \
  -f plugin=amplify \
  -f tag=v1.2.61 \
  -f version=1.2.61 \
  -f repo=WeZZard/amplify
```

## v1 exit checklist

- [ ] Release cycle 1 complete (dispatch → catalog PR → merge → deploy → install smoke test)
- [ ] Release cycle 2 complete (same path)
- [ ] Website shows amplify content from generated JSON at pinned tag
- [ ] No callback workflow in v1 (plugin release succeeds on dispatch accept only)

## After v1 gate

Proceed to v2: `WeZZard/workflows` repo, callbacks, preview deploy, LLM website path, skill-kit extract.
