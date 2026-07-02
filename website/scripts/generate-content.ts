import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import TOML from "toml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

const PLUGINS_DIR = join(__dirname, "../../claude");
const MARKETPLACE_JSON = join(__dirname, "../../.claude-plugin/marketplace.json");
const PLUGINS_OUTPUT_DIR = join(__dirname, "../src/content/generated/plugins");
const SKILLS_OUTPUT_DIR = join(__dirname, "../src/content/generated/skills");

// Ensure output directories exist
mkdirSync(PLUGINS_OUTPUT_DIR, { recursive: true });
mkdirSync(SKILLS_OUTPUT_DIR, { recursive: true });

// --- Types ---

interface MarketplaceConfig {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; description: string }>;
}

interface PluginTomlConfig {
  display_name: string;
  tagline: string;
  repo?: string;
}

interface SkillTomlEntry {
  display_name: string;
  tagline: string;
  short_summary: string;
  full_summary: string;
  highlights: Array<{ title: string; description: string }>;
  workflow: Array<{ name: string; description: string; details?: string }>;
}

interface SkillsTomlConfig {
  skills: Record<string, SkillTomlEntry>;
}

interface PluginGenerated {
  sourceHash: string;
  generatedAt: string;
  plugin: {
    name: string;
    displayName: string;
    tagline: string;
    repo?: string;
    skillCount: number;
    skills: string[];
    marketplaceCommand: string;
    installCommand: string;
  };
}

interface SkillGenerated {
  sourceHash: string;
  generatedAt: string;
  skill: {
    name: string;
    displayName: string;
    pluginName: string;
    tagline: string;
    shortSummary: string;
    fullSummary: string;
    highlights: Array<{ title: string; description: string }>;
    workflow: {
      steps: Array<{ name: string; description: string; details?: string }>;
    };
  };
}

// --- Utility functions ---

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getExistingHash(outputPath: string): string | null {
  if (!existsSync(outputPath)) return null;
  try {
    const existing = JSON.parse(readFileSync(outputPath, "utf-8"));
    return existing.sourceHash || null;
  } catch {
    return null;
  }
}

function loadMarketplaceConfig(): MarketplaceConfig {
  const content = readFileSync(MARKETPLACE_JSON, "utf-8");
  return JSON.parse(content);
}

// --- Plugin/Skill discovery ---

function discoverPlugins(): Array<{ name: string; path: string; skillNames: string[] }> {
  const plugins: Array<{ name: string; path: string; skillNames: string[] }> = [];

  if (!existsSync(PLUGINS_DIR)) {
    return plugins;
  }

  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginPath = join(PLUGINS_DIR, entry.name);
    const pluginTomlPath = join(pluginPath, "website.plugin.toml");

    if (!existsSync(pluginTomlPath)) continue;

    // Discover skills for this plugin
    const skillsDir = join(pluginPath, "skills");
    const skillNames: string[] = [];

    if (existsSync(skillsDir)) {
      const skillEntries = readdirSync(skillsDir, { withFileTypes: true });
      for (const skillEntry of skillEntries) {
        if (skillEntry.isDirectory()) {
          const skillMdPath = join(skillsDir, skillEntry.name, "SKILL.md");
          if (existsSync(skillMdPath)) {
            skillNames.push(skillEntry.name);
          }
        }
      }
    }

    plugins.push({
      name: entry.name,
      path: pluginPath,
      skillNames: skillNames.sort(),
    });
  }

  return plugins;
}

// --- AI generation for skill website content ---

/**
 * Generates website content for a skill using OpenCode.
 */
function generateSkillContent(skillName: string, skillMdPath: string): SkillTomlEntry {
  const script = join(REPO_ROOT, "scripts/opencode-generate-skill.mjs");
  const output = execSync(
    `node "${script}" --skill "${skillName}" --skill-md-file "${skillMdPath}"`,
    { encoding: "utf-8", cwd: REPO_ROOT },
  );
  const result = JSON.parse(output.trim());
  return {
    display_name: result.display_name,
    tagline: result.tagline,
    short_summary: result.short_summary,
    full_summary: result.full_summary,
    highlights: result.highlights,
    workflow: result.workflow,
  };
}

/**
 * Serializes a SkillTomlEntry and appends it to the skills TOML file.
 */
