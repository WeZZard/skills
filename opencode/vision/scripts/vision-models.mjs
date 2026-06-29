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
const PICKER_MODEL_LIMIT = 6
const PICKER_PROVIDER_LIMIT = 2

function usage() {
  return `Usage:
  node scripts/vision-models.mjs
  node scripts/vision-models.mjs --all
  node scripts/vision-models.mjs --model <provider/model>

Options:
  --all                 Include all discovered image-capable models as allModels[].
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
    includeAll: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i]
    const [arg, inlineValue] = splitInlineArg(rawArg)

    if (arg === "--help" || arg === "-h") {
      args.help = true
      continue
    }
    if (arg === "--all") {
      args.includeAll = true
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
  const supportsTextOutput = output.length === 0 || output.includes("text")
  return { input, output, supportsImage, supportsTextOutput }
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
      if (rawModel.status && rawModel.status !== "active") continue

      const capabilities = modelCapabilities(rawModel)
      if (!capabilities.supportsImage) continue
      if (!capabilities.supportsTextOutput) continue

      const fullModelID = displayModel(providerID, modelKey)
      const entry = {
        model: fullModelID,
        provider: providerID,
        modelID: modelKey,
        name: typeof rawModel.name === "string" ? rawModel.name : modelKey,
        subagentType: subagentName(providerID, modelKey),
        supportsImage: capabilities.supportsImage,
        supportsTextOutput: capabilities.supportsTextOutput,
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
  return { models, missingProviders }
}

function compareModels(a, b) {
  if (a.status !== b.status) {
    if (a.status === "active") return -1
    if (b.status === "active") return 1
  }
  if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1
  if (a.toolCall !== b.toolCall) return a.toolCall ? -1 : 1
  if (a.releaseDate && b.releaseDate && a.releaseDate !== b.releaseDate) {
    return b.releaseDate.localeCompare(a.releaseDate)
  }
  if (a.releaseDate !== b.releaseDate) return a.releaseDate ? -1 : 1
  if (a.contextLimit !== b.contextLimit) {
    return (b.contextLimit ?? 0) - (a.contextLimit ?? 0)
  }
  return a.model.localeCompare(b.model)
}

function normalizeSeriesSource(value) {
  return value
    .toLowerCase()
    .replace(/@/g, "")
    .replace(/[._:]+/g, "-")
    .replace(/\//g, " ")
    .replace(/[^a-z0-9\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function versionParts(value) {
  return (value.match(/\d+/g) ?? []).map((part) => Number(part))
}

function findVersionSpan(source) {
  const patterns = [
    { pattern: /\b([a-z]+-)(\d+(?:(?:-\d+)|(?:p\d+))+)\b/, group: 2 },
    { pattern: /\b([a-z]+)(\d+(?:(?:-\d+)|(?:p\d+))+)\b/, group: 2 },
    { pattern: /\b(\d+(?:-\d+)+)\b/, group: 1 },
    { pattern: /\b([a-z]+-)(\d+)(?=$|-)/, group: 2 },
    { pattern: /\b([a-z]+)(\d+)(?=$|-)/, group: 2 },
  ]

  for (const { pattern, group } of patterns) {
    const match = pattern.exec(source)
    if (!match) continue
    const text = match[group]
    const relativeStart = match[0].indexOf(text)
    return {
      start: match.index + relativeStart,
      end: match.index + relativeStart + text.length,
      parts: versionParts(text),
    }
  }

  return undefined
}

function modelSeries(entry) {
  for (const source of [entry.modelID, entry.name]) {
    if (!source) continue
    const normalized = normalizeSeriesSource(source)
    if (!normalized) continue
    const version = findVersionSpan(normalized)
    if (!version || version.parts.length === 0) continue
    const key = `${normalized.slice(0, version.start)}<version>${normalized.slice(version.end)}`
      .replace(/[^a-z0-9<>]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    return { key, version: version.parts }
  }

  const fallback = normalizeSeriesSource(entry.modelID || entry.name || entry.model)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return { key: fallback || entry.model, version: [] }
}

function compareVersionParts(a, b) {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

function compareSeriesCandidates(a, aSeries, b, bSeries) {
  const version = compareVersionParts(aSeries.version, bSeries.version)
  if (version !== 0) return version > 0 ? -1 : 1
  return compareModels(a, b)
}

function latestModelsBySeries(models) {
  const bestBySeries = new Map()

  for (const entry of models) {
    const series = modelSeries(entry)
    const key = `${entry.provider}:${series.key}`
    const current = bestBySeries.get(key)
    if (
      !current ||
      compareSeriesCandidates(entry, series, current.entry, current.series) < 0
    ) {
      bestBySeries.set(key, { entry, series })
    }
  }

  return Array.from(bestBySeries.values())
    .map((item) => item.entry)
    .sort(compareModels)
}

function addPickerEntry(result, providerCounts, entry, options = {}) {
  if (!entry) return false
  if (result.some((item) => item.model === entry.model)) return false
  if (!options.force) {
    const providerCount = providerCounts.get(entry.provider) ?? 0
    if (providerCount >= PICKER_PROVIDER_LIMIT) return false
  }
  result.push(entry)
  providerCounts.set(entry.provider, (providerCounts.get(entry.provider) ?? 0) + 1)
  return true
}

function pickerModels(models, persistedChoice) {
  const ranked = latestModelsBySeries(models)
  const result = []
  const providerCounts = new Map()

  addPickerEntry(result, providerCounts, ranked[0])
  if (persistedChoice) {
    addPickerEntry(result, providerCounts, persistedChoice, { force: true })
  }

  for (const entry of ranked) {
    if (result.length >= PICKER_MODEL_LIMIT) break
    addPickerEntry(result, providerCounts, entry)
  }

  return result
    .slice(0, PICKER_MODEL_LIMIT)
    .map((entry) =>
      pickerModelPayload(entry, {
        saved: entry.model === persistedChoice?.model,
      }),
    )
}

function pickerModelPayload(entry, options = {}) {
  const status = entry.status === "active" ? "" : `, ${entry.status}`
  const tags = [
    options.saved ? "Saved choice" : undefined,
  ].filter(Boolean)
  const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : ""
  return {
    model: entry.model,
    subagentType: entry.subagentType,
    pickerLabel: entry.pickerLabel,
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
    subagentType: entry.subagentType,
    pickerLabel: entry.pickerLabel,
    pickerDescription: `${entry.name} - image`,
  }
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
  const persistedChoice = readPersistedChoice(input.choiceFile, allModelsByID)
  const picker = pickerModels(input.models, persistedChoice)
  const result = {
    persistedChoice: choicePayload(persistedChoice) ?? null,
    selectedModel: persistedChoice?.model ?? null,
    selectionRequired: !persistedChoice && picker.length > 0,
    models: picker,
    modelCount: input.models.length,
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

  if (input.includeAll) {
    result.allModels = input.models
  }

  return result
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
    includeAll: args.includeAll,
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
