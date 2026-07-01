#!/usr/bin/env node

import { readFileSync } from "fs";
import { join } from "path";
import {
  bumpPatch,
  cleanupDir,
  findMarketplacePlugin,
  getRemoteSha,
  loadLock,
  loadMarketplace,
  parseArgs,
  saveLock,
  saveMarketplace,
  shallowClone,
} from "./lib/catalog.mjs";

const args = parseArgs(process.argv.slice(2));

function requireArg(name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function readPluginVersion(pluginRoot) {
  const pluginJsonPath = join(pluginRoot, ".claude-plugin/plugin.json");
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (!pluginJson.version) {
    throw new Error(`Missing version in ${pluginJsonPath}`);
  }
  return pluginJson.version;
}

function main() {
  const plugin = requireArg("plugin");
  const tag = requireArg("tag");
  const version = args.version ?? tag.replace(/^v/, "");
  const repo = args.repo ?? `WeZZard/${plugin}`;
  const releaseId = args.release_id ?? null;
  const expectedSha = args.sha ?? null;

  const marketplace = loadMarketplace();
  findMarketplacePlugin(marketplace, plugin);

  const sha = expectedSha ?? getRemoteSha(repo, tag);
  const cloneDir = shallowClone(repo, tag);

  try {
    const resolvedVersion = readPluginVersion(cloneDir);
    if (resolvedVersion !== version) {
      throw new Error(
        `Version mismatch for ${plugin}: payload=${version}, plugin.json=${resolvedVersion}`,
      );
    }

    const entry = findMarketplacePlugin(marketplace, plugin);
    entry.source = {
      source: "git-subdir",
      url: repo,
      path: ".",
      ref: tag,
      sha,
    };

    if (marketplace.version) {
      marketplace.version = bumpPatch(marketplace.version);
    } else {
      marketplace.version = "1.0.1";
    }

    const lock = loadLock();
    lock.generatedAt = new Date().toISOString();
    lock.plugins[plugin] = {
      repo,
      tag,
      sha,
      version: resolvedVersion,
      releaseId,
      resolvedAt: lock.generatedAt,
    };

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            plugin,
            tag,
            sha,
            version: resolvedVersion,
            marketplaceVersion: marketplace.version,
            source: entry.source,
            lockEntry: lock.plugins[plugin],
          },
          null,
          2,
        ),
      );
      return;
    }

    saveMarketplace(marketplace);
    saveLock(lock);
    console.log(`Synced ${plugin} to ${tag} (${sha})`);
  } finally {
    cleanupDir(cloneDir);
  }
}

main();
