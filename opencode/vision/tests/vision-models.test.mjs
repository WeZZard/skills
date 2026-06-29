import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const scriptPath = join(packageDir, "scripts", "vision-models.mjs")

function catalog() {
  return {
    alpha: {
      id: "alpha",
      name: "Alpha",
      env: ["ALPHA_API_KEY"],
      models: {
        "image-only": {
          id: "image-only",
          name: "Image Only",
          attachment: true,
          reasoning: true,
          tool_call: true,
          release_date: "2026-01-01",
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        "image-audio": {
          id: "image-audio",
          name: "Image Audio",
          reasoning: true,
          tool_call: true,
          release_date: "2026-01-02",
          modalities: { input: ["text", "image", "audio"], output: ["text"] },
        },
        "text-only": {
          id: "text-only",
          name: "Text Only",
          release_date: "2026-01-03",
          modalities: { input: ["text"], output: ["text"] },
        },
        "image-output-only": {
          id: "image-output-only",
          name: "Image Output Only",
          release_date: "2026-01-03",
          modalities: { input: ["text", "image"], output: ["image"] },
        },
        "audio-output-only": {
          id: "audio-output-only",
          name: "Audio Output Only",
          release_date: "2026-01-03",
          modalities: { input: ["text", "image"], output: ["audio"] },
        },
        "attachment-only": {
          id: "attachment-only",
          name: "Attachment Only",
          attachment: true,
          release_date: "2026-01-04",
        },
        "deprecated-image": {
          id: "deprecated-image",
          name: "Deprecated Image",
          status: "deprecated",
          release_date: "2026-01-05",
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
    beta: {
      id: "beta",
      name: "Beta",
      env: ["BETA_API_KEY"],
      models: {
        "beta-image": {
          id: "beta-image",
          name: "Beta Image",
          release_date: "2026-01-06",
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
  }
}

async function fixture({ configText, configObject, modelCatalog = catalog(), authObject = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vision-models-test-"))
  const configDir = join(root, "config")
  const dataDir = join(root, "data")
  const projectDir = join(root, "project")
  const modelsFile = join(root, "models.json")
  await mkdir(configDir)
  await mkdir(dataDir)
  await mkdir(projectDir)
  await writeFile(modelsFile, JSON.stringify(modelCatalog, null, 2))
  await writeFile(join(dataDir, "auth.json"), JSON.stringify(authObject, null, 2))
  if (configText !== undefined) {
    await writeFile(join(configDir, "opencode.jsonc"), configText)
  } else {
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify(configObject ?? { enabled_providers: ["alpha"] }, null, 2),
    )
  }
  return {
    root,
    configDir,
    dataDir,
    projectDir,
    modelsFile,
    imageChoice: join(configDir, "vision-model-image.txt"),
    obsoleteChoice: join(configDir, ["vision", "model"].join("-") + ".txt"),
  }
}

async function runVision(fx, args = [], extraEnv = {}) {
  const env = { ...process.env }
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DATA_DIR",
    "OPENCODE_MODELS_PATH",
    "VISION_MODEL_FILE",
  ]) {
    delete env[key]
  }
  Object.assign(env, extraEnv)
  const allArgs = [
    scriptPath,
    "--config-dir",
    fx.configDir,
    "--data-dir",
    fx.dataDir,
    "--cwd",
    fx.projectDir,
    "--models-file",
    fx.modelsFile,
    ...args,
  ]
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, allArgs, {
      cwd: packageDir,
      env,
    })
    return { code: 0, stdout, stderr, json: JSON.parse(stdout) }
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      json: JSON.parse(error.stdout || error.stderr),
    }
  }
}

async function withFixture(options, fn) {
  const fx = await fixture(options)
  try {
    await fn(fx)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
}

function modelIDs(result, field = "models") {
  return result.json[field].map((model) => model.model)
}

function pickerModelIDs(result) {
  return modelIDs(result, "pickerModels")
}

test("lists image-capable models only", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result, "allModels")), new Set([
      "alpha/attachment-only",
      "alpha/image-audio",
      "alpha/image-only",
    ]))
    assert.equal(result.json.persistedChoice, null)
    assert.equal(result.json.choiceFile, fx.imageChoice)
    assert.equal(result.json.modelCount, 3)
    assert.ok(result.json.models.length <= 6)
  })
})

