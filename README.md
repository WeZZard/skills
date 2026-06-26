# Claude Code Skill Marketplace

This repository is a standalone Claude Code plugin marketplace containing WeZZard skills collection.

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

2. Install plugins:

```bash
/plugin install amplify@wezzard-skills
```

3. Run a skill:

```bash
# wezzard plugin skills
/amplify:brainstorming
/amplify:write-plan
/amplify:execute-plan
```

## Available Plugins

### wezzard

Development workflow skills for planning and execution.

| Skill                 | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `brainstorming`       | Explore user intent, requirements and design before implementation |
| `write-plan`          | Create and update plan files with structured templates             |
| `execute-plan`        | Execute a plan file step by step                                   |
| `same-page`           | Explain previous message with adaptive layout, evidence, confidence, and ASCII art |

## Repo layout

```text
.claude-plugin/marketplace.json
claude/amplify/.claude-plugin/plugin.json
claude/<plugin-name>/skills/<skill-name>/SKILL.md
plugins/zelda-sounds/          ← canonical source for zelda-sounds
claude/zelda-sounds/           ← generated (Claude Code distribution)
opencode/zelda-sounds/         ← generated (OpenCode distribution)
```

Notes:

- Only `plugin.json` lives inside `.claude-plugin/`. All other folders stay at the plugin root.
- Skills are namespaced as `/<plugin-name>:<skill-name>`.
- **`zelda-sounds` is generated.** The canonical source is `plugins/zelda-sounds/`. Run `node build.mjs` from the repo root to regenerate both `claude/zelda-sounds/` and `opencode/zelda-sounds/`. Do not hand-edit those generated trees — the pre-commit hook and CI enforce freshness.

## Add a new skill

1. Create a new skill directory:

```bash
mkdir -p claude/<plugin-name>/skills/<skill-name>
```

2. Create the skill definition:

```text
claude/<plugin-name>/skills/<skill-name>/SKILL.md
```

Frontmatter should include at least `name` and `description`. You can add `disable-model-invocation: true` to make it manual-only.

3. Test locally:

```bash
claude --plugin-dir ./claude/<plugin-name>
```

## Distribution tips

- Relative plugin sources work when the marketplace is added via Git (local path or repo).
- If you distribute via a direct URL to `marketplace.json`, use Git or GitHub sources instead of relative paths.
- Plugins are copied to a cache on install, so do not reference files outside the plugin directory.

## Development setup

After cloning, run the setup script to enable automatic plugin version bumping:

```bash
sh scripts/setup.sh
```

This configures Git to use tracked hooks from `.githooks/`. When you commit changes to any plugin under `claude/`, the patch version in its `plugin.json` is automatically incremented. To set major or minor versions manually, edit `plugin.json` and stage it before committing — the hook respects manually staged version changes.

> **Note:** `claude/zelda-sounds/` and `opencode/zelda-sounds/` are generated from `plugins/zelda-sounds/` via `node build.mjs`. The pre-commit hook also checks that these trees are up to date; do not hand-edit them.

## Website

The `website/` directory contains a static site that showcases the skills with LLM-generated explanations.

### Setup

```bash
cd website
npm install
```

### Generate skill content

Requires `DEEPSEEK_API_KEY` environment variable:

```bash
export DEEPSEEK_API_KEY=your-api-key
npm run generate
```

This reads each `SKILL.md` and generates user-friendly descriptions with workflow diagrams. Generated content is cached in `src/content/generated/` - only regenerated when source changes.

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

Output goes to `website/dist/`.
