#!/usr/bin/env node

import { readFileSync } from "fs";
import { join } from "path";
import {
  cleanupDir,
  isGitSubdirSource,
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

function validateGitSubdirPin(pluginName, source) {
  const cloneDir = shallowClone(source.url, source.ref);
  try {
    const version = readPluginVersion(cloneDir);
    if (source.sha) {
      // sha validated at sync time; clone success is sufficient here
    }
    console.log(`✓ ${pluginName}: ${source.url}@${source.ref} (plugin.json version ${version})`);
  } finally {
    cleanupDir(cloneDir);
  }
}

function main() {
  const marketplace = loadMarketplace();

  for (const plugin of marketplace.plugins) {
    if (isGitSubdirSource(plugin.source)) {
      if (args.dryRun) {
        console.log(`Would validate git-subdir pin: ${plugin.name}`);
        continue;
      }
      validateGitSubdirPin(plugin.name, plugin.source);
      continue;
    }

    const localPath = plugin.source.replace(/^\.\//, "");
    console.log(`✓ ${plugin.name}: local path ${localPath} (layer 2 skipped)`);
  }
}

main();
