---
name: configure-zelda-sounds
description: Launch the Zelda Sounds configurator GUI to assign sound effects to OpenCode lifecycle events
---

# Configure Zelda Sounds

Launch the Zelda Sounds configurator — a GUI that opens in your browser to let
you assign sound effects to OpenCode lifecycle events. Choices are saved to the
shared cross-tool config at `~/.config/zelda-sounds.json`.

## What to do

This skill lives at `<dist>/skill/configure-zelda-sounds/SKILL.md`, where `<dist>` is
the `opencode/zelda-sounds/` distribution directory you installed. Run the
bundled configurator from that distribution root with `PORT=0` so it picks a
free port automatically:

```bash
PORT=0 node "<dist>/configurator.mjs"
```

Replace `<dist>` with the absolute path to your `opencode/zelda-sounds/`
directory (the same directory referenced by your `opencode.json` `"plugin"`
entry, minus the `plugin/zelda-sounds.ts` suffix).

The server prints `http://localhost:<port>` to stdout. Tell the user the URL so
they can open it.

The configurator will:
1. Start a local web server on an available port
2. Open the default browser to the configurator UI
3. Let the user preview sounds, choose a configuration file path, and assign
   sounds to 9 semantic moments
4. Save user overrides to `~/.config/zelda-sounds.json` — changes take effect
   immediately, no reload needed
