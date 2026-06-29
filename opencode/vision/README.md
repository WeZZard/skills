# vision - Dynamic Visual Response Skill for opencode

A prompt-authored visual response contract for text-only orchestrators
(GLM 5.2, DeepSeek, and similar models). The orchestrator captures or
receives images, extracts the visual intent, writes a
task-specific JSON response template directly in the spawning prompt,
delegates to a vision subagent, and parses the returned JSON.

## What it gives you

- **Dynamic vision subagents** registered programmatically at init - one
  per image-capable model in OpenCode's cached model catalog after
  applying the user-level and project-level provider config.
- **User-dropped image interception** - an
  `experimental.chat.messages.transform` hook catches images
  dropped into the chat, saves them to `/tmp/vision-<session>-<part>.<ext>`,
  and replaces the `FilePart` with a `[vision:dropped-image]` JSON marker
  carrying the image path. This gives the
  orchestrator a stable file path to hand to a vision subagent. See
  [Source D in SKILL.md](./SKILL.md#source-d---image-attached-to-a-user-message).
- **Dynamic response templates** - each visual task includes the exact
  JSON object shape the subagent should return. There are no fixed
  request/report schema files.
- **Script-backed model selection** - `scripts/vision-models.mjs`
  reads OpenCode's cached model catalog and OpenCode config files, then
  exposes the configured image-capable models, matching `vision-*`
  subagents, ranked picker shortlist, and persisted image choice.
- **MCP integration** - works with chrome-devtools, Playwright, and
  cua-driver screenshots. Uses the a11y/AX tree when it answers the
  question; delegates to a vision subagent only when pixels matter.

## Install

One command:

```bash
opencode plugin opencode-vision -g
```

opencode auto-installs the npm package via Bun on next launch. The
package's `postinstall` script copies `SKILL.md` into
`~/.config/opencode/skills/vision/` (where opencode's skill scan finds
it), and the plugin's `config(cfg)` hook registers `vision-*` subagents
for configured providers whose cached models support image input. Then
restart opencode.

The plugin intentionally does not ship a fixed model catalog. Configure
providers with `enabled_providers` and/or `provider` entries, and the
model script will intersect that provider set with OpenCode's cached
model catalog.

The old `~/.config/opencode/agents/visual-judge.md` subagent is removed;
this plugin replaces it with dynamically registered `vision-*` subagents.
Delete the old file if present:

```bash
rm -f ~/.config/opencode/agents/visual-judge.md
```

Restart opencode for the change to take effect.

> **How it works**: the plugin entry in `opencode.json` makes opencode
> load `dist/index.js` (the hooks + subagent registration). The npm
> `postinstall` script (`scripts/install-skill.mjs`) copies `SKILL.md`
> into opencode's default skill scan path so the orchestrator can load
> the workflow. Both happen from the single npm install — no separate
> skill-fetch command needed.

## Verify

```bash
node opencode/vision/scripts/vision-models.mjs
```

The script should return a capped `models[]` shortlist for user questions.
It discovers providers configured through OpenCode
config, saved OpenCode auth, or matching provider environment variables, then
keeps only active image-input/text-output models. It ranks by reasoning,
tool-call support, release date, context limit, and stable id; keeps only the
latest model in each provider/model series, such as GPT 5.5 over GPT 5.4;
keeps at most two models per provider; and caps the picker at six entries.
If it returns an empty list, connect a provider in OpenCode, export the
provider's API-key environment variable, or add `enabled_providers` /
`provider` entries to the relevant OpenCode config and restart opencode.

To inspect one registered subagent, use any returned `subagentType`:

```bash
opencode debug agent vision-openai-gpt-5.5
```

The exact agent name depends on your configured provider/model set.

## Smoke test

Ask the orchestrator something visual:

> Visually verify the screenshot at /tmp/foo.png shows a centered button.

The orchestrator should:

1. Detect the visual intent.
2. Run the model discovery script, then reuse the persisted choice or ask
   you to choose from the returned model list.
3. Build a visual task prompt that lists `/tmp/foo.png` under
   `Images to Inspect` and includes a centered-button JSON response
   template.
4. Delegate to the chosen `vision-*` subagent.
5. Parse the returned JSON and tell you the answer with visual evidence.

### Dropped-image smoke test

Drop an image file into the opencode chat, then send any message.

The vision plugin's `experimental.chat.messages.transform` hook should:

1. Save the dropped image to `/tmp/vision-<sessionID>-<partID>.<ext>`.
2. Replace the `FilePart` with a `TextPart` containing a
   `[vision:dropped-image]` marker and JSON payload:

   ```text
   [vision:dropped-image] {"mime":"image/png","path":"/tmp/vision-...png","originalFilename":"screenshot.png"}
   ```

The orchestrator should then:

3. Detect the Source D trigger.
4. Extract the user's visual intent, defaulting to a concise description
   when no specific visual criterion was given.
5. Run the model discovery script, then reuse the persisted image choice
   or ask you to choose from the returned model list.
6. Delegate to a `vision-*` subagent with a task-specific response
   template.
7. Relay the returned JSON fields and evidence back to you.

## File layout

```text
opencode/vision/                  # this sub-package, published as opencode-vision
  package.json                    # npm package metadata; main -> dist/index.js
  plugin.ts                       # source: registers dynamic vision-* subagents via config(cfg)
  dist/                           # built on prepublishOnly (gitignored)
    index.js                      # built bundle - package entrypoint
  scripts/
    vision-models.mjs             # model discovery + choice persistence
  subagent-body.md                # shared subagent prompt template
  SKILL.md                        # intent-capture protocol + response-template workflow
  README.md                       # this file

skills/vision/SKILL.md            # copied from opencode/vision/SKILL.md for skill discovery
```

## Build & publish

```bash
cd opencode/vision
bun run build                     # builds dist/index.js
bun run test                      # runs script CLI tests
npm publish                       # runs prepublishOnly -> build -> publish
```

The `files` field in `package.json` controls what ships: `dist/`,
`SKILL.md`, `scripts/`, `subagent-body.md`, and `README.md`. No source
`.ts` or `node_modules` leak.

## Model discovery script

The plugin ships `scripts/vision-models.mjs`. Run it with no arguments to
list the capped picker shortlist from OpenCode's cached model catalog after
applying configured providers from user-level and project-level OpenCode
config, saved OpenCode auth, and provider environment variables. Run it with
`--all` only when you need the full `allModels[]` list for diagnostics or
manual fuzzy matching.

- Cached models: `OPENCODE_MODELS_PATH`, or
  `~/.cache/opencode/models.json` by default.
- Config files: `OPENCODE_CONFIG_DIR`, global `~/.config/opencode`,
  `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, and project
  `opencode.json(c)` / `.opencode/opencode.json(c)` files.
- Saved auth: `OPENCODE_AUTH_CONTENT`, `OPENCODE_DATA_DIR`, or
  `~/.local/share/opencode/auth.json` by default.
- Provider env vars: provider-specific names advertised by the cached
  `models.json`, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- Provider filters: `enabled_providers`, `disabled_providers`,
  `provider`, provider `whitelist`, provider `blacklist`, and custom
  `provider.<id>.models`.

```json
{
  "ok": true,
  "saved": false,
  "persistedChoice": null,
  "selectedModel": null,
  "selectionRequired": true,
  "models": [
    {
      "model": "openai/gpt-5.5",
      "subagentType": "vision-openai-gpt-5.5",
      "pickerLabel": "openai/gpt-5.5",
      "pickerDescription": "GPT-5.5 - image"
    }
  ],
  "modelCount": 42,
  "choiceFile": "/Users/me/.config/opencode/vision-model-image.txt",
  "configuredProviders": ["openai"],
  "providerSelection": {
    "source": "enabled_providers",
    "explicitProviders": ["openai"],
    "envProviders": [],
    "authProviders": [],
    "enabledProviders": ["openai"],
    "disabledProviders": []
  },
  "warnings": []
}
```

After the user chooses, persist the image selection with `--model`:

```bash
node opencode/vision/scripts/vision-models.mjs --model openai/gpt-5.5
```

Exact `--model` validation uses the full discovered set internally, not only
the default picker shortlist. For fuzzy "Other" answers, run:

```bash
node opencode/vision/scripts/vision-models.mjs --all
```

The selection is stored at:

- `~/.config/opencode/vision-model-image.txt`

If `models[]` is empty, the script will return warnings explaining
whether the missing piece is the OpenCode cache or explicit provider
configuration.

## Dynamic response templates

The visual response contract is carried in the spawning prompt. A typical
prompt includes:

```md
Visual task:
Determine whether the primary Submit button is horizontally centered.

Images to inspect:
- current: /tmp/foo.png - screenshot under test

Response template:
Return exactly one JSON object shaped like this:
{
  "buttonFound": true,
  "isHorizontallyCentered": true,
  "centerOffsetPx": 0,
  "evidence": "short visual evidence",
  "uncertainty": null,
  "confidence": 0.0
}

Response rules:
- Use only the listed images.
- Match the response template exactly; no markdown, prose wrapper, or extra keys.
- Include evidence from the images for every conclusion.
- Use null when a requested measurement or fact cannot be determined.
```

The orchestrator should design a fresh response template for each visual
task instead of relying on a fixed global schema.
