import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

// Resolve sibling data files relative to the bundle. When run from source,
// `import.meta.url` is plugin.ts and the files sit next to it. When run from
// the built dist/index.js, the files ship in the package root (one level up
// from dist/) per `files` in package.json.
const bundleDir = dirname(fileURLToPath(import.meta.url))
const candidateDirs = [bundleDir, join(bundleDir, "..")]
const dataDir =
  candidateDirs.find(
    (d) =>
      existsSync(join(d, "subagent-body.md")) &&
      existsSync(join(d, "scripts", "vision-models.mjs"))
  ) ?? bundleDir

const bodyTpl = readFileSync(join(dataDir, "subagent-body.md"), "utf8")

type VisionModelEntry = {
  provider: string
  model_id: string
  name: string
  supportsImage: boolean
  supportsVideo: boolean
}

type RawModel = {
  id?: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
  }
}

type RawProvider = {
  models?: Record<string, RawModel>
}

type ProviderConfig = {
  whitelist?: string[]
  blacklist?: string[]
  models?: Record<string, RawModel>
}

type ConfigLike = {
  model?: string
  disabled_providers?: string[]
  enabled_providers?: string[]
  provider?: Record<string, ProviderConfig>
  providers?: Record<string, ProviderConfig>
}

type ModelsCatalog = Record<string, RawProvider>

const VISION_MODELS_SCRIPT = join(dataDir, "scripts", "vision-models.mjs")
let registeredModels = new Map<string, VisionModelEntry>()

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

function subagentName(entry: Pick<VisionModelEntry, "provider" | "model_id">): string {
  return (
    "vision-" +
    entry.provider +
    "-" +
    entry.model_id.replace(/[/:]/g, "-")
  )
}

function homeDir(): string {
  return process.env.OPENCODE_TEST_HOME ?? homedir()
}

function xdgPath(kind: string, fallback: string): string {
  return process.env[kind] ?? join(homeDir(), fallback)
}

function opencodeConfigDir(): string {
  return resolve(
    process.env.OPENCODE_CONFIG_DIR ??
      join(xdgPath("XDG_CONFIG_HOME", ".config"), "opencode")
  )
}

function opencodeCacheDir(): string {
  return resolve(join(xdgPath("XDG_CACHE_HOME", ".cache"), "opencode"))
}

function opencodeModelsFile(): string {
  if (process.env.OPENCODE_MODELS_PATH) return resolve(process.env.OPENCODE_MODELS_PATH)
  const source = process.env.OPENCODE_MODELS_URL ?? "https://models.dev"
  const file =
    source === "https://models.dev"
      ? "models.json"
      : `models-${createHash("sha1").update(source).digest("hex")}.json`
  return join(opencodeCacheDir(), file)
}

function visionChoiceFiles(): Record<"image" | "video", string> {
  const configDir = opencodeConfigDir()
  return {
    image: join(configDir, "vision-model-image.txt"),
    video: join(configDir, "vision-model-video.txt"),
  }
}

function readPersistedChoice(mediaType: "image" | "video"): string | undefined {
  try {
    const file = visionChoiceFiles()[mediaType]
    if (!existsSync(file)) return
    const raw = readFileSync(file, "utf8").trim()
    const model = registeredModels.get(raw)
    if (!model) return
    if (mediaType === "image" && model.supportsImage) return raw
    if (mediaType === "video" && model.supportsVideo) return raw
  } catch {
    return
  }
}

function readModelsCatalog(): ModelsCatalog {
  try {
    const file = opencodeModelsFile()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, "utf8")) as ModelsCatalog
  } catch {
    return {}
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function mergeModel(existing: RawModel | undefined, override: RawModel): RawModel {
  if (!existing) return override
  return {
    ...existing,
    ...override,
    modalities: {
      ...existing.modalities,
      ...override.modalities,
    },
    limit: {
      ...existing.limit,
      ...override.limit,
    },
  }
}

function providerConfig(config: ConfigLike, providerID: string): ProviderConfig {
  return config.provider?.[providerID] ?? config.providers?.[providerID] ?? {}
}

function configuredProviderIDs(config: ConfigLike): string[] {
  const disabled = new Set(stringArray(config.disabled_providers))
  const enabled = stringArray(config.enabled_providers)
  const explicit = Object.keys({
    ...(config.providers ?? {}),
    ...(config.provider ?? {}),
  })
  const ids = enabled.length > 0 ? enabled : explicit
  return Array.from(new Set(ids)).filter((id) => !disabled.has(id))
}

function modelInputModalities(model: RawModel): string[] {
  return stringArray(model.modalities?.input)
}

function isVisionModel(model: RawModel): boolean {
  const input = modelInputModalities(model)
  if (input.includes("image") || input.includes("video")) return true
  return input.length === 0 && model.attachment === true
}

function modelCapabilities(model: RawModel): { supportsImage: boolean; supportsVideo: boolean } {
  const input = modelInputModalities(model)
  const supportsImage = input.includes("image") || (input.length === 0 && model.attachment === true)
  const supportsVideo = input.includes("video")
  return { supportsImage, supportsVideo }
}

function providerModels(
  providerID: string,
  catalog: ModelsCatalog,
  config: ConfigLike,
): Record<string, RawModel> {
  const configured = providerConfig(config, providerID)
  const models: Record<string, RawModel> = {
    ...(catalog[providerID]?.models ?? {}),
  }

  for (const [key, override] of Object.entries(configured.models ?? {})) {
    const id = override.id ?? key
    models[key] = mergeModel(models[id] ?? models[key], override)
  }

  return models
}

function modelAllowed(providerConfig: ProviderConfig, modelID: string): boolean {
  const blacklist = stringArray(providerConfig.blacklist)
  const whitelist = stringArray(providerConfig.whitelist)
  if (blacklist.includes(modelID)) return false
  if (whitelist.length > 0 && !whitelist.includes(modelID)) return false
  return true
}

function discoverVisionModels(catalog: ModelsCatalog, config: ConfigLike): VisionModelEntry[] {
  const result: VisionModelEntry[] = []
  for (const provider of configuredProviderIDs(config)) {
    const configured = providerConfig(config, provider)
    for (const [modelKey, model] of Object.entries(providerModels(provider, catalog, config))) {
      const modelID = modelKey
      if (!modelAllowed(configured, modelKey)) continue
      if (model.status === "deprecated") continue
      if (!isVisionModel(model)) continue
      result.push({
        provider,
        model_id: modelID,
        name: model.name ?? modelID,
        ...modelCapabilities(model),
      })
    }
  }
  result.sort((a, b) => `${a.provider}/${a.model_id}`.localeCompare(`${b.provider}/${b.model_id}`))
  return result
}

function splitModel(value: string): { provider: string; modelID: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  return {
    provider: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  }
}

function configuredModelVisionCapable(
  model: string | undefined,
  catalog: ModelsCatalog,
  config: ConfigLike,
): boolean {
  if (!model) return false
  const parts = splitModel(model)
  if (!parts) return false
  const models = providerModels(parts.provider, catalog, config)
  const match = models[parts.modelID]
  return Boolean(match && isVisionModel(match))
}

// Save an image/video FilePart's bytes to /tmp and return the file path.
// FilePart.url may be a `data:*/*;base64,...` URL or an
// absolute `file://`/path URL. We never pass image bytes through the
// shell — writeFileSync only. The path is stable per (sessionID, partID)
// so re-runs of the transform don't duplicate files.
function saveMediaPart(
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

function mediaTypeFromMime(mime: string): "image" | "video" | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  return
}

// Map common image/video mime types to a file extension for the /tmp path.
function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  if (mime.includes("mp4")) return "mp4"
  if (mime.includes("quicktime") || mime.includes("mov")) return "mov"
  if (mime.includes("webm")) return "webm"
  if (mime.includes("matroska") || mime.includes("mkv")) return "mkv"
  return mime.startsWith("video/") ? "mp4" : "png"
}

