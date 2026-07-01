# CLAUDE.md

When adding a new plugin, remember to also add it to `.claude-plugin/marketplace.json` and `catalog/website-registry.json` if it should have website pages.

## Amplify — External Plugin (v1)

`amplify` is **not** in this repo. It lives at [WeZZard/amplify](https://github.com/WeZZard/amplify) and is pinned via `git-subdir` in `.claude-plugin/marketplace.json`. Catalog updates flow through `catalog-sync.yml` and `scripts/sync-plugin.mjs`.

## Catalog scripts

```bash
node scripts/resolve-plugin.mjs
node scripts/sync-plugin.mjs --plugin amplify --tag vX.Y.Z --version X.Y.Z --repo WeZZard/amplify
node scripts/update-plugin-website.mjs --plugin amplify
node scripts/generate-readme.mjs
node scripts/validate-pins.mjs
```

Planning docs: `.plans/plugin-registry-orchestration/`.

## Zelda Sounds — Generated Distribution

`zelda-sounds` is **GENERATED** — do not hand-edit files under `claude/zelda-sounds/` or `opencode/zelda-sounds/`. The canonical source is `plugins/zelda-sounds/`. To make changes:

1. Edit `plugins/zelda-sounds/` (source).
2. Run `node build.mjs` from the repo root to regenerate both distribution trees.

The pre-commit hook (`.githooks/pre-commit`) and CI workflow (`.github/workflows/check-generated-zelda.yml`) enforce that the generated trees stay in sync with the canonical source.
