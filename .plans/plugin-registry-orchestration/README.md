# Plugin registry orchestration

Planning set for splitting Claude plugins into standalone repos and turning `WeZZard/skills` into a marketplace catalog + website factory.

## Documents

| File | Purpose |
|------|---------|
| [v1-scope.md](./v1-scope.md) | **Current milestone** — v1 amplify end-to-end |
| [alignments.md](./alignments.md) | Long-term decisions (SSOT for “what we met on”) |
| [plan.md](./plan.md) | Full target architecture (v2+) |
| [execution.md](./execution.md) | Skeleton-first build order |
| [smoke-test.md](./smoke-test.md) | `/plugin install` validation steps |
| [release-runbook.md](./release-runbook.md) | Two-release gate operations |

## v1 status

| Milestone | State |
|-----------|-------|
| README + LICENSE restructure | Done |
| opencode-vision extract | Done |
| v1 skeleton (catalog/, scripts, workflows) | Done |
| v1 chain (sync → bot PR → deploy path) | Done — two live release cycles complete |
| amplify extract + github pin cutover | Done (production pin `v1.2.62`) |
| v2 intelligence (callbacks, preview, workflows repo) | Not started |

## Next actions (human)

1. Set `AMPLIFY_RELEASE_TOKEN` + `SKILLS_DISPATCH_TOKEN` on `WeZZard/amplify` (see [release-runbook.md](./release-runbook.md))
2. Set `CATALOG_SYNC_TOKEN` on `WeZZard/skills`
3. Proceed to v2 per [v1-scope.md](./v1-scope.md)

## Execution preference

v1 = Layers 1–2 only (see [execution.md](./execution.md)):

1. **Skeleton** — repos, workflow files, schemas, stubs
2. **Chain** — dispatch → catalog PR → merge → deploy (deterministic)
3. **Intelligence** — v2+

## Related

- **Amplify repo:** https://github.com/WeZZard/amplify
- **Done:** [`opencode-vision`](https://github.com/WeZZard/opencode-vision) extracted; not in skills catalog