function appendSkillToToml(skillsTomlPath: string, skillName: string, entry: SkillTomlEntry): void {
  let block = `\n[skills.${skillName}]\n`;
  block += `display_name = ${JSON.stringify(entry.display_name)}\n`;
  block += `tagline = ${JSON.stringify(entry.tagline)}\n`;
  block += `short_summary = ${JSON.stringify(entry.short_summary)}\n`;
  block += `full_summary = ${JSON.stringify(entry.full_summary)}\n`;

  for (const highlight of entry.highlights) {
    block += `\n[[skills.${skillName}.highlights]]\n`;
    block += `title = ${JSON.stringify(highlight.title)}\n`;
    block += `description = ${JSON.stringify(highlight.description)}\n`;
  }

  for (const step of entry.workflow) {
    block += `\n[[skills.${skillName}.workflow]]\n`;
    block += `name = ${JSON.stringify(step.name)}\n`;
    block += `description = ${JSON.stringify(step.description)}\n`;
    if (step.details) {
      block += `details = ${JSON.stringify(step.details)}\n`;
    }
  }

  appendFileSync(skillsTomlPath, block);
}

/**
 * Checks for skills that exist on disk but are missing from website.skills.toml,
 * and generates content for them via OpenCode.
 * Returns true if any new content was generated (so the caller can re-read the TOML).
 */
async function generateMissingSkillContent(
  plugin: { name: string; path: string; skillNames: string[] },
  skillsTomlPath: string,
  skillsToml: SkillsTomlConfig,
): Promise<boolean> {
  const missingSkills: string[] = [];
  for (const skillName of plugin.skillNames) {
    const entry = skillsToml.skills?.[skillName];
    if (!entry || !entry.display_name || !entry.tagline || !entry.full_summary) {
      missingSkills.push(skillName);
    }
  }

  if (missingSkills.length === 0) {
    return false;
  }

  console.log(`  ⚡ Found ${missingSkills.length} skill(s) missing from website.skills.toml: ${missingSkills.join(", ")}`);

  try {
    execSync("opencode --version", { stdio: "ignore" });
  } catch {
    console.log(
      "  ℹ OpenCode CLI not available — skipping LLM content generation.\n" +
      "    Install OpenCode and configure provider auth to generate missing entries.\n" +
      "    Skills without content will be omitted from the website: " + missingSkills.join(", "),
    );
    return false;
  }

  let generated = false;

  for (const skillName of missingSkills) {
    const skillMdPath = join(plugin.path, "skills", skillName, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      console.error(`  ✗ ${skillName}: SKILL.md not found`);
      continue;
    }

    console.log(`  ⟳ ${skillName}: generating content via OpenCode...`);
    try {
      const entry = generateSkillContent(skillName, skillMdPath);
      appendSkillToToml(skillsTomlPath, skillName, entry);
      console.log(`  ✓ ${skillName}: generated and appended to website.skills.toml`);
      generated = true;
    } catch (error) {
      console.error(`  ✗ ${skillName}: generation failed -`, error);
    }
  }

  return generated;
}

// --- Main ---

