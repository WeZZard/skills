# Plugin registry orchestration

Planning set for splitting Claude plugins into standalone repos and turning `WeZZard/skills` into a marketplace catalog + website factory.

## Documents

| File | Purpose |
|------|---------|
| [v1-scope.md](./v1-scope.md) | v1 amplify milestone (complete) |
| [alignments.md](./alignments.md) | Long-term decisions (SSOT for “what we met on”) |
| [plan.md](./plan.md) | Full target architecture |
| [execution.md](./execution.md) | Skeleton-first build order |
| [smoke-test.md](./smoke-test.md) | `/plugin install` validation steps |
| [release-runbook.md](./release-runbook.md) | Release, rollback, and recovery operations |

## Status

| Milestone | State |
|-----------|-------|
| v1 amplify extract + catalog chain | Done |
| v2 extraction (zelda-sounds, skill-kit) | Done |
| Layer 3 — `WeZZard/workflows` `@v1.0.0` | Done |
| Layer 3 — rollback / register / callbacks | Done |
| Layer 3 — propose-release + LLM website CI | Done |

Production pins: amplify `v1.2.63`, zelda-sounds `v2.0.6`, skill-kit `v1.0.2`.

## Normal release flow

1. Optional: `propose-release.yml` on plugin repo (semver PR)
2. Merge release PR on plugin → `release.yml` (`WeZZard/workflows` `@v1.0.0`) tags + dispatches
3. Merge catalog bot PR on skills → production deploy
4. `/plugin marketplace update wezzard-skills`

## Related repos

- https://github.com/WeZZard/workflows — shared release workflows
- https://github.com/WeZZard/amplify
- https://github.com/WeZZard/zelda-sounds
- https://github.com/WeZZard/skill-kit
- [`opencode-vision`](https://github.com/WeZZard/opencode-vision) — extracted; not in skills catalog
