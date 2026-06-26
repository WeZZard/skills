# Plan Mode: Play the Plan-Ready Cue

When you are in plan mode and the plan is ready for the user's review, play the
`plan-ready` sound cue before handing the plan back.

OpenCode emits no plan-mode event to plugins, so the cue cannot fire on the event
bus. Instead, as the last step of presenting a ready plan, run the bundled player:

```bash
node "<dist>/hooks/play-configured-sound.mjs" plan-ready
```

Replace `<dist>` with the absolute path to this distribution's root directory
(the `opencode/zelda-sounds/` directory that contains `plugin/`, `hooks/`,
`sounds/`, etc.). The player resolves the user's configured sound for the
`plan-ready` moment (falling back to its default) and plays it. Run it exactly
once, when the plan is ready — not while the plan is still being drafted.
