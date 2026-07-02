# Skeleton-first execution

Build order: **skeleton → chain → intelligence**.

See [README.md](./README.md) for current status.

---

## Layer 1 — Skeleton (done)

- [x] Remote pin spike (`github` for standalone plugins)
- [x] Skills orchestrator skeleton (`catalog/`, scripts, `catalog-sync.yml`)
- [x] Amplify plugin repo skeleton

---

## Layer 2 — Chain (done)

- [x] Release path: tag + `repository_dispatch` → catalog bot PR → merge → deploy
- [x] All plugins extracted (amplify, zelda-sounds, skill-kit); no in-tree `claude/`
- [x] `preview-website.yml` on catalog PRs
- [x] Smoke test passes for all three plugins

---

## Layer 3 — Intelligence (done)

- [x] `WeZZard/workflows` tagged `v1.0.0` — `release-plugin.yml`, `propose-release.yml`
- [x] Plugin consumers pin `@v1.0.0` (amplify, skill-kit, zelda-sounds)
- [x] `rollback-catalog.yml` on skills
- [x] `register-plugin-website.yml` on skills
- [x] Dual-status callbacks (`pr_opened` + `merged`) via `catalog-sync-notify.yml` + `release-complete.yml`
- [x] `suggest-version.mjs` + `propose-release.yml` on plugin repos
- [x] LLM path in `update-plugin-website.mjs` (JSON-only fallback; `DEEPSEEK_API_KEY` on skills)

### Human setup (Layer 3 secrets)

| Repo | Secret | Purpose |
|------|--------|---------|
| `WeZZard/skills` | `PLUGIN_CALLBACK_TOKEN` | Dispatch `catalog-sync-complete` to plugin repos |
| `WeZZard/skills` | `DEEPSEEK_API_KEY` | LLM website JSON fallback when TOML incomplete |

Plugin repos keep existing `*_RELEASE_TOKEN` secrets.

---

## Layer mapping to migration phases

| Phase | Status |
|-------|--------|
| Phase 0 (workflows repo) | Done |
| Phase 1 (orchestrator) | Done |
| Phase 2–5 (extract + finalize catalog) | Done |
