---
name: vision
description: >-
  You **MUST** use the vision skill when when the your model is text-only (e.g.
  glm-5.2, deepseek-v4-pro) AND:
  (1) the user's message contains images;
  (2) OR the user's message contains URLs or paths to images;
  (3) OR the user asks to visually verify/check something ("visually verify",
  "screenshot shows", "centered/visible/hidden", "looks right",
  "matches the design");
  (5) OR a tool result contains an image attachment the current model
  cannot see (attachments[].mime = "image/png",
  url = "data:image/png;base64,...");
  (4) OR you think it is necessary to READ any visual contents;
  Triggers on screenshots from chrome-devtools_take_screenshot,
  playwright_browser_take_screenshot,
  cua-driver_get_window_state/zoom/take_screenshot and cannot see images
  itself. Extracts the visual intent from context, designs a prompt-local JSON
  response template for that specific task, delegates, and parses the
  returned JSON.
---

# Vision

Delegates visual tasks to subagents with a vision-capable model.

## When NOT to invoke this skill

You **MUST NOT** delegate to a vision subagent if the model is vision-capable.

## Step 1. Detect

Visual intent arrives from four sources. Recognize all four.

**Source A - explicit visual language in a user prompt:**

Trigger lexicon:

<EXPLICIT_VISUAL_LANGUAGE_EXAMPLES>

- "visually verify", "visually check", "screenshot shows"
- "looks right", "looks wrong", "looks broken"
- "centered", "aligned", "overlapping", "misaligned"
- "visible", "hidden", "not showing"
- "readable", "legible", "too small", "low contrast"
- "on" / "off" / "checked" / "disabled" for a visual control state
- "matches the design", "matches the mockup"
- acceptance criteria mentioning on-screen visual state
- a user-provided image path, e.g. `/tmp/foo.png`

</EXPLICIT_VISUAL_LANGUAGE_EXAMPLES>

If the user's request contains image attachment references or a screenshot path, that is also a trigger.

**Source B - a gap between text output and a visual criterion:**

A browser or computer-use tool may return a screenshot path plus a text description of the screen. If the user's criterion is positional, color, readability, layout, or visual comparison, the text description cannot fully prove it. Extract the visual intent from the user criterion plus the tool output and delegate.

Example: the user says "check the dashboard looks right." A browser subagent returns `/tmp/dashboard.png` and "sidebar, chart, welcome header." The text describes structure, but "looks right" is a visual layout question, so delegate with a response template tailored to layout problems and evidence.

**Source C - image attachment in a tool result:**

When a tool result contains an `attachments[]` entry with `mime` starting `image/`, that image may be useful. Auto-invoke only when the user's current task has a visual component. If the task has no visual component, do nothing; note the image is available if needed later.

<TOOL_RESULTS_IMAGE_ATTACHMENT_EXAMPLES>

| Tool | Signal in result | File path available? |
| ---- | ---------------- | -------------------- |
| `chrome-devtools_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filePath` was passed |
| `playwright_browser_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filename` was passed |
| `cua-driver_get_window_state` | `screenshot` base64 plus `screenshot_file_path` if requested | Yes, if `screenshot_out_file` was passed |
| `cua-driver_zoom` | Cropped JPEG returned inline | No - save to disk first |
| `cua-driver_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filePath` was passed |

</TOOL_RESULTS_IMAGE_ATTACHMENT_EXAMPLES>

**Source D - image attached to a user message:**

When the user drops an image into the chat, the vision plugin's `experimental.chat.messages.transform` hook materializes it as a file on disk and surfaces the path to the orchestrator. For every user-message `FilePart` with `type: "file"` and `mime: "image/*"`, the hook:

1. Saves the bytes to `/tmp/vision-<sessionID>-<partID>.<ext>` via `writeFileSync` (data URLs) or `copyFileSync` (file paths). Image bytes never touch the shell.
2. Replaces the `FilePart` with text like:

   ```text
   [vision:dropped-image] {"mime":"image/png","path":"/tmp/vision-...png","originalFilename":"screenshot.png"}
   ```

When you see `[vision:dropped-image]`, parse the following JSON object and use `path` in the `Images to Inspect` section.
If the user gave no visual criterion beyond the image itself, ask for a concise description of the visible screen or object using a response template that includes `summary`, `notableItems`, `uncertainItems`, and `evidence`.

## Step 2. Extract visual intent

Convert the current user request and image context into a direct visual
task. Do not classify into a closed taxonomy. Capture:

