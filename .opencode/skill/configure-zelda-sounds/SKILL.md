---
name: configure-zelda-sounds
description: Launch the Zelda Sounds configurator GUI to assign sound effects to OpenCode lifecycle events
---

# Configure Zelda Sounds

Launch the Zelda Sounds configurator — a browser GUI to assign sound effects to
OpenCode lifecycle events. Choices are saved to the shared cross-tool config at
`~/.config/zelda-sounds.json`.

## What to do

Run the bundled configurator from this repository's root with `PORT=0` so it
picks a free port automatically (path is relative to the repo root):

```bash
PORT=0 node opencode/zelda-sounds/configurator.mjs
```

The server prints `http://localhost:<port>` to stdout — give the user that URL
to open. The configurator lets them preview sounds and assign them to the 9
semantic moments, saving overrides to `~/.config/zelda-sounds.json` (effective
immediately, no reload).
