#!/usr/bin/env node

/**
 * Register a plugin for website content generation.
 *
 * Usage:
 *   node scripts/register-plugin-website.mjs --plugin my-plugin --repo WeZZard/my-plugin
 */

import { loadWebsiteRegistry, parseArgs, saveWebsiteRegistry } from "./lib/catalog.mjs";

const args = parseArgs(process.argv.slice(2));

function requireArg(name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function main() {
  const plugin = requireArg("plugin");
  const repo = args.repo ?? `WeZZard/${plugin}`;
  const registry = loadWebsiteRegistry();

  if (!registry.plugins) {
    registry.plugins = {};
  }

  const existing = registry.plugins[plugin];
  if (existing?.website && existing.repo === repo) {
    console.log(`Plugin ${plugin} already registered for website (${repo})`);
    return;
  }

  registry.plugins[plugin] = {
    website: true,
    repo,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, plugin, repo, registry }, null, 2));
    return;
  }

  saveWebsiteRegistry(registry);
  console.log(`Registered ${plugin} for website (${repo})`);
}

main();
