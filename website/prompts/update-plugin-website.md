# Update plugin website content

Unified prompt for bootstrap and release updates. **v1 uses TOML fast-path only in CI**; LLM generation remains local-only per `deploy-website.yml`.

## Inputs

- Fetched plugin tree at pinned tag (or local path during transition)
- `website.plugin.toml`, `website.skills.toml`
- Existing generated JSON under `website/src/content/generated/`
- `SKILL.md` file list and hashes

## Outputs

- `website/src/content/generated/plugins/<name>.json`
- `website/src/content/generated/skills/<skill>.json`
- TOML patches when skill set changes (plugin release PR only — not skills catalog PR)

## Fast path (v1 CI)

When TOML entries exist and skill hashes match committed JSON, skip regeneration.

When TOML changed or skills added/removed, regenerate JSON deterministically from TOML without LLM.

## LLM path (Layer 3 CI)

When TOML entries are incomplete at the pinned tag, `update-plugin-website.mjs` reads `SKILL.md`
and calls DeepSeek (`DEEPSEEK_API_KEY` on `WeZZard/skills`) to generate **JSON only**.

TOML remains owned by the plugin release PR — catalog sync does not patch plugin TOML.
