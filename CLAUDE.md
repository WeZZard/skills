# CLAUDE.md

Add a new plugin to `.claude-plugin/marketplace.json` and merge it. The **Auto Register Plugin Website** workflow detects plugins absent from `catalog/website-registry.json` and opens a deterministic registration pull request through **Register Plugin Website**. Merging that pull request creates a `site-building:queued` issue. The site-building worker later opens a separate website-content pull request. To opt a plugin out, add its registry entry with `website: false` before merging. Manual dispatch (`gh workflow run register-plugin-website.yml -f plugin=<name>`) remains available for backfill.

Website TOML lives in `catalog/website/<plugin>.{plugin,skills,philosophy}.toml`. The catalog copy wins. A `website.*.toml` file inside the plugin repository is a legacy fallback that `scripts/update-plugin-website.mjs` migrates during site building. Pi generates missing skill entries from `SKILL.md` and persists them in the site-building pull request.

Machine-generated entries contain `source_hash`, which fingerprints their `SKILL.md`, and `content_hash`, which fingerprints their generated copy. An unchanged source produces no website change. A changed source regenerates a machine-owned entry through Pi. The worker preserves an entry whose current copy no longer matches `content_hash` because that mismatch identifies a human edit. Entries without hashes also count as human-edited. Delete an entry to let Pi regenerate it, or run `node scripts/adopt-plugin-content.mjs --plugin <name>` to mark its current copy as machine-owned without changing the copy.

The site-building worker uses Pi `0.81.1`, DeepSeek `deepseek-v4-pro`, and thinking level `high`. The worker loads only `.pi/skills/site-building/SKILL.md` and disables tools, sessions, global skills, extensions, prompt templates, and context files. GitHub Issues store durable tasks with `site-building:queued`, `site-building:running`, `site-building:failed`, and `site-building:blocked` labels. Every enqueue creates an immutable issue; the serialized worker deduplicates requests for the same plugin and recovers a stale `running` task after an interrupted run. Only issues carrying one of those status labels participate in the queue. The worker runs only outside DeepSeek peak pricing and the hour before each peak period. Preview and deployment workflows render committed content without invoking an agent.

Catalog merges complete plugin releases before site building starts. `catalog-sync-notify.yml` sends the existing release callback first, then enqueues website content when the plugin has website registration. Site-building failures therefore cannot hold a plugin release open.

## External plugins

All marketplace plugins are standalone repos pinned via **`github`** in `.claude-plugin/marketplace.json`. Catalog updates flow through `catalog-sync.yml` and `scripts/sync-plugin.mjs`.

| Plugin | Repo |
|--------|------|
| amplify | [WeZZard/amplify](https://github.com/WeZZard/amplify) |
| zelda-sounds | [WeZZard/zelda-sounds](https://github.com/WeZZard/zelda-sounds) |
| skill-kit | [WeZZard/skill-kit](https://github.com/WeZZard/skill-kit) |
| attune | [WeZZard/attune](https://github.com/WeZZard/attune) |
| cupertino-taste | [WeZZard/cupertino-taste](https://github.com/WeZZard/cupertino-taste) |

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
