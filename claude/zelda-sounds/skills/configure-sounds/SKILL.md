---
name: configure-sounds
description: Launch the Zelda Sounds configurator GUI to assign sound effects to Claude Code hook events
user_invocable: true
---

# Configure Sounds

Launch the Zelda Sounds configurator — a GUI that opens in your browser to let you assign sound effects to Claude Code events.

## What to do

Run the configurator:

```bash
node "${CLAUDE_PLUGIN_ROOT}/configurator.mjs"
```

The configurator will:
1. Start a local web server
2. Open your default browser to the configurator UI
3. Let you preview sounds and assign them to 9 semantic moments
4. Save the configuration to hooks.json

After saving, remind the user to run `/reload-plugins` to apply the new configuration.
