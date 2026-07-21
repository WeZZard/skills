#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
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
  writeJsonIfChanged,
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
import {
  canonicalPluginContent,
  canonicalSkillContent,
  fingerprintPluginToml,
  fingerprintSkillEntry,
} from "./lib/website-content.mjs";
import TOML from "toml";

function requireArg(args, name) {
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





// Resolve one skill's TOML entry.
//   entry absent                          → generate via Pi, stamp hashes
//   entry hand-edited (content drifted)   → preserve; warn when SKILL.md moved
//   machine entry, SKILL.md unchanged     → keep as-is (zero diff)
//   machine entry, SKILL.md drifted       → regenerate via Pi, restamp
async function resolveSkillEntry(
  skillName,
  pluginPath,
  skillsToml,
  {
    isLlmAvailable = isWebsiteLlmAvailable,
    generateSkillContent = generateSkillContentWithLlm,
  } = {},
) {
  const skillMdPath = join(pluginPath, "skills", skillName, "SKILL.md");
  const skillMdContent = readFileSync(skillMdPath, "utf8");
  const sourceHash = computeHash(skillMdContent);
  const existing = skillsToml.skills?.[skillName];

  if (skillTomlHasBasics(existing)) {
    const handEdited =
      !existing.content_hash ||
      fingerprintSkillEntry(existing) !== existing.content_hash;
    if (handEdited) {
      if (existing.source_hash && existing.source_hash !== sourceHash) {
        console.warn(
          `Skill ${skillName}: SKILL.md changed but the entry is hand-edited — preserving it; update the copy manually if it went stale`,
        );
      }
      return { entry: existing, changed: false };
    }
    if (existing.source_hash === sourceHash) {
      return { entry: existing, changed: false };
    }
    console.warn(
      `Skill ${skillName}: SKILL.md changed — regenerating the entry via Pi`,
    );
  }

  if (!isLlmAvailable()) {
    throw new Error(
      `Pi CLI is required to generate website content for ${skillName}`,
    );
  }

  if (!skillTomlHasBasics(existing)) {
    console.warn(
      `Skill ${skillName}: missing skills TOML entry — generating from SKILL.md via Pi`,
    );
  }
  const generated = canonicalSkillContent(
    await generateSkillContent(skillName, skillMdContent),
  );
  const entry = {
    ...generated,
    source_hash: sourceHash,
    content_hash: fingerprintSkillEntry(generated),
  };
  return { entry, changed: true };
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
// level: from the marketplace entry, deterministically; skill level: from
// SKILL.md via the bounded Pi agent in the site-building worker). Whatever was resolved
// from outside the catalog is persisted INTO the catalog, so the
// registration PR carries reviewable TOML and later runs are deterministic.
function resolvePluginToml(
  pluginName,
  pluginPath,
  marketplaceEntry,
  catalogWebsiteDir,
) {
  const catalogPath = join(catalogWebsiteDir, `${pluginName}.plugin.toml`);
  const repo = isRemoteGitSource(marketplaceEntry.source)
    ? getRemotePluginRepo(marketplaceEntry.source)
    : undefined;
  const sourceHash = computeHash(
    JSON.stringify({
      name: pluginName,
      description: marketplaceEntry.description ?? "",
      repo: repo ?? "",
    }),
  );

  const synthesize = () => {
    const content = {
      display_name: titleCaseName(pluginName),
      tagline: marketplaceEntry.description ?? "",
      ...(repo ? { repo } : {}),
    };
    return {
      ...content,
      source_hash: sourceHash,
      content_hash: fingerprintPluginToml(content),
    };
  };

  const persist = (pluginToml) => {
    const pluginTomlRaw = emitPluginToml(pluginToml);
    mkdirSync(catalogWebsiteDir, { recursive: true });
    writeFileSync(catalogPath, pluginTomlRaw);
    console.log(`Wrote ${catalogPath}`);
    return { pluginToml, pluginTomlRaw };
  };

  if (existsSync(catalogPath)) {
    const raw = readFileSync(catalogPath, "utf8");
    const existing = TOML.parse(raw);
    const handEdited =
      !existing.content_hash ||
      fingerprintPluginToml(existing) !== existing.content_hash;
    if (handEdited) {
      if (existing.source_hash && existing.source_hash !== sourceHash) {
        console.warn(
          `Plugin ${pluginName}: marketplace identity changed but the plugin TOML is hand-edited — preserving it`,
        );
      }
      return { pluginToml: existing, pluginTomlRaw: raw };
    }
    if (existing.source_hash === sourceHash) {
      return { pluginToml: existing, pluginTomlRaw: raw };
    }
    console.warn(
      `Plugin ${pluginName}: marketplace identity changed — re-synthesizing the plugin TOML`,
    );
    return persist(synthesize());
  }

  const legacyPath = join(pluginPath, "website.plugin.toml");
  if (existsSync(legacyPath)) {
    // Migrated content is human-authored: persist without hashes so it
    // counts as hand-edited and is never regenerated.
    return persist(TOML.parse(readFileSync(legacyPath, "utf8")));
  }
  return persist(synthesize());
}

function removeUnpublishedSkillJson(
  pluginName,
  publishedSkillNames,
  skillsOutputDir,
) {
  if (!existsSync(skillsOutputDir)) return [];

  const published = new Set(publishedSkillNames);
  const removed = [];
  for (const entry of readdirSync(skillsOutputDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const skillName = entry.name.slice(0, -".json".length);
    if (published.has(skillName)) continue;

    const outputPath = join(skillsOutputDir, entry.name);
    let output;
    try {
      output = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch {
      // An unreadable file cannot prove ownership. Preserve it for review.
      continue;
    }
    if (output?.skill?.pluginName !== pluginName) continue;

    rmSync(outputPath);
    removed.push(skillName);
    console.log(`Removed unpublished website skill ${outputPath}`);
  }
  return removed.sort();
}

export async function generatePluginJson(
  pluginName,
  pluginPath,
  marketplace,
  {
    catalogWebsiteDir = CATALOG_WEBSITE_DIR,
    pluginsOutputDir = PLUGINS_OUTPUT_DIR,
    skillsOutputDir = SKILLS_OUTPUT_DIR,
    isLlmAvailable = isWebsiteLlmAvailable,
    generateSkillContent = generateSkillContentWithLlm,
  } = {},
) {
  const marketplaceEntry = findMarketplacePlugin(marketplace, pluginName);
  const { pluginToml, pluginTomlRaw } = resolvePluginToml(
    pluginName,
    pluginPath,
    marketplaceEntry,
    catalogWebsiteDir,
  );

  const catalogSkillsPath = join(
    catalogWebsiteDir,
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
  const publishedSkills = new Set(skillNames);
  const removedTomlSkills = Object.keys(skillsToml.skills ?? {})
    .filter((skillName) => !publishedSkills.has(skillName))
    .sort();

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

  let wroteAnything = writeJsonIfChanged(
    join(pluginsOutputDir, `${pluginName}.json`),
    pluginOutput,
  );

  const resolvedSkills = {};
  let anyEntryChanged = false;
  for (const skillName of skillNames) {
    const { entry: skillEntry, changed } = await resolveSkillEntry(
      skillName,
      pluginPath,
      skillsToml,
      { isLlmAvailable, generateSkillContent },
    );
    if (!skillEntry?.display_name) {
      console.warn(`Skipping ${skillName}: no website content available`);
      continue;
    }
    resolvedSkills[skillName] = skillEntry;
    if (changed) anyEntryChanged = true;

    const skillOutput = {
      // Canonical fingerprint: a fresh entry and its TOML round-trip carry
      // different key orders, and raw JSON.stringify would churn the hash.
      sourceHash: fingerprintSkillEntry(skillEntry),
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

    if (
      writeJsonIfChanged(join(skillsOutputDir, `${skillName}.json`), skillOutput)
    ) {
      wroteAnything = true;
    }
  }

  const haveSkillContent = Object.keys(resolvedSkills).length > 0;
  const shouldPersistSkills = skillsFromCatalog
    ? anyEntryChanged || removedTomlSkills.length > 0
    : haveSkillContent;
  if (shouldPersistSkills) {
    mkdirSync(catalogWebsiteDir, { recursive: true });
    writeFileSync(catalogSkillsPath, emitSkillsToml(resolvedSkills));
    console.log(`Wrote ${catalogSkillsPath}`);
    wroteAnything = true;
  }

  const removedSkillJson = removeUnpublishedSkillJson(
    pluginName,
    skillNames,
    skillsOutputDir,
  );
  if (removedSkillJson.length > 0) wroteAnything = true;

  return {
    skillCount: skillNames.length,
    wroteAnything,
    removedTomlSkills,
    removedSkillJson,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pluginName = requireArg(args, "plugin");
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
    if (result.wroteAnything) {
      console.log(
        `Updated website content for ${pluginName} (${result.skillCount} skills)`,
      );
    } else {
      console.log(
        `No website changes for ${pluginName} — sources unchanged (${result.skillCount} skills)`,
      );
    }
  } finally {
    cleanupDir(resolved.cleanup);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(error?.name === "SiteBuildingWindowError" ? 75 : 1);
  });
}
