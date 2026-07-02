# Release runbook

Operational steps for plugin releases, catalog sync, rollback, and recovery.

## Secrets

| Repo | Secret | Purpose |
|------|--------|---------|
| `WeZZard/amplify` | `AMPLIFY_RELEASE_TOKEN` | Tag push, GitHub Release, dispatch to skills, commit statuses |
| `WeZZard/zelda-sounds` | `ZELDA_SOUNDS_RELEASE_TOKEN` | Same for zelda-sounds |
| `WeZZard/skill-kit` | `SKILL_KIT_RELEASE_TOKEN` | Same for skill-kit |
| `WeZZard/skills` | `CATALOG_SYNC_TOKEN` | Opens catalog / rollback / register bot PRs |
| `WeZZard/skills` | `PLUGIN_CALLBACK_TOKEN` | Dispatches `catalog-sync-complete` to plugin repos |
| `WeZZard/skills` | `OPENCODE_AUTH_JSON` | OpenCode provider auth for website LLM fallback + semver (optional) |

Classic **`repo`** PAT is recommended for release and catalog tokens.

Set callback token on skills:

```bash
gh secret set PLUGIN_CALLBACK_TOKEN --repo WeZZard/skills --body 'ghp_...'
```

Set OpenCode auth for CI (contents of `~/.local/share/opencode/auth.json`):

```bash
gh secret set OPENCODE_AUTH_JSON --repo WeZZard/skills --body "$(cat ~/.local/share/opencode/auth.json)"
```

Repeat on plugin repos if using `propose-release.yml` with OpenCode semver.

## Shared release workflow

Plugin repos call [`WeZZard/workflows/.github/workflows/release-plugin.yml@v1.0.0`](https://github.com/WeZZard/workflows/blob/v1.0.0/.github/workflows/release-plugin.yml).

Pin policy: **always `@v1.0.0`** (or newer tagged release), never `@main`.

## Release cycle

### A. Propose release (optional)

```bash
gh workflow run propose-release.yml --repo WeZZard/amplify
```

Opens a release PR with a conventional-commit semver bump.

### B. Plugin release

1. Merge release PR (version bump in `plugin.json` or zelda `manifest.json`).
2. `release.yml` runs shared workflow → tag `vX.Y.Z` + GitHub Release + `sync-plugin` dispatch.

### C. Catalog sync (`WeZZard/skills`)

1. `catalog-sync.yml` opens bot PR.
2. `pr_opened` callback → plugin `release-complete.yml` posts **pending** status on tag SHA.
3. Preview: `https://pr-<number>.skills-website-staging.pages.dev`
4. Merge catalog PR → production deploy.
5. `catalog-sync-notify.yml` fires `merged` callback → plugin status **success**.

### D. Verification

Run [smoke-test.md](./smoke-test.md) after catalog PR merge.

## Recovery

**Catalog sync only** (tag already exists):

```bash
gh workflow run catalog-sync.yml \
  --repo WeZZard/skills \
  -f plugin=amplify \
  -f tag=v1.2.63 \
  -f version=1.2.63 \
  -f repo=WeZZard/amplify
```

**Full release recovery**:

```bash
gh workflow run release.yml \
  --repo WeZZard/amplify \
  -f tag=v1.2.63 \
  -f version=1.2.63
```

**Rollback catalog pin** (does not delete plugin tag):

```bash
gh workflow run rollback-catalog.yml \
  --repo WeZZard/skills \
  -f plugin=amplify \
  -f tag=v1.2.62
```

**Register plugin for website** (no pin change):

```bash
gh workflow run register-plugin-website.yml \
  --repo WeZZard/skills \
  -f plugin=my-plugin \
  -f repo=WeZZard/my-plugin
```

## Pin shape

| Plugin location | Marketplace `source` |
|-----------------|------------------------|
| Standalone repo | `github` with `repo`, `ref`, `sha` |
| Monorepo subpath | `git-subdir` with `url`, `path`, `ref`, `sha` |

Never use `git-subdir` + `path: "."` for standalone repos.
