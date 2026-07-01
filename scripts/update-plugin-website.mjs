#!/usr/bin/env node

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  cleanupDir,
  discoverPluginSkills,
  findMarketplacePlugin,
  isGitSubdirSource,
  loadMarketplace,
  loadWebsiteRegistry,
  normalizeLocalSource,
  parseArgs,
  shallowClone,
  writeJson,
  PLUGINS_OUTPUT_DIR,
  SKILLS_OUTPUT_DIR,
  computeHash,
} from "./lib/catalog.mjs";
import TOML from "toml";

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

  if (isGitSubdirSource(entry.source)) {
    const cloneDir = shallowClone(entry.source.url, entry.source.ref);
    return { skip: false, pluginPath: cloneDir, cleanup: cloneDir };
  }

  return {
    skip: false,
    pluginPath: normalizeLocalSource(entry.source),
    cleanup: null,
  };
}

function generatePluginJson(pluginName, pluginPath, marketplace) {
  const pluginTomlPath = join(pluginPath, "website.plugin.toml");
  const skillsTomlPath = join(pluginPath, "website.skills.toml");
  const pluginTomlRaw = readFileSync(pluginTomlPath, "utf8");
  const skillsTomlRaw = readFileSync(skillsTomlPath, "utf8");
  const pluginToml = TOML.parse(pluginTomlRaw);
  const skillsToml = TOML.parse(skillsTomlRaw);
  const skillNames = discoverPluginSkills(pluginPath);

  const ownerName = marketplace.owner.name;
  const marketplaceCommand = `/plugin marketplace add ${ownerName.toLowerCase()}/skills`;
  const installCommand = `/plugin install ${pluginName}@${marketplace.name}`;

  const pluginOutput = {
    sourceHash: computeHash(`${pluginTomlRaw}\n${skillNames.join(",")}`),
    generatedAt: new Date().toISOString(),
    plugin: {
      name: pluginName,
      displayName: pluginToml.display_name,
      tagline: pluginToml.tagline,
      ...(pluginToml.repo ? { repo: pluginToml.repo } : {}),
      skillCount: skillNames.length,
      skills: skillNames,
      marketplaceCommand,
      installCommand,
    },
  };

  writeJson(join(PLUGINS_OUTPUT_DIR, `${pluginName}.json`), pluginOutput);

  for (const skillName of skillNames) {
    const skillToml = skillsToml.skills?.[skillName];
    if (!skillToml?.display_name) {
      console.warn(`Skipping ${skillName}: missing website.skills.toml entry`);
      continue;
    }

    const skillOutput = {
      sourceHash: computeHash(JSON.stringify(skillToml)),
      generatedAt: new Date().toISOString(),
      skill: {
        name: skillName,
        displayName: skillToml.display_name,
        pluginName,
        tagline: skillToml.tagline,
        shortSummary: skillToml.short_summary,
        fullSummary: skillToml.full_summary,
        highlights: skillToml.highlights,
        workflow: { steps: skillToml.workflow },
      },
    };

    writeJson(join(SKILLS_OUTPUT_DIR, `${skillName}.json`), skillOutput);
  }

  return { skillCount: skillNames.length };
}

function main() {
  const pluginName = requireArg("plugin");
  const marketplace = loadMarketplace();
  const resolved = resolvePluginPath(pluginName);

  if (resolved.skip) {
    console.log(`Skipped website update for ${pluginName}: ${resolved.reason}`);
    return;
  }

  try {
    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            plugin: pluginName,
            pluginPath: resolved.pluginPath,
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = generatePluginJson(pluginName, resolved.pluginPath, marketplace);
    console.log(`Updated website JSON for ${pluginName} (${result.skillCount} skills)`);
  } finally {
    cleanupDir(resolved.cleanup);
  }
}

main();