test("enabled_providers, disabled_providers, whitelist, and blacklist are honored", async () => {
  await withFixture({
    configObject: {
      enabled_providers: ["alpha", "beta"],
      disabled_providers: ["beta"],
      provider: {
        alpha: {
          whitelist: ["image-only", "image-audio", "attachment-only"],
          blacklist: ["image-only"],
        },
      },
    },
  }, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result, "allModels")), new Set([
      "alpha/attachment-only",
      "alpha/image-audio",
    ]))
    assert.deepEqual(result.json.configuredProviders, ["alpha"])
  })
})

test("JSONC config with comments and trailing commas parses", async () => {
  await withFixture({
    configText: `{
      // JSONC is accepted
      "enabled_providers": ["alpha",],
      "provider": {
        "alpha": {
          "whitelist": ["image-audio",],
        },
      },
    }`,
  }, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result, "allModels"), ["alpha/image-audio"])
  })
})

test("saved OpenCode auth providers are treated as configured providers", async () => {
  await withFixture({
    configObject: {},
    authObject: {
      alpha: { type: "api", key: "redacted" },
    },
  }, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result, "allModels")), new Set([
      "alpha/attachment-only",
      "alpha/image-audio",
      "alpha/image-only",
    ]))
    assert.deepEqual(result.json.configuredProviders, ["alpha"])
    assert.deepEqual(result.json.providerSelection.authProviders, ["alpha"])
    assert.equal(result.json.providerSelection.source, "auth")
  })
})

test("provider env vars are treated as configured providers", async () => {
  await withFixture({
    configObject: {},
  }, async (fx) => {
    const result = await runVision(fx, ["--all"], { BETA_API_KEY: "redacted" })
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result, "allModels"), ["beta/beta-image"])
    assert.deepEqual(result.json.configuredProviders, ["beta"])
    assert.deepEqual(result.json.providerSelection.envProviders, ["beta"])
    assert.equal(result.json.providerSelection.source, "env")
  })
})

test("disabled_providers excludes auth-backed and env-backed providers", async () => {
  await withFixture({
    configObject: {
      disabled_providers: ["alpha", "beta"],
    },
    authObject: {
      alpha: { type: "api", key: "redacted" },
    },
  }, async (fx) => {
    const result = await runVision(fx, [], { BETA_API_KEY: "redacted" })
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.models, [])
    assert.deepEqual(result.json.configuredProviders, [])
  })
})

test("custom provider model keeps config key as user-facing model id", async () => {
  await withFixture({
    modelCatalog: { custom: { id: "custom", name: "Custom", models: {} } },
    configObject: {
      provider: {
        custom: {
          models: {
            alias: {
              id: "provider/api-id",
              name: "Alias Vision",
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      },
    },
  }, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result, "allModels"), ["custom/alias"])
    assert.equal(result.json.allModels[0].subagentType, "vision-custom-alias")
  })
})

