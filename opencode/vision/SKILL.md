---
name: vision
description: >-
  Use when you must verify, check, or evaluate what is visually rendered in
  one or more images — e.g. "visually verify the screenshot shows a centered
  button", "check the icon is visible", "does the layout match the design",
  acceptance criteria mentioning on-screen state. Captures visual-judgment
  intent from user prompts or MCP task outputs, classifies it into a typed
  judgment, asks the user once per session which vision model to use,
  assembles a versioned request, delegates to a vision subagent, and parses
  the typed report. Requires locally-stored image files (cua-driver
  screenshots, Playwright/chrome-devtools captures, user-provided paths).
---

# Vision — Visual Judgment Skill

You are a text-only orchestrator (GLM 5.2). You cannot see images. When a
task requires visual verification, you delegate to a vision subagent that
returns a typed report. This skill defines the extraction pipeline:
**Detect → Classify → Assemble → Pick model → Delegate → Parse**.

## Why this skill exists

You are text-only (`attachment: false`). You cannot verify visual properties
yourself — alignment, color, readability, layout. A vision subagent can.
This skill gives you a stable contract for talking to one.

## The two schemas

- **Request** (what you emit, passed as the `task` prompt):
  https://raw.githubusercontent.com/WeZZard/skills/main/opencode/vision/schemas/visual-judgment-request.v1.json
- **Report** (what the subagent returns):
  https://raw.githubusercontent.com/WeZZard/skills/main/opencode/vision/schemas/visual-judgment-report.v1.json

## Step 1. Detect

Visual-judgment intent arrives from two sources. Recognize both.

### Source A — explicit visual-judgment language in a user prompt

