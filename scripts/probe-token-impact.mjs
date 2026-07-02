#!/usr/bin/env node

/**
 * Discover which automation secret is broken by triggering workflows and
 * watching which ones fail.
 *
 * Typical flow after revoking a suspect PAT:
 *   1. node scripts/probe-token-impact.mjs map
 *   2. node scripts/probe-token-impact.mjs trigger --leaf
 *   3. node scripts/probe-token-impact.mjs watch
 *   4. gh secret set <SECRET> --repo <repo>   # fix only the failed mapping
 *
 * Usage:
 *   node scripts/probe-token-impact.mjs map
 *   node scripts/probe-token-impact.mjs trigger [--leaf] [--skills] [--all]
 *   node scripts/probe-token-impact.mjs watch [--timeout 900]
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadMarketplace } from "./lib/catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATE_PATH = join(REPO_ROOT, ".probe-token-impact-runs.json");

const SKILLS_PROBES = [
  {
    id: "catalog-sync",
    repo: "WeZZard/skills",
    workflow: "catalog-sync.yml",
    secret: "CATALOG_SYNC_TOKEN",
    failsAt: "Create catalog sync PR (peter-evans/create-pull-request)",
    note: "May open a bot PR if the token works and pin drifts — close without merging.",
  },
  {
    id: "deploy-website",
    repo: "WeZZard/skills",
    workflow: "deploy-website.yml",
    secret: "CLOUDFLARE_API_TOKEN",
    failsAt: "Cloudflare Pages deploy step",
    note: "Safe manual dispatch; no catalog pin change.",
  },
  {
    id: "callback",
    repo: "WeZZard/skills",
    workflow: "catalog-sync.yml",
    secret: "PLUGIN_CALLBACK_TOKEN",
    failsAt: "Dispatch pr_opened callback (after PR created)",
    note: "Job may still succeed (continue-on-error). Check step logs for 401/403.",
  },
];

function parseArgs(argv) {
  const args = { _: [], leaf: false, skills: false, all: false, timeout: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--leaf") args.leaf = true;
    else if (arg === "--skills") args.skills = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--timeout") {
      args.timeout = Number(argv[i + 1]);
      i += 1;
    } else if (!arg.startsWith("--")) {
      args._.push(arg);
    }
  }
  return args;
}

function ghJson(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `gh ${args.join(" ")} failed`);
  }
  return JSON.parse(result.stdout);
}

function ghRun(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed`);
  }
}

function loadLeafProbes() {
  const marketplace = loadMarketplace();
  return marketplace.plugins.map((entry) => {
    const plugin = entry.name;
    const repo = entry.source.repo;
    const tag = entry.source.ref;
    const version = tag.replace(/^v/, "");
    const secretKey = plugin.toUpperCase().replace(/-/g, "_");
    const secret = `${secretKey}_RELEASE_TOKEN`;
    return {
      id: `release-${plugin}`,
      repo,
      workflow: "release.yml",
      secret,
      secretRepo: repo,
      tag,
      version,
      plugin,
      failsAt: "Create tag and release / Dispatch catalog sync",
      note: "Idempotent when tag exists — still exercises token for checkout, gh release, dispatch.",
    };
  });
}

function printMap() {
  const leaf = loadLeafProbes();
  console.log("Token impact map (workflow failure → secret to fix)\n");
  console.log("## Leaf plugins (start here)\n");
  console.log("| Trigger | Repo | Secret | Typical failure step |");
  console.log("|---------|------|--------|------------------------|");
  for (const p of leaf) {
    console.log(
      `| \`gh workflow run ${p.workflow} --repo ${p.repo} -f tag=${p.tag} -f version=${p.version}\` | ${p.repo} | \`${p.secret}\` | ${p.failsAt} |`,
    );
  }
  console.log("\n## Skills repo (after leaf, or when leaf all pass)\n");
  console.log("| Trigger | Secret | Typical failure step |");
  console.log("|---------|--------|------------------------|");
  for (const p of SKILLS_PROBES) {
    if (p.id === "callback") continue;
    const trigger =
      p.id === "catalog-sync"
        ? "`gh workflow run catalog-sync.yml --repo WeZZard/skills -f plugin=… -f tag=…`"
        : "`gh workflow run deploy-website.yml --repo WeZZard/skills`";
    console.log(`| ${trigger} | \`${p.secret}\` | ${p.failsAt} |`);
  }
  console.log(`\n| (indirect) catalog-sync callback step | \`PLUGIN_CALLBACK_TOKEN\` | ${SKILLS_PROBES.find((p) => p.id === "callback").failsAt} |`);
  console.log("\n## Fix a broken secret\n");
  console.log("```bash");
  console.log("gh secret set AMPLIFY_RELEASE_TOKEN --repo WeZZard/amplify --body-file -  # paste token, Ctrl-D");
  console.log("```");
  console.log("\n## Suggested discovery order\n");
  console.log("1. Revoke the suspect PAT in GitHub settings.");
  console.log("2. `node scripts/probe-token-impact.mjs trigger --leaf`");
  console.log("3. `node scripts/probe-token-impact.mjs watch`");
  console.log("4. If all leaf jobs pass, `trigger --skills` and watch again.");
  console.log("5. Update only the secret(s) tied to failed workflows.");
}

function triggerLeaf() {
  const probes = loadLeafProbes();
  const runs = [];
  for (const p of probes) {
    console.log(`Triggering ${p.repo} ${p.workflow} (${p.tag})…`);
    ghRun([
      "workflow",
      "run",
      p.workflow,
      "--repo",
      p.repo,
      "-f",
      `tag=${p.tag}`,
      "-f",
      `version=${p.version}`,
    ]);
    const listed = ghJson([
      "run",
      "list",
      "--repo",
      p.repo,
      "--workflow",
      p.workflow,
      "--limit",
      "1",
      "--json",
      "databaseId,status,conclusion,url",
    ]);
    const run = listed[0];
    runs.push({
      probeId: p.id,
      repo: p.repo,
      workflow: p.workflow,
      secret: p.secret,
      secretRepo: p.secretRepo,
      runId: run.databaseId,
      url: run.url,
    });
    console.log(`  → run ${run.databaseId} ${run.url}`);
  }
  return runs;
}

function triggerSkills() {
  const marketplace = loadMarketplace();
  const amplify = marketplace.plugins.find((p) => p.name === "amplify");
  const tag = amplify.source.ref;
  const version = tag.replace(/^v/, "");
  const runs = [];

  console.log(`Triggering catalog-sync for amplify ${tag}…`);
  ghRun([
    "workflow",
    "run",
    "catalog-sync.yml",
    "--repo",
    "WeZZard/skills",
    "-f",
    "plugin=amplify",
    "-f",
    `tag=${tag}`,
    "-f",
    `version=${version}`,
    "-f",
    "repo=WeZZard/amplify",
  ]);
  const catalogRun = ghJson([
    "run",
    "list",
    "--repo",
    "WeZZard/skills",
    "--workflow",
    "catalog-sync.yml",
    "--limit",
    "1",
    "--json",
    "databaseId,url",
  ])[0];
  runs.push({
    probeId: "catalog-sync",
    repo: "WeZZard/skills",
    workflow: "catalog-sync.yml",
    secret: "CATALOG_SYNC_TOKEN",
    secretRepo: "WeZZard/skills",
    runId: catalogRun.databaseId,
    url: catalogRun.url,
  });
  console.log(`  → run ${catalogRun.databaseId} ${catalogRun.url}`);

  console.log("Triggering deploy-website…");
  ghRun(["workflow", "run", "deploy-website.yml", "--repo", "WeZZard/skills"]);
  const deployRun = ghJson([
    "run",
    "list",
    "--repo",
    "WeZZard/skills",
    "--workflow",
    "deploy-website.yml",
    "--limit",
    "1",
    "--json",
    "databaseId,url",
  ])[0];
  runs.push({
    probeId: "deploy-website",
    repo: "WeZZard/skills",
    workflow: "deploy-website.yml",
    secret: "CLOUDFLARE_API_TOKEN",
    secretRepo: "WeZZard/skills",
    runId: deployRun.databaseId,
    url: deployRun.url,
  });
  console.log(`  → run ${deployRun.databaseId} ${deployRun.url}`);

  return runs;
}

function saveState(runs) {
  writeFileSync(STATE_PATH, `${JSON.stringify({ triggeredAt: new Date().toISOString(), runs }, null, 2)}\n`);
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No probe runs saved. Run: node scripts/probe-token-impact.mjs trigger …`);
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function watchRuns(timeoutSec) {
  const { runs } = loadState();
  const results = [];

  for (const entry of runs) {
    console.log(`\nWatching ${entry.repo} run ${entry.runId}…`);
    const watch = spawnSync(
      "gh",
      ["run", "watch", String(entry.runId), "--repo", entry.repo, "--exit-status"],
      { encoding: "utf8", timeout: timeoutSec * 1000 },
    );
    const ok = watch.status === 0;
    const detail = ghJson([
      "run",
      "view",
      String(entry.runId),
      "--repo",
      entry.repo,
      "--json",
      "conclusion,status,url,displayTitle",
    ]);
    results.push({ ...entry, ok, conclusion: detail.conclusion, title: detail.displayTitle });
  }

  console.log("\n════════════════════════════════════════");
  console.log("Probe results\n");
  const failed = [];
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`${mark}  ${r.probeId}`);
    console.log(`      ${r.url}`);
    console.log(`      secret: ${r.secret} (${r.secretRepo})`);
    if (!r.ok) failed.push(r);
  }

  if (failed.length === 0) {
    console.log("\nAll probed workflows passed. The revoked token may not be used by these paths,");
    console.log("or secrets were already updated. Check PLUGIN_CALLBACK_TOKEN in catalog-sync logs");
    console.log("(callback step uses continue-on-error).");
    return;
  }

  console.log("\n── Fix these secrets ──\n");
  for (const r of failed) {
    console.log(`${r.secret}  →  gh secret set ${r.secret} --repo ${r.secretRepo} --body-file -`);
  }
  console.log("\nRe-run trigger + watch after updating secrets to confirm recovery.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "map";

  if (command === "map") {
    printMap();
    return;
  }

  if (command === "trigger") {
    const leaf = args.leaf || args.all || (!args.leaf && !args.skills && !args.all);
    const skills = args.skills || args.all;
    const runs = [];
    if (leaf) runs.push(...triggerLeaf());
    if (skills) runs.push(...triggerSkills());
    saveState(runs);
    console.log(`\nSaved ${runs.length} run(s) to ${STATE_PATH}`);
    console.log("Next: node scripts/probe-token-impact.mjs watch");
    return;
  }

  if (command === "watch") {
    watchRuns(args.timeout);
    return;
  }

  console.error(`Unknown command: ${command}\nUsage: map | trigger [--leaf] [--skills] [--all] | watch`);
  process.exit(1);
}

main();
