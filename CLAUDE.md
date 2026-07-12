# CLAUDE.md

When adding a new plugin, add it to `.claude-plugin/marketplace.json`, then dispatch the **Register Plugin Website** workflow (`gh workflow run register-plugin-website.yml -f plugin=<name>`) if it should have website pages — the workflow registers it in `catalog/website-registry.json`, generates its website TOML, and opens a PR with the artifacts.

Website TOML lives in `catalog/website/<plugin>.{plugin,skills}.toml` (human ruled) — the catalog copy wins; a `website.*.toml` inside the plugin repo is a legacy fallback that `scripts/update-plugin-website.mjs` migrates into the catalog on its next run. Skill entries missing from the TOML are generated from `SKILL.md` via the OpenCode LLM and persisted to the catalog, so the registration PR carries reviewable TOML.

## External plugins

All marketplace plugins are standalone repos pinned via **`github`** in `.claude-plugin/marketplace.json`. Catalog updates flow through `catalog-sync.yml` and `scripts/sync-plugin.mjs`.

| Plugin | Repo |
|--------|------|
| amplify | [WeZZard/amplify](https://github.com/WeZZard/amplify) |
| zelda-sounds | [WeZZard/zelda-sounds](https://github.com/WeZZard/zelda-sounds) |
| skill-kit | [WeZZard/skill-kit](https://github.com/WeZZard/skill-kit) |
| attune | [WeZZard/attune](https://github.com/WeZZard/attune) |

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
