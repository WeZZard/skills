# README generation

Deterministic README sections for the skills marketplace catalog.

## Rules

- Installation commands derive from `.claude-plugin/marketplace.json` plugin list.
- Plugin detail sections use hand-maintained copy in `scripts/generate-readme.mjs` until v2 template extraction.
- After amplify extract, amplify content is sourced from `WeZZard/amplify`; in-tree plugins remain under `claude/`.

## Regeneration

```bash
node scripts/generate-readme.mjs
node scripts/generate-readme.mjs --dry-run
```
