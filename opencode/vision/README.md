# vision — Visual Judgment Skill for opencode

A typed visual-judgment contract for text-only orchestrators (GLM 5.2).
The orchestrator captures a screenshot via a browser/computer-use MCP,
extracts the visual-judgment intent, assembles a versioned request JSON,
delegates to a vision subagent, and parses a typed report.

## What it gives you

- **10 vision subagents** registered programmatically at init — one per
  top-tier vision model across OpenAI, Kimi for Coding, Ollama Cloud, and
  opencode-go.
- **A stable typed contract** — two versioned JSON Schemas
  (`visual-judgment-request.v1` / `visual-judgment-report.v1`) replace the
  old "design your own schema" free-for-all.
- **Per-session model selection** — the skill asks the user once which
  vision model to use, then reuses it for the rest of the session.
- **10 judgment types** — `presence`, `absence`, `alignment`, `ordering`,
  `equality`, `layout`, `readability`, `state`, `diff`, `describe`.
- **MCP integration** — works with chrome-devtools, Playwright, and
  cua-driver screenshots. Uses the a11y/AX tree when it answers the
  question; delegates to a vision subagent only when pixels matter.

## Install

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-vision"
  ],
  "skills": {
    "paths": [
      "~/.cache/opencode/packages/opencode-vision/node_modules/opencode-vision"
    ]
  }
}
```

opencode auto-installs the npm package via Bun on next launch — no separate
`npm install` step needed. The skill ships inside the package (in `SKILL.md`),
so point `skills.paths` at the installed package location so opencode's skill
loader can find it.

The old `~/.config/opencode/agents/visual-judge.md` subagent is removed —
this plugin replaces it with 10 typed `vision-*` subagents. Delete the old
file if present:

```bash
rm -f ~/.config/opencode/agents/visual-judge.md
```

Restart opencode for the config to take effect.

> **Why `skills.paths` points at the installed package:** opencode's plugin
> loader resolves the npm package to its `dist/index.js` entrypoint and
> runs the `config(cfg)` hook that registers the 10 subagents. But opencode's
> *skill* loader scans directories for `SKILL.md` — it does not look inside
> npm packages automatically. So we point `skills.paths` at the installed
> package directory, where `SKILL.md` ships as a published file. opencode
> caches npm plugins under `~/.cache/opencode/packages/<name>/node_modules/<name>/`
> (note the nested `node_modules`), not the flat
> `~/.cache/opencode/node_modules/<name>/` you might expect.

## Verify

```bash
opencode debug agent vision-openai-gpt-5.5
```

Should show the registered subagent with `model: openai/gpt-5.5`,
`mode: subagent`.

To list all 10:

```bash
opencode debug agent vision-openai-gpt-5.5
opencode debug agent vision-kimi-for-coding-k2p7
opencode debug agent vision-ollama-cloud-gemini-3-flash-preview
opencode debug agent vision-ollama-cloud-gemma4-31b
opencode debug agent vision-ollama-cloud-minimax-m3
opencode debug agent vision-ollama-cloud-qwen3.5-397b
opencode debug agent vision-opencode-go-kimi-k2.7-code
opencode debug agent vision-opencode-go-minimax-m3
opencode debug agent vision-opencode-go-qwen3.7-plus
opencode debug agent vision-opencode-go-mimo-v2.5
```

## Smoke test

Ask the orchestrator something visual:

> Visually verify the screenshot at /tmp/foo.png shows a centered button.

The orchestrator should:
1. Detect the visual-judgment intent.
2. Ask you (once) which vision model to use.
3. Assemble a `visual-judgment-request.v1` JSON with `judgment.type:
   alignment`.
4. Delegate to the chosen `vision-*` subagent.
5. Parse the report and tell you pass/fail with the button's position.

## File layout (source)

```
opencode/vision/                  # this sub-package, published as opencode-vision
  package.json                    # npm package metadata; main -> dist/index.js
  plugin.ts                        # source: registers 10 vision-* subagents via config(cfg)
  dist/                            # built on prepublishOnly (gitignored)
    index.js                       # built bundle — the package entrypoint
  vision-models.json              # 10-entry manifest (one top-tier per provider × family)
  subagent-body.md                 # shared subagent prompt template
  SKILL.md                         # intent-capture protocol + per-session question + MCP integration
  schemas/
    visual-judgment-request.v1.json
    visual-judgment-report.v1.json
  README.md                        # this file
```

## Build & publish (maintainers)

```bash
cd opencode/vision
bun run build                     # builds dist/index.js
npm publish                       # runs prepublishOnly -> build -> publish
```

The `files` field in `package.json` controls what ships: `dist/`,
`SKILL.md`, `schemas/`, `subagent-body.md`, `vision-models.json`,
`README.md`. No source `.ts` or `node_modules` leak.

## Catalog (10 models, 4 providers)

Curation rule: one top-tier model per provider × vendor family; drop
non-reasoning, drop superseded within a provider, drop coding-specialized,
drop Pro/billing variants of the same family; keep cross-provider
duplicates.

| Provider | Model | Family |
|---|---|---|
| openai | gpt-5.5 | GPT-5.5 |
| kimi-for-coding | k2p7 | Kimi K2.7 |
| ollama-cloud | gemini-3-flash-preview | Gemini |
| ollama-cloud | gemma4:31b | Gemma |
| ollama-cloud | minimax-m3 | MiniMax |
| ollama-cloud | qwen3.5:397b | Qwen 3.5 |
| opencode-go | kimi-k2.7-code | Kimi K2.7 (cross-provider route) |
| opencode-go | minimax-m3 | MiniMax (cross-provider route) |
| opencode-go | qwen3.7-plus | Qwen 3.7 |
| opencode-go | mimo-v2.5 | MiMo |

To add a model: add one line to `vision-models.json` and restart opencode.
The plugin re-reads the manifest at init.

## Schemas

Published via GitHub raw URLs (branch `main`):

- Request: `https://raw.githubusercontent.com/WeZZard/skills/main/opencode/vision/schemas/visual-judgment-request.v1.json`
- Report: `https://raw.githubusercontent.com/WeZZard/skills/main/opencode/vision/schemas/visual-judgment-report.v1.json`

The files also live in this repo under `opencode/vision/schemas/` for
editing. The URL is the canonical `$id`/`$schema` reference used by the
SKILL.md and subagent body.