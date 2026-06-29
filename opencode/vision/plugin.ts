import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

// Resolve sibling data files (vision-models.json, subagent-body.md) relative
// to the bundle. When run from source, `import.meta.url` is plugin.ts and the
// files sit next to it. When run from the built dist/index.js, the files ship
// in the package root (one level up from dist/) per `files` in package.json.
// Try a list of candidate directories and use the first that has both files.
const bundleDir = dirname(fileURLToPath(import.meta.url))
const candidateDirs = [bundleDir, join(bundleDir, "..")]
const dataDir =
  candidateDirs.find(
    (d) =>
      existsSync(join(d, "vision-models.json")) &&
      existsSync(join(d, "subagent-body.md"))
  ) ?? bundleDir

const manifest = JSON.parse(
  readFileSync(join(dataDir, "vision-models.json"), "utf8")
)
const bodyTpl = readFileSync(join(dataDir, "subagent-body.md"), "utf8")

// Vision-capable orchestrator models — derived from the manifest. If the
// configured default orchestrator model (cfg.model) is itself vision-capable,
// the vision-* subagents are pointless (the orchestrator can see images
// itself), so the config(cfg) hook skips registering them. This gate only
// checks the configured default at startup; mid-session /model switches are
// handled by the skill's self-gate note ("When NOT to invoke").
const VISION_CAPABLE_ORCHESTRATORS = new Set(
  (manifest.models as Array<{ provider: string; model_id: string }>).map(
    (m) => `${m.provider}/${m.model_id}`
  )
)

// Known `preferredModel` values — used to validate a persisted choice so
// a stale or corrupt vision-model.txt is ignored instead of injecting
// garbage into the system prompt.
const KNOWN_MODEL_IDS = new Set(
  (manifest.models as Array<{ provider: string; model_id: string }>).map(
    (m) => `${m.provider}/${m.model_id}`
  )
)

// Where the chosen vision model is persisted across sessions. The file
// holds a single line: the `preferredModel` string (e.g.
// "openai/gpt-5.5"). The plugin reads it at startup and injects it into
// the system prompt via experimental.chat.system.transform; the skill
// writes it after the user answers the model-selection question.
const VISION_MODEL_FILE = join(homedir(), ".config", "opencode", "vision-model.txt")

const PERMISSION = {
  edit: "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  external_directory: {
    "/private/tmp/**": "allow",
    "/private/var/folders/**": "allow",
  },
}

function subagentName(entry: {
  provider: string
  model_id: string
}): string {
  return (
    "vision-" +
    entry.provider +
    "-" +
    entry.model_id.replace(/[/:]/g, "-")
  )
}

// Save an image FilePart's bytes to /tmp and return the file path.
// FilePart.url may be a `data:image/...;base64,...` URL or an
// absolute `file://`/path URL. We never pass image bytes through the
// shell — writeFileSync only. The path is stable per (sessionID, partID)
// so re-runs of the transform don't duplicate files.
function saveImagePart(
  url: string,
  sessionID: string,
  partID: string,
  ext: string,
): string {
  const tmpDir = "/tmp"
  const name = `vision-${sessionID}-${partID}.${ext}`
  const out = join(tmpDir, name)
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",")
    const payload = comma >= 0 ? url.slice(comma + 1) : ""
    writeFileSync(out, Buffer.from(payload, "base64"))
  } else {
    // file:// or plain path — copy so the orchestrator has a stable
    // /tmp path even if the source is on a removable volume.
    let src = url
    if (url.startsWith("file://")) src = fileURLToPath(url)
    try {
      copyFileSync(src, out)
    } catch {
      // If copy fails (e.g. source already gone), fall back to writing
      // an empty file so the path still exists; the vision subagent
      // will report file_not_found / unsupported_format.
      writeFileSync(out, "")
    }
  }
  return out
}

// Map common image mime types to a file extension for the /tmp path.
function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "png"
}

const plugin: Plugin = async () => ({
  config: async (cfg) => {
    // Startup gate (B): if the configured default orchestrator model is
    // itself vision-capable, skip registering the vision-* subagents — they
    // would be redundant. The skill still loads via skills.paths and self-gates
    // in its body ("When NOT to invoke").
    const orchestrator = cfg.model
    if (orchestrator && VISION_CAPABLE_ORCHESTRATORS.has(orchestrator)) {
      return
    }
    cfg.agent ??= {}
    for (const e of manifest.models) {
      const name = subagentName(e)
      cfg.agent[name] ??= {}
      Object.assign(cfg.agent[name], {
        description: `Visual judgment subagent (${e.name}). Consumes a visual-judgment-request.v1 JSON, analyzes images, emits a visual-judgment-report.v1 JSON. Not coupled to any screenshot tool or UI framework - works with any locally stored image.`,
        mode: "subagent",
        model: `${e.provider}/${e.model_id}`,
        temperature: 0.1,
        prompt: bodyTpl
          .replaceAll("{{model_name}}", e.name)
          .replaceAll("{{provider}}", e.provider)
          .replaceAll("{{model_id}}", e.model_id),
        permission: PERMISSION,
      })
    }
  },

  // Source D: materialize user-dropped chat images as /tmp paths.
  // When a user attaches an image to a message, save the bytes to /tmp
  // and replace the FilePart with a TextPart carrying the path plus a
  // marker the SKILL.md Detect step recognizes. This gives the
  // orchestrator a stable file path to hand to a vision-* subagent,
  // turning a user-message image attachment into the same shape as
  // Source A ("user-provided image path").
  "experimental.chat.messages.transform": async (_input, output) => {
    for (const m of output.messages) {
      if (m.info.role !== "user") continue
      for (const part of m.parts) {
        if (part.type !== "file") continue
        if (!part.mime || !part.mime.startsWith("image/")) continue
        const ext = mimeToExt(part.mime)
        const path = saveImagePart(
          part.url,
          m.info.sessionID,
          part.id,
          ext,
        )
        const filename = part.filename ?? path.split("/").pop() ?? "image"
        // Mutate the part in place into a text part carrying the path.
        // The SKILL.md Source D section tells the orchestrator to treat
        // the path as a visual-judgment trigger.
        ;(part as any).type = "text"
        ;(part as any).text =
          `[vision:dropped-image] An image was attached to this message ` +
          `and saved to ${path} (original filename: ${filename}). ` +
          `Use this path as images[].path in a visual-judgment-request.v1 ` +
          `and delegate to a vision-* subagent.`
        ;(part as any).synthetic = true
      }
    }
  },

  // Persist the user's vision-model choice across sessions. At startup
  // (and on each system-prompt build), read ~/.config/opencode/vision-model.txt
  // and, if it holds a known model id, append a one-line note to the system
  // prompt so the orchestrator reuses it without re-asking. The skill writes
  // the file after the user answers the model-selection question (Step 4).
  "experimental.chat.system.transform": async (_input, output) => {
    let choice: string | undefined
    try {
      if (existsSync(VISION_MODEL_FILE)) {
        const raw = readFileSync(VISION_MODEL_FILE, "utf8").trim()
        if (raw && KNOWN_MODEL_IDS.has(raw)) choice = raw
      }
    } catch {
      // Read failure → no persisted choice; the skill will ask.
    }
    if (choice) {
      output.system.push(
        `[vision:model-choice] The user previously selected ${choice} for visual judgments. ` +
          `Reuse this model for all vision-* delegations this session without asking. ` +
          `To use a different model, write the new choice to ${VISION_MODEL_FILE} and delegate to the matching vision-* subagent.`,
      )
    }
  },
})

export default { id: "vision", server: plugin }