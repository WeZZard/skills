# Update plugin website content

Unified prompt for bootstrap and release updates.

## Inputs

- Fetched plugin tree at pinned tag (or local path during transition)
- `website.plugin.toml`, `website.skills.toml`
- Existing generated JSON under `website/src/content/generated/`
- Published skill list and hashes, discovered only from plugin-root
  `skills/<name>/SKILL.md` files

## Outputs

- `website/src/content/generated/plugins/<name>.json`
- `website/src/content/generated/skills/<skill>.json`
- TOML patches when the published skill set changes

The script removes entries and plugin-owned generated JSON for skills that are
no longer present at the plugin root. It ignores `.agents/skills/`, which holds
repository-only skills. Pi receives one already-discovered published skill and
does not classify publication.

## Fast path (CI default)

When TOML entries exist with `display_name`, regenerate JSON deterministically from TOML.

## Pi path

The site-building queue invokes `update-plugin-website.mjs` after a catalog,
registration, or rollback pull request merges. When TOML is missing or a
machine-owned entry is stale, the script invokes **Pi** with the repository's
`site-building` skill and this prompt to generate JSON only.

The queue uses `DEEPSEEK_API_KEY`, provider `deepseek`, model
`deepseek-v4-pro`, and thinking level `high`. Deployment and preview workflows
only consume committed content and never invoke Pi.

The site-building pull request owns generated TOML and JSON. Catalog sync does
not wait for this pull request before completing a plugin release.
