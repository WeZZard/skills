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

function modelIDs(result) {
  return result.json.models.map((model) => model.model)
}

test("lists image-capable models only", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
      "alpha/attachment-only",
      "alpha/image-audio",
      "alpha/image-only",
    ]))
    assert.equal(result.json.persistedChoice, null)
    assert.equal(result.json.choiceFile, fx.imageChoice)
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
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
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
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["alpha/image-audio"])
  })
})

test("saved OpenCode auth providers are treated as configured providers", async () => {
  await withFixture({
    configObject: {},
    authObject: {
      alpha: { type: "api", key: "redacted" },
    },
  }, async (fx) => {
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
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
    const result = await runVision(fx, [], { BETA_API_KEY: "redacted" })
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["beta/beta-image"])
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
    const result = await runVision(fx)
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["custom/alias"])
    assert.equal(result.json.models[0].subagentType, "vision-custom-alias")
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