const plugin: Plugin = async () => ({
  config: async (cfg) => {
    const catalog = readModelsCatalog()
    const dynamicModels = discoverVisionModels(catalog, cfg as ConfigLike)
    registeredModels = new Map(
      dynamicModels.map((m) => [`${m.provider}/${m.model_id}`, m])
    )

    // Startup gate (B): if the configured default orchestrator model is
    // itself vision-capable, skip registering the vision-* subagents — they
    // would be redundant. The skill still loads via skills.paths and self-gates
    // in its body ("When NOT to invoke").
    if (configuredModelVisionCapable(cfg.model, catalog, cfg as ConfigLike)) {
      registeredModels = new Map()
      return
    }

    cfg.agent ??= {}
    for (const e of dynamicModels) {
      const name = subagentName(e)
      cfg.agent[name] ??= {}
      Object.assign(cfg.agent[name], {
        description: `Visual judgment subagent (${e.name}). Consumes a prompt-authored visual task with media paths and a task-specific JSON response template. Not coupled to any screenshot tool or UI framework - works with locally stored images and videos supported by the model.`,
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

  // Source D: materialize user-dropped chat media as /tmp paths.
  // When a user attaches an image or video to a message, save the bytes to /tmp
  // and replace the FilePart with a TextPart carrying the path plus a
  // marker the SKILL.md Detect step recognizes. This gives the
  // orchestrator a stable file path to hand to a vision-* subagent,
  // turning user-message media attachments into the same shape as
  // Source A ("user-provided media path").
  "experimental.chat.messages.transform": async (_input, output) => {
    for (const m of output.messages) {
      if (m.info.role !== "user") continue
      for (const part of m.parts) {
        if (part.type !== "file") continue
        if (!part.mime) continue
        const mediaType = mediaTypeFromMime(part.mime)
        if (!mediaType) continue
        const ext = mimeToExt(part.mime)
        const path = saveMediaPart(
          part.url,
          m.info.sessionID,
          part.id,
          ext,
        )
        const filename = part.filename ?? path.split("/").pop() ?? mediaType
        const payload = JSON.stringify({
          mediaType,
          mime: part.mime,
          path,
          originalFilename: filename,
        })
        // Mutate the part in place into a text part carrying the path.
        // The SKILL.md Source D section tells the orchestrator to treat
        // the path as a visual-judgment trigger.
        ;(part as any).type = "text"
        ;(part as any).text = `[vision:dropped-media] ${payload}`
        ;(part as any).synthetic = true
      }
    }
  },

  // Persisted model choice is still read by the plugin so the orchestrator
  // can avoid re-asking. Model listing and persistence changes are handled
  // by scripts/vision-models.mjs, not a plugin-injected tool.
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(
      `[vision:model-script] Query available vision models with: node ${VISION_MODELS_SCRIPT} --media <image|video|image,video>. ` +
        `Persist choices with: node ${VISION_MODELS_SCRIPT} --media-type=<image|video> --model <provider/model>. ` +
        `Do not use a hardcoded model picker list.`,
    )
    for (const mediaType of ["image", "video"] as const) {
      const choice = readPersistedChoice(mediaType)
      if (choice) {
        output.system.push(
          `[vision:model-choice] media=${mediaType} model=${choice}. ` +
            `Reuse this model for ${mediaType} visual delegations without asking. ` +
            `To use a different model, run the vision model script with --media-type=${mediaType} --model <provider/model>.`,
        )
      }
    }
  },
})

export default { id: "vision", server: plugin }
