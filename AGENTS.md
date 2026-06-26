# Plan Mode: Play the Plan-Ready Cue

When you are in plan mode and the plan is ready for the user's review, play the
`plan-ready` sound cue before handing the plan back. OpenCode emits no plan-mode
event to plugins, so the cue cannot fire on the event bus — instead, as the last
step of presenting a ready plan, run the bundled player exactly once:

```bash
node opencode/zelda-sounds/hooks/play-configured-sound.mjs plan-ready
```

(Path is relative to the repository root.) Run it only when the plan is ready —
not while the plan is still being drafted.
The player resolves the user's configured sound for the `plan-ready` moment
(falling back to its packaged default) and plays it.
