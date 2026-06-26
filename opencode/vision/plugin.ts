import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(
  readFileSync(join(__dirname, "vision-models.json"), "utf8")
)
const bodyTpl = readFileSync(join(__dirname, "subagent-body.md"), "utf8")

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