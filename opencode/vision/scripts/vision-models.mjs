#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const env = process.env

function usage() {
  return `Usage:
  node scripts/vision-models.mjs
  node scripts/vision-models.mjs --model <provider/model>

Options:
  --model <model>       Image-capable provider/model id to persist.
  --cwd <path>          Directory used for project config discovery.
  --worktree <path>     Stop project config discovery at this directory.
  --config-dir <path>   OpenCode config directory. Defaults to OPENCODE_CONFIG_DIR or XDG config.
  --models-file <path>  OpenCode cached models file. Defaults to OPENCODE_MODELS_PATH or XDG cache.
  --data-dir <path>     OpenCode data directory for auth.json. Defaults to OPENCODE_DATA_DIR or XDG data.

Outputs JSON describing configured models from OpenCode's cached catalog after
applying OpenCode provider config, saved auth, and matching provider environment
variables. Returned models must support image input.`
}

function parseArgs(argv) {
  const args = {
    cwd: undefined,
    worktree: undefined,
    configDir: undefined,
    dataDir: undefined,
    modelsFile: undefined,
    selectedModel: undefined,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i]
    const [arg, inlineValue] = splitInlineArg(rawArg)

    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--model") {
      args.selectedModel = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    if (arg === "--cwd") {
      args.cwd = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    if (arg === "--worktree") {
      args.worktree = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    if (arg === "--config-dir") {
      args.configDir = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    if (arg === "--models-file") {
      args.modelsFile = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    if (arg === "--data-dir") {
      args.dataDir = inlineValue ?? readRequiredValue(argv, i, arg)
      if (inlineValue === undefined) i += 1
      continue
    }
    throw new Error(`Unknown argument: ${rawArg}`)
  }

  return args
}

function splitInlineArg(arg) {
  const equals = arg.indexOf("=")
  if (equals < 0) return [arg, undefined]
  return [arg.slice(0, equals), arg.slice(equals + 1)]
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function homeDir() {
  return env.OPENCODE_TEST_HOME ?? homedir()
}

function xdgPath(kind, fallback) {
  return env[kind] ?? join(homeDir(), fallback)
}

function opencodeConfigDir(args) {
  return resolve(
    args.configDir ??
      env.OPENCODE_CONFIG_DIR ??
      join(xdgPath("XDG_CONFIG_HOME", ".config"), "opencode"),
  )
}

function opencodeCacheDir() {
  return resolve(join(xdgPath("XDG_CACHE_HOME", ".cache"), "opencode"))
}

function opencodeDataDir(args) {
  return resolve(
    args.dataDir ??
      env.OPENCODE_DATA_DIR ??
      join(xdgPath("XDG_DATA_HOME", ".local/share"), "opencode"),
  )
}

function opencodeModelsFile(args) {
  if (args.modelsFile) return resolve(args.modelsFile)
  if (env.OPENCODE_MODELS_PATH) return resolve(env.OPENCODE_MODELS_PATH)
  const source = env.OPENCODE_MODELS_URL ?? "https://models.dev"
  const file =
    source === "https://models.dev"
      ? "models.json"
      : `models-${createHash("sha1").update(source).digest("hex")}.json`
  return join(opencodeCacheDir(), file)
}

function choiceFile(configDir) {
  return join(configDir, "vision-model-image.txt")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeConfig(target, source) {
  if (!isRecord(source)) return target
  const result = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(result[key]) && isRecord(value)) {
      result[key] = mergeConfig(result[key], value)
      continue
    }
    result[key] = value
  }
  return result
}

function stripJsonComments(text) {
  let result = ""
  let inString = false
  let quote = ""
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) {
        inString = false
        quote = ""
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      result += char
      continue
    }

    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      result += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") result += "\n"
        i += 1
      }
      i += 1
      continue
    }

    result += char
  }

  return result
}

function stripTrailingCommas(text) {
  let result = ""
  let inString = false
  let quote = ""
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) {
        inString = false
        quote = ""
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      result += char
      continue
    }

    if (char === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === "}" || text[j] === "]") continue
    }

    result += char
  }

  return result
}

