#!/usr/bin/env node

import { join } from "path";
import {
  cleanupDir,
  findMarketplacePlugin,
  getRemotePluginRef,
  getRemotePluginRepo,
  isRemoteGitSource,
  loadMarketplace,
  loadWebsiteRegistry,
  normalizeLocalSource,
  parseArgs,
  shallowClone,
  writeJsonIfChanged,
  WORKFLOW_OUTPUT_DIR,
} from "./lib/catalog.mjs";
import { generateWorkflowDiagram } from "./lib/workflow-diagram.mjs";

const args = parseArgs(process.argv.slice(2));

function requireArg(name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function resolvePluginPath(pluginName) {
  const marketplace = loadMarketplace();
  const registry = loadWebsiteRegistry();
  const entry = findMarketplacePlugin(marketplace, pluginName);
  const registryEntry = registry.plugins?.[pluginName];

  if (!registryEntry?.website) {
    return { skip: true, reason: "not registered for website" };
  }

  if (isRemoteGitSource(entry.source)) {
    const cloneDir = shallowClone(
      getRemotePluginRepo(entry.source),
      getRemotePluginRef(entry.source),
    );
    return { skip: false, pluginPath: cloneDir, cleanup: cloneDir };
  }

  return {
    skip: false,
    pluginPath: normalizeLocalSource(entry.source),
    cleanup: null,
  };
}

function main() {
  const pluginName = requireArg("plugin");
  const resolved = resolvePluginPath(pluginName);

  if (resolved.skip) {
    console.log(`Skipped workflow update for ${pluginName}: ${resolved.reason}`);
    return;
  }

  try {
    const result = generateWorkflowDiagram(pluginName, resolved.pluginPath);
    if (result.skip) {
      console.log(`Skipped workflow update for ${pluginName}: ${result.reason}`);
      return;
    }

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            plugin: pluginName,
            pluginPath: resolved.pluginPath,
            sourceHash: result.output.sourceHash,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (writeJsonIfChanged(join(WORKFLOW_OUTPUT_DIR, `${pluginName}.json`), result.output)) {
      console.log(
        `Updated workflow JSON for ${pluginName} (hash ${result.output.sourceHash})`,
      );
    } else {
      console.log(`No workflow changes for ${pluginName} — sources unchanged`);
    }
  } finally {
    cleanupDir(resolved.cleanup);
  }
}

main();
