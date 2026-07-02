# Update plugin website content

Unified prompt for bootstrap and release updates.

## Inputs

- Fetched plugin tree at pinned tag (or local path during transition)
- `website.plugin.toml`, `website.skills.toml`
- Existing generated JSON under `website/src/content/generated/`
- `SKILL.md` file list and hashes

## Outputs

- `website/src/content/generated/plugins/<name>.json`
- `website/src/content/generated/skills/<skill>.json`
- TOML patches when skill set changes (plugin release PR only — not skills catalog PR)

## Fast path (CI default)

When TOML entries exist with `display_name`, regenerate JSON deterministically from TOML.

## OpenCode path (fallback)

When TOML is missing entries for a skill, `update-plugin-website.mjs` invokes **OpenCode**
(`opencode run`) with [`generate-skill-website-content.md`](generate-skill-website-content.md)
to generate **JSON only**.

Requires OpenCode CLI + provider auth locally, or `OPENCODE_AUTH_JSON` in CI.
Semver proposal uses the same OpenCode stack via `WeZZard/workflows`.

TOML remains owned by the plugin release PR — catalog sync does not patch plugin TOML.
