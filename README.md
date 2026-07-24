# WeZZard Skills

## Plugins

This repository ships Claude Code marketplace plugins. The plugins share a common focus on structured planning, reliable execution, and thoughtful polish in agent-assisted development.

## Installation

### Claude Code

Install the marketplace

```bash
/plugin marketplace add WeZZard/skills
```

Install the plugins

```bash
/plugin install amplify@wezzard-skills # Amplify
/plugin install zelda-sounds@wezzard-skills # Zelda-Sounds
/plugin install skill-kit@wezzard-skills # Skill-Kit
/plugin install attune@wezzard-skills # Attune
/plugin install dispatch@wezzard-skills # Dispatch
/plugin install cupertino-taste@wezzard-skills # Cupertino-Taste
/plugin install workflows@wezzard-skills # Workflows
```

## Claude Code Plugins

### Amplify

Development workflow skills for planning and execution.

| Skill | Description |
| ----- | ----------- |
| `brainstorming` | Explore ideas, approaches, and requirements before implementation |
| `write-plan` | Create and update plan files with structured templates |
| `execute-plan` | Execute a plan file step by step |
| `same-page` | Explain a previous message with adaptive layout, evidence, and confidence |
| `be-thorough` | Investigate deeply before concluding when debugging or reviewing uncertain claims |
| `divide-and-conquer` | Break large jobs into parallel subagent-driven DAG workflows |


### Zelda-sounds

Zelda BotW and TotK sound cues for Claude Code lifecycle events, with a GUI configurator. Run `/zelda-sounds:configure-zelda-sounds` to assign sounds to hook events.


### Skill-kit

Tools for auditing and improving Claude Code skill definitions. Run `/skill-kit:skill-lint --agent <agent> <path>` to lint skill files for structural and schema issues.


### attune

Inject your standing guidelines into every session: communication style, external agent routing, end-to-end verification

### dispatch

Delegate tasks to external agent CLIs through one router and one brief contract — probed facts before use, write isolation through worktrees, a multi-model audit panel, and concurrent image generation with failure memory.

### cupertino-taste

Distilled by WeZZard in China, Assembled from WWDC.

### workflows

Run shared WeZZard workflows from local coding agents without copying workflow infrastructure into each repository.

## License

MIT — see [LICENSE](LICENSE).
