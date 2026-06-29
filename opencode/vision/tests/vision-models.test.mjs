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
        "video-only": {
          id: "video-only",
          name: "Video Only",
          reasoning: true,
          tool_call: true,
          release_date: "2026-01-02",
          modalities: { input: ["text", "video"], output: ["text"] },
        },
        "image-video": {
          id: "image-video",
          name: "Image Video",
          attachment: true,
          reasoning: true,
          tool_call: true,
          release_date: "2026-01-03",
          modalities: { input: ["text", "image", "video"], output: ["text"] },
        },
        "text-only": {
          id: "text-only",
          name: "Text Only",
          release_date: "2026-01-04",
          modalities: { input: ["text"], output: ["text"] },
        },
        "attachment-only": {
          id: "attachment-only",
          name: "Attachment Only",
          attachment: true,
          release_date: "2026-01-05",
        },
        "deprecated-video": {
          id: "deprecated-video",
          name: "Deprecated Video",
          status: "deprecated",
          release_date: "2026-01-06",
          modalities: { input: ["text", "video"], output: ["text"] },
        },
      },
    },
    beta: {
      id: "beta",
      name: "Beta",
      models: {
        "beta-image": {
          id: "beta-image",
          name: "Beta Image",
          release_date: "2026-01-07",
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
  }
}

async function fixture({ configText, configObject, modelCatalog = catalog() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vision-models-test-"))
  const configDir = join(root, "config")
  const projectDir = join(root, "project")
  const modelsFile = join(root, "models.json")
  await mkdir(configDir)
  await mkdir(projectDir)
  await writeFile(modelsFile, JSON.stringify(modelCatalog, null, 2))
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
    projectDir,
    modelsFile,
    imageChoice: join(configDir, "vision-model-image.txt"),
    videoChoice: join(configDir, "vision-model-video.txt"),
    obsoleteChoice: join(configDir, ["vision", "model"].join("-") + ".txt"),
  }
}

async function runVision(fx, args = []) {
  const env = { ...process.env }
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_MODELS_PATH",
    "VISION_MODEL_FILE",
  ]) {
    delete env[key]
  }
  const allArgs = [
    scriptPath,
    "--config-dir",
    fx.configDir,
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

test("--media image returns image-capable models only", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
      "alpha/attachment-only",
      "alpha/image-only",
      "alpha/image-video",
    ]))
    assert.equal(result.json.requestedMedia.length, 1)
    assert.equal(result.json.requestedMedia[0], "image")
  })
})

test("--media video returns video-capable models only", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, ["--media", "video"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
      "alpha/video-only",
      "alpha/image-video",
    ]))
  })
})

test("comma-separated and repeated --media require all media types", async () => {
  await withFixture({}, async (fx) => {
    const comma = await runVision(fx, ["--media", "image,video"])
    const repeated = await runVision(fx, ["--media", "image", "--media", "video"])
    assert.equal(comma.code, 0)
    assert.equal(repeated.code, 0)
    assert.deepEqual(modelIDs(comma), ["alpha/image-video"])
    assert.deepEqual(modelIDs(repeated), ["alpha/image-video"])
    assert.deepEqual(comma.json.requestedMedia, ["image", "video"])
  })
})

test("enabled_providers, disabled_providers, whitelist, and blacklist are honored", async () => {
  await withFixture({
    configObject: {
      enabled_providers: ["alpha", "beta"],
      disabled_providers: ["beta"],
      provider: {
        alpha: {
          whitelist: ["image-only", "image-video", "attachment-only"],
          blacklist: ["image-only"],
        },
      },
    },
  }, async (fx) => {
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(new Set(modelIDs(result)), new Set([
      "alpha/attachment-only",
      "alpha/image-video",
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
          "whitelist": ["image-video",],
        },
      },
    }`,
  }, async (fx) => {
    const result = await runVision(fx, ["--media", "image,video"])
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["alpha/image-video"])
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
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(modelIDs(result), ["custom/alias"])
    assert.equal(result.json.models[0].subagentType, "vision-custom-alias")
  })
})

test("media/model pairs persist image and video choices", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, [
      "--media-type=image",
      "--model",
      "alpha/image-only",
      "--media-type=video",
      "--model",
      "alpha/video-only",
    ])
    assert.equal(result.code, 0)
    assert.equal(result.json.saved, true)
    assert.equal(await readFile(fx.imageChoice, "utf8"), "alpha/image-only\n")
    assert.equal(await readFile(fx.videoChoice, "utf8"), "alpha/video-only\n")
  })
})

test("persisted choices are reported and the obsolete single choice file is ignored", async () => {
  await withFixture({}, async (fx) => {
    await writeFile(fx.obsoleteChoice, "alpha/image-video\n")
    await writeFile(fx.imageChoice, "alpha/image-only\n")
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.equal(result.json.persistedChoices.image.model, "alpha/image-only")
    assert.equal(result.json.persistedChoices.video, undefined)
  })
})

test("stale persisted choices are ignored", async () => {
  await withFixture({}, async (fx) => {
    await writeFile(fx.imageChoice, "alpha/text-only\n")
    await writeFile(fx.videoChoice, "alpha/image-only\n")
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.persistedChoices, {})
  })
})

test("missing configured provider and no configured providers return warnings", async () => {
  await withFixture({
    modelCatalog: {},
    configObject: { enabled_providers: ["missing"] },
  }, async (fx) => {
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.models, [])
    assert.match(result.json.warnings.join("\n"), /missing/)
  })

  await withFixture({ configObject: {} }, async (fx) => {
    const result = await runVision(fx, ["--media", "image"])
    assert.equal(result.code, 0)
    assert.deepEqual(result.json.models, [])
    assert.match(result.json.warnings.join("\n"), /No explicit provider config/)
  })
})

test("negative CLI cases exit nonzero without writes", async () => {
  await withFixture({}, async (fx) => {
    const invalidMedia = await runVision(fx, ["--media", "audio"])
    assert.notEqual(invalidMedia.code, 0)
    assert.match(invalidMedia.json.message, /image, video/)

    const incomplete = await runVision(fx, ["--media-type=image"])
    assert.notEqual(incomplete.code, 0)

    const unknown = await runVision(fx, ["--media-type=image", "--model", "alpha/unknown"])
    assert.notEqual(unknown.code, 0)
    assert.equal(existsSync(fx.imageChoice), false)

    const mismatched = await runVision(fx, ["--media-type=video", "--model", "alpha/image-only"])
    assert.notEqual(mismatched.code, 0)
    assert.equal(existsSync(fx.videoChoice), false)
  })
})

test("invalid multi-pair persistence writes no partial files", async () => {
  await withFixture({}, async (fx) => {
    const result = await runVision(fx, [
      "--media-type=image",
      "--model",
      "alpha/image-only",
      "--media-type=video",
      "--model",
      "alpha/image-only",
    ])
    assert.notEqual(result.code, 0)
    assert.equal(existsSync(fx.imageChoice), false)
    assert.equal(existsSync(fx.videoChoice), false)
  })
})
