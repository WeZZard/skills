#!/usr/bin/env node

/**
 * Opt a plugin's existing website TOML entries into machine ownership
 * WITHOUT changing their content: stamp each skills entry with source_hash
 * (the pinned SKILL.md it corresponds to) and content_hash (its own current
 * content). From then on the drift rules in update-plugin-website.mjs
 * govern the entry — unchanged SKILL.md means zero diff; a drifted SKILL.md
 * regenerates the entry via Pi in the site-building PR. A later hand edit
 * re-locks the entry automatically (content_hash mismatch).
 *
 * Plugin-level TOML is NOT adopted by default: legacy taglines are crafted
 * brand copy, and machine ownership would re-synthesize them from the
 * marketplace description on identity drift. Pass --include-plugin-toml
 * (as the last argument) to adopt it anyway.
 *
 * Usage: node scripts/adopt-plugin-content.mjs --plugin <name> [--include-plugin-toml]
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  cleanupDir,
  findMarketplacePlugin,
  getRemotePluginRef,
  getRemotePluginRepo,
  isRemoteGitSource,
  loadMarketplace,
  parseArgs,
  shallowClone,
  computeHash,
  CATALOG_WEBSITE_DIR,
} from "./lib/catalog.mjs";
import {
  canonicalPluginContent,
  canonicalSkillContent,
  fingerprintPluginToml,
  fingerprintSkillEntry,
} from "./lib/website-content.mjs";
import { emitPluginToml, emitSkillsToml } from "./lib/website-toml.mjs";
import TOML from "toml";

const args = parseArgs(process.argv.slice(2));
const plugin = args.plugin;
if (!plugin) {
  console.error("usage: adopt-plugin-content.mjs --plugin <name> [--include-plugin-toml]");
  process.exit(64);
}

const marketplace = loadMarketplace();
const entry = findMarketplacePlugin(marketplace, plugin);
if (!isRemoteGitSource(entry.source)) {
  console.error(`${plugin}: non-github source — adopt manually`);
  process.exit(1);
}

const cloneDir = shallowClone(
  getRemotePluginRepo(entry.source),
  getRemotePluginRef(entry.source),
);
try {
  const skillsPath = join(CATALOG_WEBSITE_DIR, `${plugin}.skills.toml`);
  if (!existsSync(skillsPath)) {
    console.error(`${plugin}: no catalog skills TOML to adopt`);
    process.exit(1);
  }
  const skillsToml = TOML.parse(readFileSync(skillsPath, "utf8"));
  const out = {};
  let adopted = 0;
  let kept = 0;
  for (const [name, skillEntry] of Object.entries(skillsToml.skills ?? {})) {
    const mdPath = join(cloneDir, "skills", name, "SKILL.md");
    if (!existsSync(mdPath)) {
      console.warn(
        `${plugin}/${name}: no SKILL.md in the pinned clone — left hand-owned`,
      );
      out[name] = skillEntry;
      kept += 1;
      continue;
    }
    const canonical = canonicalSkillContent(skillEntry);
    out[name] = {
      ...canonical,
      source_hash: computeHash(readFileSync(mdPath, "utf8")),
      content_hash: fingerprintSkillEntry(canonical),
    };
    adopted += 1;
  }
  writeFileSync(skillsPath, emitSkillsToml(out));
  console.log(
    `${plugin}: adopted ${adopted} skill entries${kept ? `, ${kept} left hand-owned` : ""}`,
  );

  if ("include-plugin-toml" in args) {
    const pluginPath = join(CATALOG_WEBSITE_DIR, `${plugin}.plugin.toml`);
    const pluginToml = TOML.parse(readFileSync(pluginPath, "utf8"));
    const canonical = canonicalPluginContent(pluginToml);
    writeFileSync(
      pluginPath,
      emitPluginToml({
        ...canonical,
        source_hash: computeHash(
          JSON.stringify({
            name: plugin,
            description: entry.description ?? "",
            repo: getRemotePluginRepo(entry.source),
          }),
        ),
        content_hash: fingerprintPluginToml(canonical),
      }),
    );
    console.log(`${plugin}: plugin TOML adopted`);
  }
} finally {
  cleanupDir(cloneDir);
}
