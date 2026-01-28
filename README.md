# Claude Code Skill Marketplace

This repository is a standalone Claude Code plugin marketplace. Each "skill" is packaged as its own plugin.

## Quick start

From inside Claude Code:

1) Add this marketplace (local dev):

```
/plugin marketplace add ./
```

If you host on GitHub later:

```
/plugin marketplace add owner/repo
```

2) Install a skill plugin:

```
/plugin install example-skill@wezzard-skills
```

3) Run the skill:

```
/example-skill:plan-validation
```

## Repo layout

```
.claude-plugin/marketplace.json
plugins/<plugin-name>/.claude-plugin/plugin.json
plugins/<plugin-name>/skills/<skill-name>/SKILL.md
templates/skill-plugin/...
```

Notes:
- Only `plugin.json` lives inside `.claude-plugin/`. All other folders stay at the plugin root.
- Skills are namespaced as `/plugin-name:skill-name`.

## Add a new skill plugin

1) Copy the template:

```
cp -R templates/skill-plugin plugins/<plugin-name>
```

2) Update the plugin manifest:

- `plugins/<plugin-name>/.claude-plugin/plugin.json`

3) Update the skill definition:

- `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`

Frontmatter should include at least `name` and `description`. You can add `disable-model-invocation: true` to make it manual-only.

4) Add the plugin entry to the marketplace:

- `.claude-plugin/marketplace.json`

5) Test locally:

```
claude --plugin-dir ./plugins/<plugin-name>
```

## Distribution tips

- Relative plugin sources work when the marketplace is added via Git (local path or repo).
- If you distribute via a direct URL to `marketplace.json`, use Git or GitHub sources instead of relative paths.
- Plugins are copied to a cache on install, so do not reference files outside the plugin directory.
