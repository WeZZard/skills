#!/usr/bin/env node

import {
  REPO_ROOT,
  findMarketplacePlugin,
  isGitSubdirSource,
  loadMarketplace,
  loadLock,
  loadWebsiteRegistry,
  normalizeLocalSource,
  parseArgs,
} from "./lib/catalog.mjs";

const args = parseArgs(process.argv.slice(2));

function resolveEntry(pluginName) {
  const marketplace = loadMarketplace();
  const registry = loadWebsiteRegistry();
  const lock = loadLock();
  const plugin = findMarketplacePlugin(marketplace, pluginName);
  const registryEntry = registry.plugins?.[pluginName] ?? null;
  const lockEntry = lock.plugins?.[pluginName] ?? null;

  let kind = "local";
  let localPath = null;
  let git = null;

  if (isGitSubdirSource(plugin.source)) {
    kind = "git-subdir";
    git = {
      repo: plugin.source.url,
      path: plugin.source.path ?? ".",
      ref: plugin.source.ref,
      sha: plugin.source.sha ?? lockEntry?.sha ?? null,
    };
  } else {
    localPath = normalizeLocalSource(plugin.source);
  }

  return {
    name: pluginName,
    kind,
    description: plugin.description,
    localPath,
    git,
    website: registryEntry?.website ?? false,
    lock: lockEntry,
  };
}

function main() {
  if (args._.length === 0 && !args.plugin) {
    const marketplace = loadMarketplace();
    const resolved = marketplace.plugins.map((entry) => resolveEntry(entry.name));
    console.log(JSON.stringify({ repoRoot: REPO_ROOT, plugins: resolved }, null, 2));
    return;
  }

  const pluginName = args.plugin ?? args._[0];
  const resolved = resolveEntry(pluginName);
  console.log(JSON.stringify(resolved, null, 2));
}

main();
