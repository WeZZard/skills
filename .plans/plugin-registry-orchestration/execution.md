# Skeleton-first execution

Build order: **skeleton → chain → intelligence**. v1 completes Layers 1–2 only; Layer 3 is v2+.

See [v1-scope.md](./v1-scope.md) for current milestone.

---

## Layer 1 — Skeleton (v1 done)

Goal: every repo and file exists; workflows parse; scripts exit 0 with `--dry-run`.

### 1a. Spike — prove `git-subdir` works

- [x] `git-subdir` entry for amplify → `WeZZard/amplify@v1.2.60`
- [x] `claude plugin validate .`
- [x] [smoke-test.md](./smoke-test.md)

### 1b. Skills orchestrator skeleton

- [x] `catalog/website-registry.json`
- [x] `catalog/lock.json`
- [x] `scripts/resolve-plugin.mjs`, `sync-plugin.mjs`, `generate-readme.mjs`, `update-plugin-website.mjs`, `validate-pins.mjs`
- [x] `catalog-sync.yml` (dispatch + workflow_dispatch)
- [x] `website/prompts/update-plugin-website.md`
- [x] Marketplace `version` field

**Not in v1:** `preview-website.yml`, `rollback-catalog.yml`, `register-plugin-website.yml`

### 1c. Workflows repo skeleton

**Deferred to v2** — inline `release.yml` in amplify for v1.

### 1d. Plugin repo skeleton (amplify)

- [x] `WeZZard/amplify` from `claude/amplify/`
- [x] Inline `release.yml` (tag + dispatch)
- [x] No `release-complete.yml`

---

## Layer 2 — Chain (v1 implemented)

Goal: amplify release → skills catalog PR → merge → deploy, deterministic only.

### 2a. Release path (amplify)

- [x] Pre-commit excludes amplify in skills
- [x] Manual version bump in release PR
- [x] `release.yml`: tag + `repository_dispatch`
- [ ] `SKILLS_DISPATCH_TOKEN` secret on amplify (human setup)
- [ ] Two live release cycles — [release-runbook.md](./release-runbook.md)

### 2b. Catalog sync path (skills)

- [x] `sync-plugin.mjs` — fetch tag, patch marketplace + lock
- [x] `generate-readme.mjs`
- [x] `update-plugin-website.mjs` TOML fast-path
- [x] `catalog-sync.yml` bot PR + validation layers
- [x] `workflow_dispatch` recovery
- [x] `deploy-website.yml` path filters for catalog/generated JSON

### 2c. Callback

**v1: Option A (defer)** — no callback workflow.

### 2d. Rollback

**Deferred to v2.**

### Cutover

- [x] Marketplace `git-subdir` for amplify
- [x] Deleted `claude/amplify/` from skills

---

## Layer 3 — Intelligence (v2+)

- [ ] `WeZZard/workflows` tagged `v1.0.0`
- [ ] OpenCode / `suggest-version.mjs`
- [ ] `preview-website.yml`
- [ ] LLM path in `update-plugin-website.mjs`
- [ ] Callback policy (merged + smoke test)
- [ ] Extract skill-kit, zelda; finalize skills

---

## Layer mapping to migration phases

| Migration phase | v1 | v2+ |
|-----------------|----|-----|
| Phase 0 (workflows repo) | Skipped | Yes |
| Phase 1 (orchestrator) | Done | Harden |
| Phase 2 (amplify extract) | Done | — |
| Phase 3–5 | — | After two amplify releases |
