# CLAUDE.md

When adding a new plugin, add it to `.claude-plugin/marketplace.json` and merge — the **Auto Register Plugin Website** workflow detects marketplace plugins absent from `catalog/website-registry.json` and dispatches **Register Plugin Website** for each, which generates the website TOML via the repository's OpenCode agent and opens a PR with the artifacts. To opt a plugin out of website pages, add its registry entry with `website: false` before merging (presence in the registry means decided). Manual dispatch (`gh workflow run register-plugin-website.yml -f plugin=<name>`) remains for backfill.

Website TOML lives in `catalog/website/<plugin>.{plugin,skills,philosophy}.toml` (human ruled) — the catalog copy wins; a `website.*.toml` inside the plugin repo is a legacy fallback that `scripts/update-plugin-website.mjs` migrates into the catalog on its next run. Skill entries missing from the TOML are generated from `SKILL.md` via the repository's OpenCode agent and persisted to the catalog, so the registration PR carries reviewable TOML.

Machine-generated entries carry `source_hash` (the SKILL.md they derived from) and `content_hash` (their own generated content). On every sync: unchanged source → untouched entry and zero website diff (JSON writes are idempotent); drifted source on a machine-owned entry → regenerated via OpenCode, reviewed in the sync PR; an entry whose content no longer matches its `content_hash` was hand-edited and is preserved forever (a warning names it when its source drifts). Entries without hashes count as hand-edited; return one to machine ownership by deleting it (OpenCode regenerates from scratch) or by stamping its current content against the pin with `node scripts/adopt-plugin-content.mjs --plugin <name>` (content unchanged, drift tracking on). All four plugins' skill entries are adopted; plugin-level TOML for the legacy three stays hand-owned because their taglines are crafted brand copy, not the marketplace description.

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
