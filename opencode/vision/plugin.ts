import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

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
})

export default { id: "vision", server: plugin }