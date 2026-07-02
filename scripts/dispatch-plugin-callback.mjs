#!/usr/bin/env node

/**
 * Dispatch catalog-sync-complete to a plugin repository.
 *
 * Usage:
 *   node scripts/dispatch-plugin-callback.mjs \
 *     --repo WeZZard/amplify --plugin amplify --tag v1.2.63 \
 *     --status pr_opened --release_id UUID --sha ABC \
 *     --pr_url https://... --preview_url https://...
 */

import { parseArgs as parseCatalogArgs } from "./lib/catalog.mjs";

const args = parseCatalogArgs(process.argv.slice(2));

function requireArg(name) {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function main() {
  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, args }, null, 2));
    return Promise.resolve();
  }

  const repo = requireArg("repo");
  const plugin = requireArg("plugin");
  const tag = requireArg("tag");
  const status = requireArg("status");
  const token = process.env.PLUGIN_CALLBACK_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("PLUGIN_CALLBACK_TOKEN or GH_TOKEN is required");
  }

  const payload = {
    event_type: "catalog-sync-complete",
    client_payload: {
      plugin,
      tag,
      status,
      release_id: args.release_id ?? "",
      sha: args.sha ?? "",
      pr_url: args.pr_url ?? "",
      preview_url: args.preview_url ?? "",
    },
  };

  const response = fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  return response.then(async (res) => {
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Dispatch failed (${res.status}): ${body}`);
    }
    console.log(`Dispatched catalog-sync-complete to ${repo} status=${status}`);
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
