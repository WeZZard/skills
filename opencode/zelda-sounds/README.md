# Zelda Sounds for OpenCode

> GENERATED — edit the canonical source under `plugins/zelda-sounds/` and re-run
> `node build.mjs`. Do not hand-edit files in this directory.

Play Zelda BotW & TotK sound cues on OpenCode lifecycle events, with the same GUI
configurator the Claude Code plugin ships. This distribution is self-contained:
it bundles the sounds, the player, the configurator, and its assets.

## Install

### 1. Register the plugin

Add this distribution's plugin entry to your `opencode.json` (project or global,
e.g. `~/.config/opencode/opencode.json`). Replace the placeholder path below with
the absolute path to your local `opencode/zelda-sounds/` distribution directory
(also shown in `opencode.json.example` in this directory):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///ABSOLUTE/PATH/TO/opencode/zelda-sounds/plugin/zelda-sounds.ts"]
}
```

Replace `/ABSOLUTE/PATH/TO` with the real absolute path where you placed this
distribution (e.g. `/Users/yourname/path/to/opencode/zelda-sounds/plugin/zelda-sounds.ts`).

The plugin plays a cue on these events:

| OpenCode event   | Moment            |
|------------------|-------------------|
| `session.created` | `session-started` |
| `session.idle` (root session)  | `task-complete`   |
| `session.idle` (child/subagent) | `subagent-done`   |
| `question.asked` | `attention-needed` |
| `session.error`  | `error`           |
| `tui.toast.show` | `notification`    |

Root vs. child `session.idle` is disambiguated by the session's `parentID`
(resolved via the OpenCode client): a child/subagent session has a parent, the
root session does not.

### 2. Install the configurator skill

Copy the loose skill folder so OpenCode can discover it (OpenCode discovers
skills as `skill/<name>/SKILL.md`, so copy the whole `configure-zelda-sounds`
folder):

```bash
mkdir -p ~/.config/opencode/skill
cp -R skill/configure-zelda-sounds ~/.config/opencode/skill/
```

(You can also place it under a project's `.opencode/skill/` directory.) Then run
the `configure-zelda-sounds` skill to launch the GUI and assign sounds.

### 3. Enable the plan-ready cue (plan mode)

OpenCode emits no plan-mode event to plugins, so the `plan-ready` cue is
delivered by a plan-mode instruction. Append the contents of `AGENTS.md` (in
this directory) to your OpenCode `AGENTS.md` (project root or
`~/.config/opencode/AGENTS.md`) so the agent plays the cue when a plan is ready.

## Configuration

Sound choices are shared across Claude Code and OpenCode via
`~/.config/zelda-sounds.json`. Assign sounds with the configurator (step 2);
unset moments fall back to the packaged defaults in `config/defaults.json`.