- The exact visual question to answer.
- Which image IDs are needed and why.
- Whether the answer is a pass/fail check, a description, a comparison, a list of findings, a measurement, or a state read.
- What evidence the orchestrator needs to cite back to the user.
- What uncertainty or failure path is appropriate.

Before delegating, check whether the text tree already answers the question.
Browser and desktop MCPs often return an accessibility/AX tree alongside the screenshot.
Use that cheap text source first.

<VISUAL_INTENT_EXTRACTION_EXAMPLE>

| Criterion | Source | Delegate to vision? |
| --------- | ------ | ------------------- |
| "Button exists" | a11y tree element present | No |
| "Button is enabled/disabled" | a11y tree state | No |
| "Button text says Submit" | a11y tree title/value | No |
| "Button is centered" | Screenshot position | Yes |
| "Text is readable" | Screenshot contrast/size | Yes |
| "Toggle is blue" | Screenshot color | Yes |
| "Layout matches design" | Screenshot structure | Yes |
| "Two screenshots are visually different" | Screenshot pair | Yes |

</VISUAL_INTENT_EXTRACTION_EXAMPLE>

## Step 3. Gather image paths

Image paths come from:

<IMAGE_PATHS_SOURCES>

| Source | How to get the path |
| ------ | ------------------- |
| User-provided | Use the path the user gave, e.g. `/tmp/foo.png`. |
| User-dropped image | Parse the `[vision:dropped-image]` JSON and use its `path`. |
| chrome-devtools MCP | Use `chrome-devtools_take_screenshot({ filePath: "/tmp/shot.png" })`. |
| Playwright MCP | Use `playwright_browser_take_screenshot({ filename: "shot.png" })`. |
| cua-driver MCP | Use `cua-driver_get_window_state({ pid, window_id, screenshot_out_file: "/tmp/win.png" })`. |
| Browser-use subagent output | Extract the returned screenshot path from the subagent text. |

</IMAGE_PATHS_SOURCES>

You **MUST** assign each image a short contract ID such as `current`, `before`, `after`, `reference`, or `detail`. Use these IDs in the prompt and in the response template.

**Inline-only Image Attachments:**

Some tool results return `attachments[].url = "data:image/...;base64,"` but no file path.
The vision subagent needs a file path to read.
Save inline images to disk first.

Prefer avoiding inline images altogether: when calling screenshot tools, pass the file-path option where available.

If you must handle an inline-only image, write the base64 payload to a file using Node via stdin or a temporary script.
Do not embed the raw base64 payload in a shell command; screenshots may contain sensitive content that should not appear in shell history, transcripts, or logs.

## Step 4. Pick model when necessary

The user's image vision-model choice is persisted so it carries over to future sessions:

- Image choice: `~/.config/opencode/vision-model-image.txt`

At startup the vision plugin reads this file and, if it holds a known model id, appends `[vision:model-choice] model=<provider/model>` to the system prompt.

Before asking the user, check whether a model choice is already available:

- If the system prompt contains a `[vision:model-choice]` line, use the matching model id and delegate to the matching `vision-*` subagent.
- If the system prompt contains a `[vision:model-script]` line, extract the script command from it and run that command without extra flags. It returns a capped `models[]` shortlist, matching `vision-*` subagent names, counts for the full discovered set, and any persisted choice discovered at runtime.
- If there is no `[vision:model-script]` line but you are working in this repository, run `node opencode/vision/scripts/vision-models.mjs` from the repository root.
- If the script returns `models: []`, do not invent or hardcode a fallback model. Report that no configured OpenCode provider currently exposes an image-capable model, include the script warnings, and ask the user to connect a provider in OpenCode, set the provider's API-key environment variable, or configure `enabled_providers` / `provider`.
- If the script returns a persisted choice, use it directly.
- If no persisted choice exists, ask the user to choose from the capped `models[]` returned by the script. Do not delegate to a `vision-*` subagent until the user has selected a model. Do not treat the first ranked model as an implicit default. Do not ask from a large full model list. Do not use a hardcoded model list.

<MODEL_PICKER_EXAMPLE>

```sh
node /path/to/opencode-vision/scripts/vision-models.mjs
```

Use the returned capped `models[]` to build the picker:

```js
const choices = available.models
question({
  questions: [{
    header: "Vision model",
    question: "I found several models that support vision tasks. Which model would you prefer for visual judgments this session?",
    options: choices.map((model) => ({
      label: model.pickerLabel,
      description: model.pickerDescription
    }))
  }]
})
```

The script builds `models[]` by applying this picker algorithm:

