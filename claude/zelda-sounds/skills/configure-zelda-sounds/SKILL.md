---
name: configure-zelda-sounds
description: Launch the Zelda Sounds configurator GUI to assign sound effects to Claude Code hook events
user_invocable: true
---

# Configure Zelda Sounds

Launch the Zelda Sounds configurator — a GUI that opens in your browser to let you assign sound effects to Claude Code events.

## What to do

First, rebuild the configurator bundle to ensure it's up to date:

```bash
cd "${CLAUDE_PLUGIN_ROOT}/configurator" && npm install --silent && npm run build --silent
```

Then run the configurator in the background with `PORT=0` so it picks a free port automatically:

```bash
PORT=0 node "${CLAUDE_PLUGIN_ROOT}/configurator.mjs"
```

The server prints `http://localhost:<port>` to stdout. Tell the user the URL so they can open it.

The configurator will:
1. Start a local web server on an available port
2. Open the default browser to the configurator UI
3. Let the user preview sounds, choose a configuration file path, and assign sounds to 9 semantic moments
4. Save user overrides to the chosen configuration file — changes take effect immediately, no reload needed