test("picker shortlist keeps only the latest model in each provider series", async () => {
  await withFixture({
    configObject: { enabled_providers: ["openai", "kimi", "anthropic"] },
    modelCatalog: {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5.4": {
            id: "gpt-5.4",
            name: "GPT-5.4",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-01",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          "gpt-5.5": {
            id: "gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-02",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          "gpt-5.5-pro": {
            id: "gpt-5.5-pro",
            name: "GPT-5.5 Pro",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-02",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
      kimi: {
        id: "kimi",
        name: "Kimi",
        models: {
          k2p5: {
            id: "k2p5",
            name: "Kimi K2.5",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-03",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          k2p7: {
            id: "k2p7",
            name: "Kimi K2.7 Code",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-04",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        models: {
          "claude-sonnet-4-5": {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-05",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          "claude-sonnet-4-8": {
            id: "claude-sonnet-4-8",
            name: "Claude Sonnet 4.8",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-06",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    },
  }, async (fx) => {
    const result = await runVision(fx, ["--all"])
    assert.equal(result.code, 0)

    assert.ok(modelIDs(result, "allModels").includes("openai/gpt-5.4"))
    assert.ok(modelIDs(result, "allModels").includes("kimi/k2p5"))
    assert.ok(modelIDs(result, "allModels").includes("anthropic/claude-sonnet-4-5"))

    assert.ok(pickerModelIDs(result).includes("openai/gpt-5.5"))
    assert.ok(pickerModelIDs(result).includes("openai/gpt-5.5-pro"))
    assert.ok(pickerModelIDs(result).includes("kimi/k2p7"))
    assert.ok(pickerModelIDs(result).includes("anthropic/claude-sonnet-4-8"))
    assert.equal(pickerModelIDs(result).includes("openai/gpt-5.4"), false)
    assert.equal(pickerModelIDs(result).includes("kimi/k2p5"), false)
    assert.equal(pickerModelIDs(result).includes("anthropic/claude-sonnet-4-5"), false)
    assert.equal(result.json.recommendedModel, result.json.pickerModels[0].model)
  })
})

test("picker shortlist is capped while full models remain available", async () => {
  const ids = [
    "atlas",
    "beacon",
    "comet",
    "delta",
    "ember",
    "fable",
    "glider",
    "harbor",
  ]
  const models = Object.fromEntries(
    ids.map((id, index) => {
      return [
        id,
        {
          id,
          name: id,
          reasoning: true,
          tool_call: true,
          release_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      ]
    }),
  )

  await withFixture({
    modelCatalog: {
      alpha: {
        id: "alpha",
        name: "Alpha",
        models,
      },
    },
  }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.equal(result.json.modelCount, 8)
    assert.equal(result.json.models.length, 2)
    assert.equal(result.json.pickerModels.length, 2)

    const all = await runVision(fx, ["--all"])
    assert.equal(all.json.allModels.length, 8)
  })
})

test("picker ranking uses reasoning, tool calls, release date, and context", async () => {
  await withFixture({
    modelCatalog: {
      alpha: {
        id: "alpha",
        name: "Alpha",
        models: {
          atlas: {
            id: "atlas",
            name: "Atlas",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-02",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 100 },
          },
          beacon: {
            id: "beacon",
            name: "Beacon",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-02",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 200 },
          },
          comet: {
            id: "comet",
            name: "Comet",
            reasoning: true,
            tool_call: true,
            release_date: "2026-01-01",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000 },
          },
          delta: {
            id: "delta",
            name: "Delta",
            reasoning: true,
            tool_call: false,
            release_date: "2026-02-01",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000 },
          },
          ember: {
            id: "ember",
            name: "Ember",
            reasoning: false,
            tool_call: true,
            release_date: "2026-03-01",
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000 },
          },
        },
      },
    },
  }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["alpha/beacon", "alpha/atlas"])
  })
})

test("picker shortlist caps provider diversity", async () => {
  function providerModels(prefix, month) {
    return Object.fromEntries(
      ["one", "two", "three"].map((name, index) => [
        `${prefix}-${name}`,
        {
          id: `${prefix}-${name}`,
          name: `${prefix} ${name}`,
          reasoning: true,
          tool_call: true,
          release_date: `2026-${month}-${String(index + 1).padStart(2, "0")}`,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      ]),
    )
  }

  await withFixture({
    configObject: { enabled_providers: ["alpha", "beta", "gamma"] },
    modelCatalog: {
      alpha: { id: "alpha", name: "Alpha", models: providerModels("alpha", "03") },
      beta: { id: "beta", name: "Beta", models: providerModels("beta", "02") },
      gamma: { id: "gamma", name: "Gamma", models: providerModels("gamma", "01") },
    },
  }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.equal(result.json.models.length, 6)
    assert.deepEqual(
      Object.fromEntries(
        ["alpha", "beta", "gamma"].map((provider) => [
          provider,
          result.json.models.filter((model) => model.provider === provider).length,
        ]),
      ),
      { alpha: 2, beta: 2, gamma: 2 },
    )
  })
})

test("persisted choice is included as saved without replacing recommendation", async () => {
  const ids = [
    "atlas",
    "beacon",
    "comet",
    "delta",
    "ember",
    "fable",
    "glider",
    "harbor",
  ]
  const models = Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        id,
        name: id,
        reasoning: true,
        tool_call: true,
        release_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    ]),
  )

  await withFixture({
    modelCatalog: {
      alpha: { id: "alpha", name: "Alpha", models },
    },
  }, async (fx) => {
    await writeFile(fx.imageChoice, "alpha/atlas\n")
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.equal(result.json.recommendedModel, "alpha/harbor")

    const saved = result.json.models.find((model) => model.model === "alpha/atlas")
    assert.ok(saved)
    assert.equal(saved.savedChoice, true)
    assert.equal(saved.recommended, false)
    assert.match(saved.pickerDescription, /Saved choice/)
  })
})

