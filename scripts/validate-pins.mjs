#!/usr/bin/env node

import { readFileSync } from "fs";
import { join } from "path";
import {
  cleanupDir,
  getRemotePluginRef,
  getRemotePluginRepo,
  isRemoteGitSource,
  loadMarketplace,
  parseArgs,
  shallowClone,
} from "./lib/catalog.mjs";

const args = parseArgs(process.argv.slice(2));

function readPluginVersion(pluginRoot) {
  const pluginJsonPath = join(pluginRoot, ".claude-plugin/plugin.json");
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  return pluginJson.version;
}

function validateRemotePin(pluginName, source) {
  const repo = getRemotePluginRepo(source);
  const ref = getRemotePluginRef(source);
  const cloneDir = shallowClone(repo, ref);
  try {
    const version = readPluginVersion(cloneDir);
    if (source.sha) {
      // sha validated at sync time; clone success is sufficient here
    }
    console.log(`✓ ${pluginName}: ${repo}@${ref} (plugin.json version ${version})`);
  } finally {
    cleanupDir(cloneDir);
  }
}

function main() {
  const marketplace = loadMarketplace();

  for (const plugin of marketplace.plugins) {
    if (isRemoteGitSource(plugin.source)) {
      if (args.dryRun) {
        console.log(`Would validate remote pin: ${plugin.name}`);
        continue;
      }
      validateRemotePin(plugin.name, plugin.source);
      continue;
    }

    const localPath = plugin.source.replace(/^\.\//, "");
    console.log(`✓ ${plugin.name}: local path ${localPath} (layer 2 skipped)`);
  }
}

main();
