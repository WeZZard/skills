# Marketplace install smoke test

Validate `git-subdir` pins before and after catalog cutover.

## Prerequisites

- Claude Code CLI (`claude`) installed
- Marketplace uses amplify **`github`** pin to `WeZZard/amplify@v1.2.61` (standalone repos must not use `git-subdir` with `path: "."` — that sparse-checkout omits `skills/`)

## Steps

### 1. Validate marketplace manifest

From the skills repo root:

```bash
claude plugin validate .
```

Expect: validation passes (warnings for missing marketplace description are OK).

### 2. Validate remote pin

```bash
node scripts/validate-pins.mjs
```

Expect: `✓ amplify: WeZZard/amplify@v1.2.61 (plugin.json version 1.2.61)`.

### 3. Add marketplace in Claude Code

In a Claude Code session:

```text
/plugin marketplace add WeZZard/skills
```

### 4. Install amplify from git-subdir pin

```text
/plugin install amplify@wezzard-skills
```

Expect: install succeeds and skills load from the pinned tag (not local `./claude/amplify`).

### 5. Verify installed version

Check the installed plugin reports version `1.2.60` matching [WeZZard/amplify tag v1.2.60](https://github.com/WeZZard/amplify/releases/tag/v1.2.60).

## Failure modes

| Symptom | Check |
|---------|--------|
| Validate fails on git-subdir shape | `source.source`, `url`, `path`, `ref` fields in marketplace.json |
| Install cannot fetch tag | Tag exists on GitHub; repo is public |
| Wrong plugin content | `ref` and `sha` in marketplace match intended release |
| Stale marketplace | Catalog PR merged to `main`; local test uses updated pin |

## v1 release cycle smoke test

After each amplify release:

1. Merge release PR on `WeZZard/amplify` → tag created → `sync-plugin` dispatch
2. Merge catalog PR on `WeZZard/skills` → pin updated
3. Re-run steps 3–4 above against merged catalog
4. Confirm website deploy on `main` includes updated generated JSON

See [release-runbook.md](./release-runbook.md) for the full two-release gate.