Trigger lexicon (any of these suggests visual judgment):
- "visually verify", "visually check", "screenshot shows"
- "looks right", "looks wrong", "looks broken"
- "centered", "aligned", "overlapping", "misaligned"
- "visible", "hidden", "not showing"
- "readable", "legible", "too small", "low contrast"
- "on" / "off" / "checked" / "disabled" (for a control's visual state)
- "matches the design", "matches the mockup"
- acceptance criteria mentioning on-screen state
- a user-provided image path (e.g. `/tmp/foo.png`)

If the user's request contains image-attachment references or a path to a
screenshot/screenshot file, that is also a trigger.

### Source B — a gap between an MCP task output and a visual criterion

A `browser-use-*` or `computer-use-cua` subagent returned a screenshot
path plus a text description of what is on screen. But the user's
criterion is visual (positional, color, readability, layout) and the text
description cannot fully prove it. You recognize the gap and extract a
visual-judgment intent from the combination of user criterion + MCP output.

**Example**: user says "log into the app and check the dashboard looks
right." You spawn `browser-use-chrome-devtools` to navigate + screenshot.
It returns `/tmp/dashboard.png` + "sidebar with nav items, bar chart,
welcome header." The text describes structure, but "looks right" is a
visual layout quality the text can't fully prove → you detect a
visual-judgment need.

## Step 2. Classify

Map the NL task to one of the 10 closed `judgment.type` values. Each has
typed `parameters`.

| Type | When to use | Typed parameters |
|---|---|---|
| `presence` | Is X visible on screen? | `subject`, `expectation: present\|absent` |
| `absence` | Is X NOT visible? (dual of presence) | `subject`, `expectation: absent` |
| `alignment` | Is X centered / left-aligned / top along an axis? | `subject`, `axis`, `expectation`, `tolerance` |
| `ordering` | Are items in expected left-to-right or top-to-bottom order? | `direction: ltr\|ttb`, `expected[]` |
| `equality` | Do two images render the same thing? | `subjects[2]`, `threshold: exact\|perceptual` |
| `layout` | Open-ended structural check (arrangement, spacing) | `expectations` (NL) |
| `readability` | Is text legible? (contrast, size) | `subject` |
| `state` | Is a control in a given state? (toggle, checkbox) | `subject`, `expectedState` |
| `diff` | What changed between two screenshots? | `baseline`, `current` (image labels) |
| `describe` | Open-ended description of what's on screen | `focus` |

Worked examples (one per type) are in the appendix at the bottom of this
file. When in doubt, pick the most specific type that fits; fall back to
`describe` if nothing fits.

## Step 3. Assemble

Construct the `visual-judgment-request.v1` JSON object.

### 3a. Gather image paths

Image paths come from:

| Source | How to get the path |
|---|---|
| User-provided | Use the path the user gave (e.g. `/tmp/foo.png`). |
| chrome-devtools MCP | `chrome-devtools_take_screenshot({ filePath: "/tmp/shot.png" })` — saves PNG to disk. |
| Playwright MCP | `playwright_browser_take_screenshot({ filename: "shot.png" })` — saves to the configured output directory. |
| cua-driver MCP | `cua-driver_get_window_state({ pid, window_id, screenshot_out_file: "/tmp/win.png" })` — saves window screenshot to disk. Also returns the AX tree as text. |
| Browser-use subagent output | The subagent returns the path in its text response; extract it. |

For each image, assign a `label` (short, used in `observations[].imageLabel`)
and a `role` (`baseline` = before/reference, `current` = the thing under
test, `reference` = design target).

### 3b. Dual-track: a11y tree vs. visual judgment

Before delegating, check whether the text tree already answers the
question. All three MCPs (chrome-devtools, Playwright, cua-driver) return
an accessibility/AX tree alongside the screenshot. You can read that text
directly — no vision call needed.

| Criterion | Source | Delegate to vision? |
|---|---|---|
| "Button exists" | a11y tree (element present) | No |
| "Button is enabled/disabled" | a11y tree (`AXEnabled`) | No |
| "Button text says 'Submit'" | a11y tree (`AXTitle`/`AXValue`) | No |
| "Button is centered" | Screenshot (positional) | **Yes** |
| "Text is readable" | Screenshot (contrast/size) | **Yes** |
| "Toggle is blue" | Screenshot (color) | **Yes** |
| "Layout matches design" | Screenshot (structural) | **Yes** |
| "Two screenshots are identical" | Screenshot pair | **Yes** |

Use the cheap text source first. Only pay for a vision call when the text
tree cannot answer.

### 3c. Fill typed parameters + NL criteria

Fill `judgment.parameters` per the type (Step 2 table). If the typed
parameters cannot fully express the nuance, add a free-form `criteria`
string as a fallback for the subagent. Also set `responseContract` if you
want something specific back beyond the fixed report envelope.

### 3d. Edge case — MCP output has no screenshot path

If a browser-use subagent returned only text (no path) but a visual
judgment is still needed, capture a screenshot yourself by driving the
MCP directly (see 3a table), or re-task the subagent with explicit
screenshot-save instructions.

### 3e. Edge case — built-in computer-use MCP

The built-in Claude Code `computer-use` MCP returns screenshots as inline
base64 images, not file paths. You cannot see inline images (you are
text-only), and the vision subagent needs a file path to `read`. Prefer
`cua-driver` for desktop visual judgments — it has `screenshot_out_file`.

## Step 4. Pick model (once per session)

opencode has no per-call model override and no LLM-set session variable.
The model choice is carried in your own context for the rest of the
session.

**On the first visual-judgment need in a session**, before delegating,
call the `question` tool once:

```
question({
  questions: [{
    header: "Vision model",
    question: "I found several models that support vision tasks. Which model would you prefer for visual judgments this session?",
    options: [
      { label: "openai/gpt-5.5", description: "Highest accuracy (Recommended)" },
      { label: "kimi-for-coding/k2p7", description: "Kimi K2.7 Code" },
      { label: "ollama-cloud/gemini-3-flash-preview", description: "Gemini 3 Flash, 1M context" },
      { label: "ollama-cloud/gemma4:31b", description: "Gemma 4 31B" },
      { label: "ollama-cloud/minimax-m3", description: "MiniMax M3" },
      { label: "ollama-cloud/qwen3.5:397b", description: "Qwen 3.5 397B" },
      { label: "opencode-go/kimi-k2.7-code", description: "Kimi K2.7 Code via opencode-go" },
      { label: "opencode-go/minimax-m3", description: "MiniMax M3 via opencode-go" },
      { label: "opencode-go/qwen3.7-plus", description: "Qwen 3.7 Plus, 1M context" },
      { label: "opencode-go/mimo-v2.5", description: "MiMo V2.5, 1M context" }
    ]
  }]
})
```

The tool auto-adds an "Other" option (type your own). After the user
answers:

- Map the answer to a `subagent_type` via the table below.
- Remember the choice for the rest of the session. Do not ask again.
  Reuse the chosen model for all subsequent visual judgments in this
  session.
- If the user picks "Other" and types a model id, map it to the closest
  matching `vision-*` subagent from the table, or fall back to
  `vision-openai-gpt-5.5` if no match.

### `preferredModel → subagent_type` mapping table

```
openai/gpt-5.5                       -> vision-openai-gpt-5.5
kimi-for-coding/k2p7                 -> vision-kimi-for-coding-k2p7
ollama-cloud/gemini-3-flash-preview  -> vision-ollama-cloud-gemini-3-flash-preview
ollama-cloud/gemma4:31b              -> vision-ollama-cloud-gemma4-31b
ollama-cloud/minimax-m3              -> vision-ollama-cloud-minimax-m3
ollama-cloud/qwen3.5:397b            -> vision-ollama-cloud-qwen3.5-397b
opencode-go/kimi-k2.7-code           -> vision-opencode-go-kimi-k2.7-code
opencode-go/minimax-m3               -> vision-opencode-go-minimax-m3
opencode-go/qwen3.7-plus             -> vision-opencode-go-qwen3.7-plus
opencode-go/mimo-v2.5                -> vision-opencode-go-mimo-v2.5
```

## Step 5. Delegate

Spawn the subagent with the assembled request JSON as the `prompt`:

```
task({
  subagent_type: "<mapped subagent_type>",
  description: "<short, e.g. 'Verify Submit button is centered'>",
  prompt: <the full visual-judgment-request.v1 JSON object>
})
```

## Step 6. Parse

The subagent returns a `visual-judgment-report.v1` JSON object. Branch on
`status` and `verdict`:

- `status: "ok"` + `verdict: "pass"` → criterion met. Report success to
  the user, citing `observations[]` as evidence.
- `status: "ok"` + `verdict: "fail"` → criterion not met. Report failure,
  citing the specific `observations[]` (e.g. "button is 42px right of
  center"). Include `reasoning`.
- `status: "ok"` + `verdict: "inconclusive"` → informational (for `diff`
  and `describe`) or genuinely undeterminable. Surface `observations[]`
  and `diff[]` directly to the user.
- `status: "error"` → the subagent could not analyze the image(s). Check
  `errors[]` (codes: `file_not_found`, `unsupported_format`,
  `model_unavailable`). If `model_unavailable`, retry with a different
  model from the mapping table, or re-ask the user.
- `status: "insufficient-evidence"` → the subagent analyzed the image but
  cannot reach a verdict. Report this honestly; do not pretend a verdict.

Surface `observations[]` as citations so the user sees what the subagent
actually saw. Include `confidence` in your report to the user.

## Two integration patterns

### Pattern 1 — Direct (simple "screenshot + judge")

Use when the browser/desktop interaction is trivial (just navigate and
look). You drive the MCP directly, capture one screenshot, delegate one
judgment.

```
You: chrome-devtools_navigate_page({ url: "http://localhost:3000" })
You: chrome-devtools_take_screenshot({ filePath: "/tmp/login.png" })
You: [assemble request with /tmp/login.png]
You: task({ subagent_type: "vision-openai-gpt-5.5", prompt: <request> })
```

### Pattern 2 — Two-phase (complex interaction, then judge)

Use when interaction is non-trivial (navigate, click, fill, navigate
again). You spawn a `browser-use-*` or `computer-use-cua` subagent to
perform the interaction and capture a screenshot. It returns the path.
You then delegate to a `vision-*` subagent.

```
You: task({
  subagent_type: "browser-use-chrome-devtools",
  prompt: "Navigate to /login, fill credentials, click Submit, wait for
           dashboard, take a screenshot to /tmp/dashboard.png. Return
           the file path and a brief text description."
})
  -> subagent returns: "/tmp/dashboard.png, sidebar + chart + header"
You: [assemble request with /tmp/dashboard.png, judgment.type=layout]
You: task({ subagent_type: "vision-openai-gpt-5.5", prompt: <request> })
```

Separation of concerns: the browser subagent knows how to drive; the
vision subagent knows how to see.

---

## Appendix — worked examples per judgment type

### presence — "is X visible?"
```json
{
  "$schema": "https://raw.githubusercontent.com/WeZZard/skills/main/opencode/vision/schemas/visual-judgment-request.v1.json",
  "id": "vj-001",
  "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/login.png", "label": "login-screen", "role": "current" }],
  "judgment": { "type": "presence", "parameters": { "subject": "Submit button", "expectation": "present" } },
  "criteria": "A clickable button labeled 'Submit' or equivalent, within the login form area.",
  "responseContract": "Return pass/fail and note the button's position if found."
}
```

### absence — "is X NOT visible?"
```json
{
  "id": "vj-002", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/post-logout.png", "label": "home", "role": "current" }],
  "judgment": { "type": "absence", "parameters": { "subject": "error banner", "expectation": "absent" } },
  "criteria": "No red/error banner at the top of the page or anywhere on screen."
}
```

### alignment — "is X centered on an axis?"
```json
{
  "id": "vj-003", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/header.png", "label": "header", "role": "current" }],
  "judgment": { "type": "alignment", "parameters": { "subject": "logo", "axis": "horizontal", "expectation": "centered", "tolerance": "loose" } },
  "criteria": "Logo should be roughly centered in the header band, allowing minor off-center within ~5%."
}
```

### ordering — "are items in expected LTR/TTB order?"
```json
{
  "id": "vj-004", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/nav.png", "label": "navbar", "role": "current" }],
  "judgment": { "type": "ordering", "parameters": { "direction": "ltr", "expected": ["Home", "Products", "About", "Contact"] } },
  "criteria": "Items read left-to-right in the specified order."
}
```

### equality — "do two images match?"
```json
{
  "id": "vj-005", "preferredModel": "openai/gpt-5.5",
  "images": [
    { "path": "/tmp/chart-v1.png", "label": "v1", "role": "baseline" },
    { "path": "/tmp/chart-v2.png", "label": "v2", "role": "current" }
  ],
  "judgment": { "type": "equality", "parameters": { "subjects": ["v1", "v2"], "threshold": "perceptual" } },
  "criteria": "Minor pixel-level anti-aliasing differences are acceptable; structural differences are not."
}
```

### layout — "does the structure match expectations?"
```json
{
  "id": "vj-006", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/form.png", "label": "signup-form", "role": "current" }],
  "judgment": { "type": "layout", "parameters": { "expectations": "Fields stacked vertically; equal vertical gaps; labels above inputs." } },
  "criteria": "Email, Password, Confirm Password fields in that top-to-bottom order."
}
```

### readability — "is the text legible?"
```json
{
  "id": "vj-007", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/page.png", "label": "page", "role": "current" }],
  "judgment": { "type": "readability", "parameters": { "subject": "footer text" } },
  "criteria": "Footer text should be readable at normal viewing distance; not blurry, not too small, sufficient contrast."
}
```

### state — "is the control in the expected state?"
```json
{
  "id": "vj-008", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/settings.png", "label": "settings-panel", "role": "current" }],
  "judgment": { "type": "state", "parameters": { "subject": "notifications toggle", "expectedState": "on" } },
  "criteria": "Toggle knob should be on the right side with the accent color (blue)."
}
```

### diff — "what changed between two screenshots?"
```json
{
  "id": "vj-009", "preferredModel": "openai/gpt-5.5",
  "images": [
    { "path": "/tmp/before.png", "label": "before", "role": "baseline" },
    { "path": "/tmp/after.png", "label": "after", "role": "current" }
  ],
  "judgment": { "type": "diff", "parameters": { "baseline": "before", "current": "after" } },
  "criteria": "Report all visual differences: added/removed/changed elements, color shifts, position changes."
}
```

### describe — "what's on screen?"
```json
{
  "id": "vj-010", "preferredModel": "openai/gpt-5.5",
  "images": [{ "path": "/tmp/screenshot.png", "label": "screen", "role": "current" }],
  "judgment": { "type": "describe", "parameters": { "focus": "overall layout and primary UI elements" } },
  "criteria": "Capture: app type, main regions, primary actions, color scheme."
}
```

For `diff` and `describe`, expect `verdict: "inconclusive"` — these are
informational, not pass/fail. Use `diff[]` and `observations[]` directly.