test("--model validates against the full discovered set, not only the default picker", async () => {
  const ids = ["atlas", "beacon", "comet", "delta"]
  const models = Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        id,
        name: id,
        reasoning: true,
        tool_call: true,
        release_date: `2026-01-${String(index + 1).padStart(2, "0")}`,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    ]),
  )

  await withFixture({
    modelCatalog: {
      alpha: { id: "alpha", name: "Alpha", models },
    },
  }, async (fx) => {
    const list = await runVision(fx)
    assert.deepEqual(modelIDs(list), ["alpha/delta", "alpha/comet"])

    const saved = await runVision(fx, ["--model", "alpha/atlas"])
    assert.equal(saved.code, 0)
    assert.equal(saved.json.savedChoice.model, "alpha/atlas")
    assert.equal(await readFile(fx.imageChoice, "utf8"), "alpha/atlas\n")
  })
})

test("model selection persists image choice", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, ["--model", "alpha/image-only"])
    assert.equal(result.code, 0)
    assert.equal(result.json.saved, true)
    assert.equal(result.json.savedChoice.model, "alpha/image-only")
    assert.equal(result.json.persistedChoice.model, "alpha/image-only")
    assert.equal(await readFile(fx.imageChoice, "utf8"), "alpha/image-only\n")
  })
})

test("persisted choice is reported and the obsolete single choice file is ignored", async () => {
  await withFixture({}, async (fx) => {
    await writeFile(fx.obsoleteChoice, "alpha/image-audio\n")
    await writeFile(fx.imageChoice, "alpha/image-only\n")
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.equal(result.json.persistedChoice.model, "alpha/image-only")
  })
})

test("stale persisted choices are ignored", async () => {
  await withFixture({}, async (fx) => {
    await writeFile(fx.imageChoice, "alpha/text-only\n")
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.equal(result.json.persistedChoice, null)
  })
})

test("missing configured provider and no configured providers return warnings", async () => {
  await withFixture({
    modelCatalog: {},
    configObject: { enabled_providers: ["missing"] },
  }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.models, [])
    assert.match(result.json.warnings.join("\n"), /missing/)
  })

  await withFixture({ configObject: {} }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.models, [])
    assert.match(result.json.warnings.join("\n"), /No OpenCode provider configuration/)
  })
})

test("negative CLI cases exit nonzero without writes", async () => {
  await withFixture({}, async (fx) => {
    const oldListFlag = await runVision(fx, [["--", "me", "dia"].join(""), "image"])
    assert.notEqual(oldListFlag.code, 0)
    assert.match(oldListFlag.json.message, /Unknown argument/)

    const oldPairFlag = await runVision(fx, [["--", "me", "dia-type=image"].join(""), "--model", "alpha/image-only"])
    assert.notEqual(oldPairFlag.code, 0)
    assert.match(oldPairFlag.json.message, /Unknown argument/)

    const missingModelValue = await runVision(fx, ["--model"])
    assert.notEqual(missingModelValue.code, 0)

    const unknown = await runVision(fx, ["--model", "alpha/unknown"])
    assert.notEqual(unknown.code, 0)
    assert.equal(existsSync(fx.imageChoice), false)

    const textOnly = await runVision(fx, ["--model", "alpha/text-only"])
    assert.notEqual(textOnly.code, 0)
    assert.equal(existsSync(fx.imageChoice), false)
  })
})
