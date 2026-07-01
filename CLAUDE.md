# CLAUDE.md

When adding a new plugin, remember to also add it to `.claude-plugin/marketplace.json` and `catalog/website-registry.json` if it should have website pages.

## External plugins

All marketplace plugins are standalone repos pinned via **`github`** in `.claude-plugin/marketplace.json`. Catalog updates flow through `catalog-sync.yml` and `scripts/sync-plugin.mjs`.

| Plugin | Repo |
|--------|------|
| amplify | [WeZZard/amplify](https://github.com/WeZZard/amplify) |
| zelda-sounds | [WeZZard/zelda-sounds](https://github.com/WeZZard/zelda-sounds) |
| skill-kit | [WeZZard/skill-kit](https://github.com/WeZZard/skill-kit) |

## Catalog scripts

```bash
node scripts/resolve-plugin.mjs
node scripts/sync-plugin.mjs --plugin amplify --tag vX.Y.Z --version X.Y.Z --repo WeZZard/amplify
node scripts/update-plugin-website.mjs --plugin amplify
node scripts/update-plugin-workflow.mjs --plugin amplify
node scripts/generate-readme.mjs
node scripts/validate-pins.mjs
```

Planning docs: `.plans/plugin-registry-orchestration/`.
