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

## LLM path (v2+)

When TOML is stale relative to new `SKILL.md` files, invoke DeepSeek with this prompt and commit results after human review.
