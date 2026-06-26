# CLAUDE.md

When adding a new plugin, remember to also add it to `.claude-plugin/marketplace.json`.

## Zelda Sounds — Generated Distribution

`zelda-sounds` is **GENERATED** — do not hand-edit files under `claude/zelda-sounds/` or `opencode/zelda-sounds/`. The canonical source is `plugins/zelda-sounds/`. To make changes:

1. Edit `plugins/zelda-sounds/` (source).
2. Run `node build.mjs` from the repo root to regenerate both distribution trees.

The pre-commit hook (`.githooks/pre-commit`) and CI workflow (`.github/workflows/check-generated-zelda.yml`) enforce that the generated trees stay in sync with the canonical source.