async function main() {
  const marketplaceConfig = loadMarketplaceConfig();
  const plugins = discoverPlugins();
  console.log(`Found ${plugins.length} plugin(s) to process\n`);

  for (const plugin of plugins) {
    console.log(`\n📦 Plugin: ${plugin.name} (${plugin.skillNames.length} skills)`);

    // --- Ensure TOML configs exist ---
    const pluginTomlPath = join(plugin.path, "website.plugin.toml");
    const skillsTomlPath = join(plugin.path, "website.skills.toml");

    if (!existsSync(pluginTomlPath)) {
      console.error(`  ✗ Missing ${pluginTomlPath}`);
      continue;
    }

    // Create skills TOML if it doesn't exist
    if (!existsSync(skillsTomlPath)) {
      writeFileSync(skillsTomlPath,
        `# ${plugin.name} - Skills Configuration\n` +
        `# This file configures skill display content on the website\n`
      );
      console.log(`  ℹ Created empty ${skillsTomlPath}`);
    }

    // --- Generate missing skill content (any plugin) via DeepSeek ---
    {
      const earlyTomlRaw = readFileSync(skillsTomlPath, "utf-8");
      const earlyToml = TOML.parse(earlyTomlRaw) as unknown as SkillsTomlConfig;
      if (!earlyToml.skills) {
        (earlyToml as any).skills = {};
      }

      const didGenerate = await generateMissingSkillContent(plugin, skillsTomlPath, earlyToml);
      if (didGenerate) {
        console.log(`  ℹ Re-reading website.skills.toml after generation...`);
      }
    }

    // --- Read TOML (may have been updated by generation above) ---
    const pluginTomlRaw = readFileSync(pluginTomlPath, "utf-8");
    const skillsTomlRaw = readFileSync(skillsTomlPath, "utf-8");
    const pluginToml = TOML.parse(pluginTomlRaw) as unknown as PluginTomlConfig;
    const skillsToml = TOML.parse(skillsTomlRaw) as unknown as SkillsTomlConfig;

    // --- Process plugin (TOML → JSON) ---
    const pluginOutputPath = join(PLUGINS_OUTPUT_DIR, `${plugin.name}.json`);
    // Include the discovered skill list so the plugin card refreshes when
    // skills are added or removed on disk — not only when the TOML changes.
    const pluginCurrentHash = computeHash(pluginTomlRaw + "\n" + plugin.skillNames.join(","));
    const pluginExistingHash = getExistingHash(pluginOutputPath);

    const ownerName = marketplaceConfig.owner.name;
    const marketplaceCommand = `/plugin marketplace add ${ownerName.toLowerCase()}/skills`;
    const installCommand = `/plugin install ${plugin.name}@${marketplaceConfig.name}`;

    if (pluginCurrentHash === pluginExistingHash) {
      console.log(`  ✓ Plugin unchanged (hash: ${pluginCurrentHash})`);
    } else {
      console.log(`  ⟳ Generating plugin content from TOML...`);
      try {
        const output: PluginGenerated = {
          sourceHash: pluginCurrentHash,
          generatedAt: new Date().toISOString(),
          plugin: {
            name: plugin.name,
            displayName: pluginToml.display_name,
            tagline: pluginToml.tagline,
            ...(pluginToml.repo ? { repo: pluginToml.repo } : {}),
            skillCount: plugin.skillNames.length,
            skills: plugin.skillNames,
            marketplaceCommand,
            installCommand,
          },
        };

        writeFileSync(pluginOutputPath, JSON.stringify(output, null, 2) + "\n");
        console.log(`  ✓ Plugin generated (hash: ${pluginCurrentHash})`);
      } catch (error) {
        console.error(`  ✗ Plugin failed:`, error);
      }
    }

    // --- Process skills (TOML → JSON) ---
    for (const skillName of plugin.skillNames) {
      const skillOutputPath = join(SKILLS_OUTPUT_DIR, `${skillName}.json`);

      const skillToml = skillsToml.skills?.[skillName];
      if (!skillToml) {
        console.error(`  ✗ ${skillName}: not found in website.skills.toml`);
        continue;
      }

      const skillCurrentHash = computeHash(JSON.stringify(skillToml));
      const skillExistingHash = getExistingHash(skillOutputPath);

      if (skillCurrentHash === skillExistingHash) {
        console.log(`  ✓ ${skillName}: unchanged (hash: ${skillCurrentHash})`);
        continue;
      }

      console.log(`  ⟳ ${skillName}: generating from TOML...`);

      try {
        const output: SkillGenerated = {
          sourceHash: skillCurrentHash,
          generatedAt: new Date().toISOString(),
          skill: {
            name: skillName,
            displayName: skillToml.display_name,
            pluginName: plugin.name,
            tagline: skillToml.tagline,
            shortSummary: skillToml.short_summary,
            fullSummary: skillToml.full_summary,
            highlights: skillToml.highlights,
            workflow: {
              steps: skillToml.workflow,
            },
          },
        };

        writeFileSync(skillOutputPath, JSON.stringify(output, null, 2) + "\n");
        console.log(`  ✓ ${skillName}: generated (hash: ${skillCurrentHash})`);
      } catch (error) {
        console.error(`  ✗ ${skillName}: failed -`, error);
      }
    }
  }

  console.log("\n✨ Done!");
}

main();
