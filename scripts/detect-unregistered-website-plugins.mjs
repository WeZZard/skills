#!/usr/bin/env node

/**
 * Print, one per line as "<plugin> <repo>", every marketplace plugin that has
 * NO entry in the website registry — the candidates the auto-registration
 * workflow dispatches Register Plugin Website for.
 *
 * A plugin whose registry entry exists with `website: false` is an explicit
 * opt-out and is never printed; only a fully absent key counts as new.
 */

import {
  getRemotePluginRepo,
  isRemoteGitSource,
  loadMarketplace,
  loadWebsiteRegistry,
} from "./lib/catalog.mjs";

const marketplace = loadMarketplace();
const registry = loadWebsiteRegistry();

for (const entry of marketplace.plugins) {
  if (registry.plugins?.[entry.name] !== undefined) continue;
  const repo = isRemoteGitSource(entry.source)
    ? getRemotePluginRepo(entry.source)
    : `WeZZard/${entry.name}`;
  console.log(`${entry.name} ${repo}`);
}
