#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  cleanupDir,
  discoverPluginSkills,
  findMarketplacePlugin,
  getRemotePluginRef,
  getRemotePluginRepo,
  isRemoteGitSource,
  loadMarketplace,
  loadWebsiteRegistry,
  normalizeLocalSource,
  parseArgs,
  shallowClone,
  writeJson,
  CATALOG_WEBSITE_DIR,
  PLUGINS_OUTPUT_DIR,
  SKILLS_OUTPUT_DIR,
  computeHash,
} from "./lib/catalog.mjs";
import {
  generateSkillContentWithLlm,
  isWebsiteLlmAvailable,
  skillTomlHasBasics,
} from "./lib/website-llm.mjs";
import { emitPluginToml, emitSkillsToml } from "./lib/website-toml.mjs";
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

async function resolveSkillEntry(skillName, pluginPath, skillsToml) {
  const skillToml = skillsToml.skills?.[skillName];
  if (skillTomlHasBasics(skillToml)) {
    return { entry: skillToml, generated: false };
  }

  const skillMdPath = join(pluginPath, "skills", skillName, "SKILL.md");
  const skillMdContent = readFileSync(skillMdPath, "utf8");

  if (!isWebsiteLlmAvailable()) {
    console.warn(
      `Skipping ${skillName}: missing skills TOML entry (install OpenCode + provider auth for LLM fallback)`,
    );
    return { entry: null, generated: false };
  }

  console.warn(
    `Skill ${skillName}: missing skills TOML entry — generating from SKILL.md via LLM`,
  );
  return {
    entry: await generateSkillContentWithLlm(skillName, skillMdContent),
    generated: true,
  };
}

function titleCaseName(name) {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Website TOML lives in catalog/website/ (human ruled). Resolution order:
// the catalog copy wins; a legacy copy inside the plugin repo is the
// fallback; and when neither exists the content is synthesized (plugin
// level: from the marketplace entry; skill level: from SKILL.md via LLM).
// Whatever was resolved from outside the catalog is persisted INTO the
// catalog, so the registration PR carries reviewable TOML and later runs
// are deterministic.
function resolvePluginToml(pluginName, pluginPath, marketplaceEntry) {
  const catalogPath = join(CATALOG_WEBSITE_DIR, `${pluginName}.plugin.toml`);
  if (existsSync(catalogPath)) {
    const raw = readFileSync(catalogPath, "utf8");
    return { pluginToml: TOML.parse(raw), pluginTomlRaw: raw };
  }
  const legacyPath = join(pluginPath, "website.plugin.toml");
  const pluginToml = existsSync(legacyPath)
    ? TOML.parse(readFileSync(legacyPath, "utf8"))
    : {
        display_name: titleCaseName(pluginName),
        tagline: marketplaceEntry.description ?? "",
        ...(isRemoteGitSource(marketplaceEntry.source)
          ? { repo: getRemotePluginRepo(marketplaceEntry.source) }
          : {}),
      };
  const pluginTomlRaw = emitPluginToml(pluginToml);
  mkdirSync(CATALOG_WEBSITE_DIR, { recursive: true });
  writeFileSync(catalogPath, pluginTomlRaw);
  console.log(`Wrote ${catalogPath}`);
  return { pluginToml, pluginTomlRaw };
}

async function generatePluginJson(pluginName, pluginPath, marketplace) {
  const marketplaceEntry = findMarketplacePlugin(marketplace, pluginName);
  const { pluginToml, pluginTomlRaw } = resolvePluginToml(
    pluginName,
    pluginPath,
    marketplaceEntry,
  );

  const catalogSkillsPath = join(
    CATALOG_WEBSITE_DIR,
    `${pluginName}.skills.toml`,
  );
  const legacySkillsPath = join(pluginPath, "website.skills.toml");
  const skillsFromCatalog = existsSync(catalogSkillsPath);
  let skillsToml = { skills: {} };
  if (skillsFromCatalog) {
    skillsToml = TOML.parse(readFileSync(catalogSkillsPath, "utf8"));
  } else if (existsSync(legacySkillsPath)) {
    skillsToml = TOML.parse(readFileSync(legacySkillsPath, "utf8"));
  }
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

  const resolvedSkills = {};
  let generatedAny = false;
  for (const skillName of skillNames) {
    const { entry: skillEntry, generated } = await resolveSkillEntry(
      skillName,
      pluginPath,
      skillsToml,
    );
    if (!skillEntry?.display_name) {
      console.warn(`Skipping ${skillName}: no website content available`);
      continue;
    }
    resolvedSkills[skillName] = skillEntry;
    if (generated) generatedAny = true;

    const skillOutput = {
      sourceHash: computeHash(JSON.stringify(skillEntry)),
      generatedAt: new Date().toISOString(),
      skill: {
        name: skillName,
        displayName: skillEntry.display_name,
        pluginName,
        tagline: skillEntry.tagline,
        shortSummary: skillEntry.short_summary,
        fullSummary: skillEntry.full_summary,
        highlights: skillEntry.highlights,
        workflow: { steps: skillEntry.workflow },
      },
    };

    writeJson(join(SKILLS_OUTPUT_DIR, `${skillName}.json`), skillOutput);
  }

  const haveSkillContent = Object.keys(resolvedSkills).length > 0;
  if (haveSkillContent && (!skillsFromCatalog || generatedAny)) {
    mkdirSync(CATALOG_WEBSITE_DIR, { recursive: true });
    writeFileSync(catalogSkillsPath, emitSkillsToml(resolvedSkills));
    console.log(`Wrote ${catalogSkillsPath}`);
  }

  return { skillCount: skillNames.length };
}

async function main() {
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

    const result = await generatePluginJson(
      pluginName,
      resolved.pluginPath,
      marketplace,
    );
    console.log(`Updated website JSON for ${pluginName} (${result.skillCount} skills)`);
  } finally {
    cleanupDir(resolved.cleanup);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
