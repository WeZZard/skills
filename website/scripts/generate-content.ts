import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import TOML from "toml";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  short_description: string;
  full_description: string;
  use_cases: Array<{ title: string; description: string }>;
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
    shortDescription: string;
    fullDescription: string;
    useCases: Array<{ title: string; description: string }>;
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

  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginPath = join(PLUGINS_DIR, entry.name);
    const pluginMdPath = join(pluginPath, "PLUGIN.md");

    if (!existsSync(pluginMdPath)) continue;

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

// --- Main ---

async function main() {
  const marketplaceConfig = loadMarketplaceConfig();
  const plugins = discoverPlugins();
  console.log(`Found ${plugins.length} plugin(s) to process\n`);

  for (const plugin of plugins) {
    console.log(`\n📦 Plugin: ${plugin.name} (${plugin.skillNames.length} skills)`);

    // --- Load TOML configs ---
    const pluginTomlPath = join(plugin.path, "website.plugin.toml");
    const skillsTomlPath = join(plugin.path, "website.skills.toml");

    if (!existsSync(pluginTomlPath)) {
      console.error(`  ✗ Missing ${pluginTomlPath}`);
      continue;
    }
    if (!existsSync(skillsTomlPath)) {
      console.error(`  ✗ Missing ${skillsTomlPath}`);
      continue;
    }

    const pluginTomlRaw = readFileSync(pluginTomlPath, "utf-8");
    const skillsTomlRaw = readFileSync(skillsTomlPath, "utf-8");
    const pluginToml = TOML.parse(pluginTomlRaw) as unknown as PluginTomlConfig;
    const skillsToml = TOML.parse(skillsTomlRaw) as unknown as SkillsTomlConfig;

    // --- Process plugin ---
    const pluginOutputPath = join(PLUGINS_OUTPUT_DIR, `${plugin.name}.json`);
    const pluginCurrentHash = computeHash(pluginTomlRaw);
    const pluginExistingHash = getExistingHash(pluginOutputPath);

    // Generate install commands from marketplace config
    const ownerName = marketplaceConfig.owner.name;
    const marketplaceCommand = `/plugin marketplace add ${ownerName}/skills`;
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
            shortDescription: pluginToml.short_description,
            fullDescription: pluginToml.full_description,
            useCases: pluginToml.use_cases,
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

    // --- Process skills ---
    for (const skillName of plugin.skillNames) {
      const skillOutputPath = join(SKILLS_OUTPUT_DIR, `${skillName}.json`);

      // Hash the skill's TOML section content
      const skillToml = skillsToml.skills?.[skillName];
      if (!skillToml) {
        console.error(`  ✗ ${skillName}: not found in website.skills.toml`);
        continue;
      }

      // Use the full skills TOML raw + skill name as hash source for per-skill caching
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
