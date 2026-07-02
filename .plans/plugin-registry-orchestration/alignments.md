# Alignments

Decisions agreed in planning sessions. When implementation diverges, update this file first.

Last updated: 2026-07-02

---

## v1 decisions (implemented)

| Topic | v1 choice |
|-------|-----------|
| Scope | amplify extract + thin catalog orchestrator only |
| Callback | **None** — deferred to v2 |
| Semver in CI | Manual release PR bump only |
| Workflows repo | Inline `release.yml` in amplify; no `WeZZard/workflows` yet |
| Preview deploy | Staging on catalog PR via `preview-website.yml` |
| LLM website in CI | Deferred; TOML fast-path in `catalog-sync` |
| Hybrid marketplace | amplify = `github` pin (standalone); skill-kit + zelda = `./claude/*`; `git-subdir` for monorepo subpaths only |
| Rollback / register-website workflows | Deferred |

See [v1-scope.md](./v1-scope.md).

---

## Repo roles (target)

| Repo | Role |
|------|------|
| `WeZZard/skills` | Marketplace catalog, website factory, `catalog-sync` orchestrator |
| `WeZZard/amplify`, `skill-kit`, `zelda-sounds` | Standalone Claude plugins + `website.*.toml` |
| `WeZZard/workflows` | Shared semver prompt + `release-plugin.yml` (no shared README workflow) |
| `WeZZard/opencode-vision` | Standalone npm package; **out of** skills catalog |

---

## Release model

| Topic | Decision |
|-------|----------|
| Branch protection | `main` protected on all repos; changes via PR only |
| Version bumps | **Only** in dedicated release PRs — remove pre-commit auto-bump from plugin repos |
| Semver proposal | OpenCode + unified prompt in `workflows`, with `suggest-version.mjs` deterministic fallback |
| Human gate | Human accepts or overrides proposed version before release PR opens |
| Tag trigger | Merge release PR → tag `vX.Y.Z` → `repository_dispatch` to skills |
| Workflows pin | Consumers use `@v1.0.0` (tagged), **not** `@main` |

---

## Catalog sync (skills)

| Topic | Decision |
|-------|----------|
| Bot writes to `main`? | **No** — bot opens a PR; human merges after review |
| Staging | `preview-website.yml` on catalog PR → Cloudflare Pages preview; production on merge to `main` |
| `marketplace.json` | SSOT for plugin list and pins (updated in catalog PR) |
| `catalog/lock.json` | Generated resolved metadata (review noted possible redundancy with marketplace pins) |
| `catalog/website-registry.json` | Hand-edited; only registered plugins get website JSON/pages |
| New marketplace plugin | Pin + lock only until manually registered / `register-plugin-website` |
| Marketplace semver | Patch when pin changes; minor on add/remove/rename; major on breaking catalog contract |
| Concurrency | `catalog-sync-${{ plugin }}` per plugin |
| Validation before PR | Layer 1: `claude plugin validate .`; Layer 2: shallow-clone each pin at tag |

---

## Website content

| Topic | Decision |
|-------|----------|
| Unified prompt | Single [`website/prompts/update-plugin-website.md`](../../website/prompts/update-plugin-website.md) for bootstrap + release update |
| Fast path | TOML → JSON when skill hashes unchanged (skip LLM) |
| LLM path | When TOML stale or skills changed — **OpenCode** via `OPENCODE_AUTH_JSON` / local auth |
| README | Skills-local `prompts/readme-update.md` + deterministic `generate-readme.mjs` — **not** in workflows repo |
| TOML ownership post-split | TOML updated in **plugin release PR** before tag; catalog-sync fetches tag and generates JSON — **not** LLM patching TOML into skills-only PRs |

---

## Cross-repo chaining

| Topic | Decision |
|-------|----------|
| Preferred pattern | Callback `repository_dispatch` `catalog-sync-complete` from skills → plugin `release-complete.yml` |
| Avoid | Polling `gh run list` across repos; single job blocked on foreign workflow |
| Secrets | `SKILLS_DISPATCH_TOKEN` (plugin → skills); `PLUGIN_CALLBACK_TOKEN` (skills → plugins) |
| Callback timing | **Agreed gate:** fire on `pr_opened` (preview ready for review) — see open question below |
| Optional | Commit status on plugin tag SHA (`context: wezzard/catalog-sync`) with PR/preview URL |

### Open question (from independent review)

**Callback on `pr_opened` vs `merged`:** Current alignment fires callback when catalog PR opens, so plugin `release-complete` can succeed before catalog PR merges and pins go live. Review recommended gating “release success” on **catalog PR merged + install smoke test**. Resolve in Layer 2 (chain) before treating callback as production signal.

---

## Operational

| Topic | Decision |
|-------|----------|
| Rollback | `rollback-catalog.yml` + `gh workflow run` — opens repin PR, does not delete bad plugin tag |
| Workflows changes | `test-release-plugin.yml` dry-run on workflows repo changes |
| Zelda OpenCode | Drop OpenCode zelda dist from skills after extract (learning exercise only); zelda = Claude-only |
| Shared README in workflows | **Rejected** |

---

## Dropped / simplified

- Direct bot push + bypass token → replaced by bot PR model
- OpenCode zelda-sounds distribution in skills → removed with extract
- Shared README prompt in `WeZZard/workflows` → rejected

---

## Independent review (2026-07-01)

Grade **C+** — execute with changes, not full plan as-is.

| Issue | Mitigation / deferral |
|-------|----------------------|
| False success at `pr_opened` | Revisit callback gate in Layer 2; see open question above |
| TOML ownership post-split | Documented above; enforce in plugin release PR |
| Phase 1 vs in-tree `./claude/*` paths | Layer 1 skeleton uses in-tree paths; Layer 2 switches to `git-subdir` after amplify extract |
| LLM-in-CI vs local-only policy today | Defer LLM website sync to Layer 3; Layer 2 uses TOML fast-path only |
| Concurrent releases → PR conflicts | Per-plugin concurrency; conflicts visible in PR |
| `git-subdir` never smoke-tested | **Spike first** in Layer 1 skeleton: manual marketplace entry + `/plugin install` |

**Suggested v1 scope (inside same phased plan, not all phases at once):** thin orchestrator + amplify extract; defer callbacks, preview CI, workflows repo split, skill-kit/zelda until two successful end-to-end releases.

---

## Skeleton-first mapping

Agreed build order (see [execution.md](./execution.md)):

1. **Skeleton** — file trees, workflow YAML stubs, JSON schemas, placeholder scripts
2. **Chain** — dispatch → catalog PR → merge → deploy works deterministically (no LLM, optional no callback)
3. **Intelligence** — OpenCode semver, LLM website prompt, preview deploy, callbacks, full validation hardening