- Keep only active models that support image input and text output.
- Rank by reasoning support, tool-call support, newer release date, larger context limit, then stable model id.
- Keep only the latest model in each provider/model series before applying the picker cap. For example, GPT 5.5 supersedes GPT 5.4, and Kimi K2.7 supersedes Kimi K2.5.
- Keep at most two models per provider and at most six picker entries total.
- Include a valid persisted choice as `Saved choice` if present.

The full discovered list is not included in default output. For diagnostics or fuzzy manual matching, run the script with `--all` and inspect `allModels[]`.

</MODEL_PICKER_EXAMPLE>

After the user answers:

- Find the matching entry in the capped `models[]` script result and use its `subagentType`.
- Remember the choice for the rest of the session.
- Persist the mapped model id by running the script with `--model "<provider/model>"`.
- If the user picks "Other", first validate exact `provider/model` answers by running the script with `--model "<provider/model>"`. For fuzzy matching, run the script with `--all`, map the answer to the closest `allModels[]` entry, or ask the user to clarify. Do not choose the first ranked model as a fallback; only persist a model id returned by the script.

**Model Script Response Shape:**

<MODEL_SCRIPT_RESPONSE_EXAMPLE>

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

</MODEL_SCRIPT_RESPONSE_EXAMPLE>

## Step 5. Delegate

Spawn the chosen subagent with the full visual task prompt:

```js
task({
  subagent_type: "<mapped subagent_type>",
  description: "<short visual task description>",
  prompt: `<the spawning prompt>`
})
```

You **MUST** develop the spawning prompt per the following rules.

You **MUST** use this spawning-prompt structure in the following template:

<SPAWNING_PROMPT_TEMPLATE>

````md
## Visual Task

<one or two sentences describing the exact visual question>

## Images to Inspect

- <image-id>: <local path> - <why this image is relevant>

## Response Template

Return exactly one JSON object shaped like this. Keep these keys exactly, replace placeholder values with observed values, and do not add keys:

<RESPONSE_TEMPLATE>
{
  "...": "..."
}
</RESPONSE_TEMPLATE>

## Response Rules

- The response **MUST** use only the listed images.
- The response **MUST** match the response template exactly; no markdown, prose wrapper, or extra keys.
- The response **MUST** include evidence from the images for every conclusion.
- The response **MUST** include an explicit uncertainty/failure path appropriate to this task.
- The response **MUST** use null when a requested measurement or fact cannot be determined.
````

</SPAWNING_PROMPT_TEMPLATE>

**Spawning Prompt Generation Principles:**

- Each visual task **MUST** carries its own response shape inside the spawning prompt.
- The spawning prompt shape **MUST** be just large enough to answer the current user request and should include its own uncertainty or failure fields.

**Response-template Design Principles:**

Build the smallest JSON object that lets you answer the user.
Include the template directly in the subagent prompt.
The subagent must replace placeholder values with observed values and must not add fields.

Good templates usually include:

- A task-specific conclusion field, e.g. `isCentered`, `layoutLooksOk`, `visible`, `matchesReference`, `changes`.
- Evidence fields that quote or describe what is visible.
- Measurements only when needed; use `null` if not determinable.
- `confidence` from `0` to `1` when the user needs a judgment.
- `uncertainty` or `limitations` when the task can fail partially.

Avoid generic catch-all fields such as `observations` unless the user asked for an open-ended list.
Avoid asking for pixel precision unless the screenshot context actually supports it.

**MUST:**

- You **MUST** generate the smallest JSON shape that answers the current task.
- You **MUST** prefer booleans, enums, numbers, arrays, and nullable fields over vague prose when you may branch on the result.
- You **MUST** always include enough visual evidence for the orchestrator to cite back to the user.
- You **MUST** include uncertainty in the template, not as an afterthought.
- You **MUST** use arrays with one representative item shape for repeated findings.
- You **MUST** require per-image references and structured changes for comparisons.

**MUST NOT:**

- You **MUST NOT** directly reuse a generic fixed envelope shown in the **SPAWNING PROMPT TEMPLATE**.

## Step 6. Parse

The subagent **MUST** return one JSON object and nothing else.
You **MUST** parse it and compare the returned keys to the response template you authored.

- You **MUST** retry once with the same subagent and include the invalid output plus the template if the JSON is malformed or contains extra/missing keys.
- You **MUST** report that honestly and do not invent a stronger conclusion if the response uses uncertainty or failure fields.
- You **MUST** cite the evidence fields when reporting back to the user.
- You **MUST** include confidence only if your template requested it.
