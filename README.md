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
/plugin install walkthrough@wezzard-skills
```

3. Run a skill:

```bash
# wezzard plugin skills
/amplify:brainstorming
/amplify:write-plan
/amplify:execute-plan
/amplify:recover-from-errors

# walkthrough plugin skills
/walkthrough:run
/walkthrough:analyze
/walkthrough:ada-doctor
```

## Available Plugins

### wezzard

Development workflow skills for planning and execution.

| Skill                 | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `brainstorming`       | Explore user intent, requirements and design before implementation |
| `write-plan`          | Create and update plan files with structured templates             |
| `execute-plan`        | Execute a plan file step by step                                   |
| `recover-from-errors` | Recover from errors during execution                               |

### walkthrough

Debugging skills that capture and analyze program execution with voice, screen, and trace correlation. **Automatically fetched from [GitHub Releases](https://github.com/WeZZard/Recall/releases)**.

| Skill        | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `run`        | Capture a debugging session with voice narration, screen recording, and tracing  |
| `analyze`    | Analyze captured sessions using voice-first intent extraction and evidence correlation |
| `ada-doctor` | Run system diagnostics to verify Walkthrough dependencies and configuration           |

## Repo layout

```text
.claude-plugin/marketplace.json
claude/amplify/.claude-plugin/plugin.json
claude/<plugin-name>/skills/<skill-name>/SKILL.md
```

Notes:

- Only `plugin.json` lives inside `.claude-plugin/`. All other folders stay at the plugin root.
- Skills are namespaced as `/<plugin-name>:<skill-name>`.
- The walkthrough plugin is fetched from GitHub Releases (not stored in this repo).

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