function parseJsonc(text, filepath) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)))
  } catch (error) {
    throw new Error(
      `Failed to parse ${filepath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function readConfigFile(filepath) {
  if (!existsSync(filepath)) return undefined
  const text = readFileSync(filepath, "utf8")
  if (!text.trim()) return {}
  return parseJsonc(text, filepath)
}

function findGitRoot(start) {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findUpTargets(targets, start, stop) {
  const result = []
  let current = resolve(start)
  const stopAt = stop ? resolve(stop) : undefined

  while (true) {
    for (const target of targets) {
      const candidate = join(current, target)
      if (existsSync(candidate)) result.push(candidate)
    }
    if (stopAt && current === stopAt) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return result
}

function unique(items) {
  return Array.from(new Set(items))
}

function configFileSources(args, configDir) {
  const cwd = resolve(args.cwd ?? env.OPENCODE_CWD ?? process.cwd())
  const worktree = args.worktree
    ? resolve(args.worktree)
    : env.OPENCODE_WORKTREE
      ? resolve(env.OPENCODE_WORKTREE)
      : findGitRoot(cwd)
  const files = []

  for (const file of ["config.json", "opencode.json", "opencode.jsonc"]) {
    files.push({ path: join(configDir, file), scope: "global" })
  }

  if (env.OPENCODE_CONFIG) {
    files.push({ path: resolve(env.OPENCODE_CONFIG), scope: "custom" })
  }

  if (!truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    for (const file of findUpTargets(["opencode.jsonc", "opencode.json"], cwd, worktree).reverse()) {
      files.push({ path: file, scope: "project" })
    }
  }

  const configDirs = [configDir]
  if (!truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    configDirs.push(...findUpTargets([".opencode"], cwd, worktree))
  }
  const homeOpencode = join(homeDir(), ".opencode")
  if (isDirectory(homeOpencode)) configDirs.push(homeOpencode)
  if (env.OPENCODE_CONFIG_DIR) configDirs.push(resolve(env.OPENCODE_CONFIG_DIR))

  for (const dir of unique(configDirs)) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      files.push({ path: join(dir, file), scope: dir === configDir ? "global" : "directory" })
    }
  }

  return { cwd, worktree, files }
}

function truthy(value) {
  if (value === undefined) return false
  const normalized = String(value).toLowerCase()
  return normalized === "1" || normalized === "true"
}

function loadOpenCodeConfig(args, configDir) {
  let config = {}
  const { cwd, worktree, files } = configFileSources(args, configDir)
  const loadedFiles = []
  const seen = new Set()

  for (const source of files) {
    if (seen.has(source.path)) continue
    seen.add(source.path)
    const loaded = readConfigFile(source.path)
    if (loaded === undefined) continue
    config = mergeConfig(config, loaded)
    loadedFiles.push(source)
  }

  if (env.OPENCODE_CONFIG_CONTENT) {
    config = mergeConfig(
      config,
      parseJsonc(env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT"),
    )
    loadedFiles.push({ path: "OPENCODE_CONFIG_CONTENT", scope: "env" })
  }

  return { config, loadedFiles, cwd, worktree }
}

function readModelsCatalog(filepath) {
  if (!existsSync(filepath)) {
    throw new Error(`OpenCode cached model file not found: ${filepath}`)
  }
  return JSON.parse(readFileSync(filepath, "utf8"))
}

function readAuthData(dataDir) {
  try {
    if (env.OPENCODE_AUTH_CONTENT) {
      return JSON.parse(env.OPENCODE_AUTH_CONTENT)
    }
    const file = join(dataDir, "auth.json")
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : []
}

function providerConfigEntries(config) {
  return Object.entries({
    ...(isRecord(config.providers) ? config.providers : {}),
    ...(isRecord(config.provider) ? config.provider : {}),
  }).filter(([, value]) => isRecord(value))
}

function configuredProviderIDs(config, catalog, authData) {
  const disabled = new Set(stringArray(config.disabled_providers))
  const enabled = stringArray(config.enabled_providers)
  const providerEntries = providerConfigEntries(config)
  const providerIDs = providerEntries.map(([id]) => id)
  const envProviderIDs = Object.entries(catalog)
    .filter(([, provider]) => stringArray(provider?.env).some((key) => Boolean(env[key])))
    .map(([id]) => id)
  const authProviderIDs = Object.entries(isRecord(authData) ? authData : {})
    .filter(([, value]) => isRecord(value) && typeof value.type === "string")
    .map(([id]) => id.replace(/\/+$/, ""))
  let source = "none"
  let ids

  if (enabled.length > 0) {
    ids = enabled
    source = "enabled_providers"
  } else if (providerIDs.length > 0) {
    ids = unique([...providerIDs, ...envProviderIDs, ...authProviderIDs])
    source = "provider_config"
  } else if (envProviderIDs.length > 0 || authProviderIDs.length > 0) {
    ids = unique([...envProviderIDs, ...authProviderIDs])
    source = [
      envProviderIDs.length > 0 ? "env" : undefined,
      authProviderIDs.length > 0 ? "auth" : undefined,
    ]
      .filter(Boolean)
      .join("+")
  } else {
    ids = []
  }

  ids = unique(ids).filter((id) => !disabled.has(id))
  return {
    ids,
    source,
    disabled: Array.from(disabled),
    enabled,
    providerIDs,
    envProviderIDs,
    authProviderIDs,
  }
}

function mergeModel(existing, override) {
  if (!isRecord(existing)) return override
  if (!isRecord(override)) return existing
  return mergeConfig(existing, override)
}

function providerModels(providerID, catalog, config) {
  const providerConfig = isRecord(config.provider?.[providerID])
    ? config.provider[providerID]
    : isRecord(config.providers?.[providerID])
      ? config.providers[providerID]
      : {}
  const catalogProvider = isRecord(catalog[providerID]) ? catalog[providerID] : {}
  const rawModels = {
    ...(isRecord(catalogProvider.models) ? catalogProvider.models : {}),
  }

  for (const [key, override] of Object.entries(
    isRecord(providerConfig.models) ? providerConfig.models : {},
  )) {
    const id = typeof override?.id === "string" ? override.id : key
    rawModels[key] = mergeModel(rawModels[id] ?? rawModels[key], override)
  }

  return { providerConfig, rawModels }
}

function modelInputModalities(model) {
  return stringArray(model?.modalities?.input)
}

function modelOutputModalities(model) {
  return stringArray(model?.modalities?.output)
}

function modelCapabilities(model) {
  const input = modelInputModalities(model)
  const output = modelOutputModalities(model)
  const hasDeclaredInput = input.length > 0
  const supportsImage = input.includes("image") || (!hasDeclaredInput && model?.attachment === true)
  return { input, output, supportsImage }
}

function subagentName(providerID, id) {
  return `vision-${providerID}-${id.replace(/[/:]/g, "-")}`
}

function displayModel(providerID, id) {
  return `${providerID}/${id}`
}

function applyProviderModelFilters(providerConfig, modelKey) {
  const blacklist = stringArray(providerConfig.blacklist)
  const whitelist = stringArray(providerConfig.whitelist)
  if (blacklist.includes(modelKey)) return false
  if (whitelist.length > 0 && !whitelist.includes(modelKey)) return false
  return true
}

function discoverVisionModels(catalog, config, providerSelection) {
  const models = []
  const missingProviders = []

  for (const providerID of providerSelection.ids) {
    const hasCatalogProvider = isRecord(catalog[providerID])
    const { providerConfig, rawModels } = providerModels(providerID, catalog, config)
    if (!hasCatalogProvider && Object.keys(rawModels).length === 0) {
      missingProviders.push(providerID)
      continue
    }

    for (const [modelKey, rawModel] of Object.entries(rawModels)) {
      if (!isRecord(rawModel)) continue
      if (!applyProviderModelFilters(providerConfig, modelKey)) continue
      if (rawModel.status === "deprecated") continue

      const capabilities = modelCapabilities(rawModel)
      if (!capabilities.supportsImage) continue

      const fullModelID = displayModel(providerID, modelKey)
      const entry = {
        model: fullModelID,
        provider: providerID,
        modelID: modelKey,
        name: typeof rawModel.name === "string" ? rawModel.name : modelKey,
        subagentType: subagentName(providerID, modelKey),
        supportsImage: capabilities.supportsImage,
        inputModalities: capabilities.input,
        outputModalities: capabilities.output,
        status: typeof rawModel.status === "string" ? rawModel.status : "active",
        reasoning: Boolean(rawModel.reasoning),
        toolCall: Boolean(rawModel.tool_call),
        contextLimit:
          typeof rawModel.limit?.context === "number" ? rawModel.limit.context : null,
        releaseDate:
          typeof rawModel.release_date === "string" ? rawModel.release_date : null,
        pickerLabel: fullModelID,
        pickerDescription: "",
      }
      models.push(entry)
    }
  }

  models.sort(compareModels)
  return { models: models.map(withPickerDescription), missingProviders }
}

function compareModels(a, b) {
  if (a.status !== b.status) {
    if (a.status === "active") return -1
    if (b.status === "active") return 1
  }
  if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1
  if (a.releaseDate && b.releaseDate && a.releaseDate !== b.releaseDate) {
    return b.releaseDate.localeCompare(a.releaseDate)
  }
  return a.model.localeCompare(b.model)
}

function withPickerDescription(entry, index) {
  const suffix = index === 0 ? " (Recommended)" : ""
  const status = entry.status === "active" ? "" : `, ${entry.status}`
  return {
    ...entry,
    recommended: index === 0,
    pickerDescription: `${entry.name} - image${status}${suffix}`,
  }
}

function readPersistedChoice(file, modelsByID) {
  try {
    if (!existsSync(file)) return undefined
    const raw = readFileSync(file, "utf8").trim()
    const entry = modelsByID.get(raw)
    if (entry?.supportsImage) return entry
  } catch {
    return undefined
  }
}

function choicePayload(entry) {
  if (!entry) return undefined
  return {
    model: entry.model,
    provider: entry.provider,
    modelID: entry.modelID,
    subagentType: entry.subagentType,
    supportsImage: entry.supportsImage,
  }
}

function persistedChoicePayload(file, allModelsByID) {
  return choicePayload(readPersistedChoice(file, allModelsByID)) ?? null
}

function validateSelectedModel(model, allModelsByID) {
  const entry = allModelsByID.get(model)
  if (!entry) throw new Error(`Unknown image model: ${model}`)
  if (!entry.supportsImage) throw new Error(`Model ${model} does not support image input`)
  return entry
}

function persistSelection(file, entry) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${entry.model}\n`)
}

