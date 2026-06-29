#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = dirname(scriptDir)
const manifestPath = join(packageDir, "vision-models.json")
const modelFile =
  process.env.VISION_MODEL_FILE ??
  join(homedir(), ".config", "opencode", "vision-model.txt")

function usage() {
  return `Usage:
  node scripts/vision-models.mjs
  node scripts/vision-models.mjs --select <provider/model>

Outputs JSON describing available vision models, matching vision-* subagents,
the recommended model, and any persisted choice. --select persists a known
provider/model id to ${modelFile}.`
}

function subagentName(entry) {
  return `vision-${entry.provider}-${entry.model_id.replace(/[/:]/g, "-")}`
}

function modelID(entry) {
  return `${entry.provider}/${entry.model_id}`
}

function parseArgs(argv) {
  const args = { selectedModel: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--select" || arg === "--selected-model") {
      args.selectedModel = argv[i + 1]
      i += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function readPersistedChoice(knownModelIDs) {
  try {
    if (!existsSync(modelFile)) return undefined
    const raw = readFileSync(modelFile, "utf8").trim()
    if (raw && knownModelIDs.has(raw)) return raw
  } catch {
    return undefined
  }
}

function persistChoice(model) {
  mkdirSync(dirname(modelFile), { recursive: true })
  writeFileSync(modelFile, model)
}

function choicePayload(choice) {
  if (!choice) return null
  const slash = choice.indexOf("/")
  return {
    model: choice,
    subagentType: subagentName({
      provider: choice.slice(0, slash),
      model_id: choice.slice(slash + 1),
    }),
  }
}

function payload(models, choice) {
  return {
    persistedChoice: choicePayload(choice),
    recommendedModel: modelID(models[0]),
    models: models.map((entry, index) => {
      const id = modelID(entry)
      return {
        model: id,
        provider: entry.provider,
        modelID: entry.model_id,
        name: entry.name,
        subagentType: subagentName(entry),
        recommended: index === 0,
        pickerLabel: id,
        pickerDescription: index === 0 ? `${entry.name} (Recommended)` : entry.name,
      }
    }),
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const models = manifest.models ?? []
  const knownModelIDs = new Set(models.map(modelID))

  if (args.selectedModel) {
    if (!knownModelIDs.has(args.selectedModel)) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: "unknown_model",
            selectedModel: args.selectedModel,
            ...payload(models, readPersistedChoice(knownModelIDs)),
          },
          null,
          2,
        ),
      )
      process.exit(1)
    }

    persistChoice(args.selectedModel)
    console.log(
      JSON.stringify(
        {
          ok: true,
          saved: true,
          ...payload(models, args.selectedModel),
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        saved: false,
        ...payload(models, readPersistedChoice(knownModelIDs)),
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "script_error",
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}
