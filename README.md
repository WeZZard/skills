# Claude Code Skill Marketplace

This repository is a standalone Claude Code plugin marketplace containing WeZZard's skills collection.

## Quick start

From inside Claude Code:

1. Add this marketplace (local dev):

```bash
/plugin marketplace add ./
```

If you host on GitHub later:

```bash
/plugin marketplace add WeZZard/skills
```

1. Install the plugin:

```bash
/plugin install wezzard@wezzard-skills
```

1. Run a skill:

```bash
/wezzard:brainstorming
/wezzard:update-plan
/wezzard:execute-plan
/wezzard:recover-from-errors
```

## Available Skills

| Skill                 | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `brainstorming`       | Explore user intent, requirements and design before implementation |
| `update-plan`         | Create and update plan files with structured templates             |
| `execute-plan`        | Execute a plan file step by step                                   |
| `recover-from-errors` | Recover from errors during execution                               |

## Repo layout

```text
.claude-plugin/marketplace.json
plugins/wezzard/.claude-plugin/plugin.json
plugins/wezzard/skills/<skill-name>/SKILL.md
```

Notes:

- Only `plugin.json` lives inside `.claude-plugin/`. All other folders stay at the plugin root.
- Skills are namespaced as `/wezzard:<skill-name>`.

## Add a new skill

1. Create a new skill directory:

```bash
mkdir -p plugins/wezzard/skills/<skill-name>
```

1. Create the skill definition:

```text
plugins/wezzard/skills/<skill-name>/SKILL.md
```

Frontmatter should include at least `name` and `description`. You can add `disable-model-invocation: true` to make it manual-only.

1. Test locally:

```bash
claude --plugin-dir ./plugins/wezzard
```

## Distribution tips

- Relative plugin sources work when the marketplace is added via Git (local path or repo).
- If you distribute via a direct URL to `marketplace.json`, use Git or GitHub sources instead of relative paths.
- Plugins are copied to a cache on install, so do not reference files outside the plugin directory.