function payload(input) {
  const allModelsByID = new Map(input.allModels.map((entry) => [entry.model, entry]))
  return {
    persistedChoice: persistedChoicePayload(input.choiceFile, allModelsByID),
    recommendedModel: input.models[0]?.model ?? null,
    models: input.models,
    configuredProviders: input.providerSelection.ids,
    providerSelection: {
      source: input.providerSelection.source,
      explicitProviders: input.providerSelection.providerIDs,
      envProviders: input.providerSelection.envProviderIDs,
      authProviders: input.providerSelection.authProviderIDs,
      enabledProviders: input.providerSelection.enabled,
      disabledProviders: input.providerSelection.disabled,
    },
    choiceFile: input.choiceFile,
    sources: {
      modelsFile: input.modelsFile,
      configDir: input.configDir,
      dataDir: input.dataDir,
      cwd: input.cwd,
      worktree: input.worktree ?? null,
      configFiles: input.loadedFiles,
    },
    warnings: input.warnings,
  }
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }

  const configDir = opencodeConfigDir(args)
  const dataDir = opencodeDataDir(args)
  const modelsFile = opencodeModelsFile(args)
  const file = choiceFile(configDir)
  const catalog = readModelsCatalog(modelsFile)
  const authData = readAuthData(dataDir)
  const loaded = loadOpenCodeConfig(args, configDir)
  const providerSelection = configuredProviderIDs(loaded.config, catalog, authData)
  const discovered = discoverVisionModels(catalog, loaded.config, providerSelection)
  const allModels = discovered.models
  const allModelsByID = new Map(allModels.map((entry) => [entry.model, entry]))
  const warnings = []

  if (providerSelection.source === "none") {
    warnings.push(
      "No OpenCode provider configuration, provider credentials, or matching provider environment variables found; no configured providers can be intersected with the cached model catalog.",
    )
  }
  if (discovered.missingProviders.length > 0) {
    warnings.push(
      `Configured providers missing from cached model file: ${discovered.missingProviders.join(", ")}`,
    )
  }
  if (discovered.models.length === 0) {
    warnings.push("No configured models support image input.")
  }

  const common = {
    models: discovered.models,
    allModels,
    providerSelection,
    configDir,
    dataDir,
    modelsFile,
    choiceFile: file,
    cwd: loaded.cwd,
    worktree: loaded.worktree,
    loadedFiles: loaded.loadedFiles,
    warnings,
  }

  if (args.selectedModel) {
    const selected = validateSelectedModel(args.selectedModel, allModelsByID)
    persistSelection(file, selected)
    console.log(
      JSON.stringify(
        {
          ok: true,
          saved: true,
          savedChoice: choicePayload(selected),
          ...payload(common),
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
        ...payload(common),
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
