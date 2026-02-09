import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";
import TOML from "toml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: join(__dirname, "../../.env") });

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

// --- AI generation for amplify skills ---

/**
 * Generates website content for a skill using the DeepSeek API.
 * Template is specific to the amplify plugin.
 */
async function generateSkillContent(
  client: OpenAI,
  skillName: string,
  skillMdContent: string,
): Promise<SkillTomlEntry> {
  const prompt = `You are generating website content for a Claude Code plugin skill.

## Context

### Skill (SKILL.md for "${skillName}")
${skillMdContent}

## Task

Generate website content for this skill as a JSON object with these fields:

{
  "display_name": "Human-readable skill name (title case, 2-4 words)",
  "tagline": "A compelling one-line tagline (max 80 chars) that captures the skill's value proposition",
  "short_summary": "A concise one-sentence summary (max 150 chars) of what the skill does",
  "full_summary": "A detailed 2-3 sentence summary explaining the skill's purpose, how it works, and its benefits (max 500 chars)",
  "highlights": [
    {
      "title": "Highlight Title (2-4 words)",
      "description": "A 2-3 sentence description of this key feature or benefit (max 300 chars)"
    }
  ],
  "workflow": [
    {
      "name": "Step Name (2-4 words)",
      "description": "Brief description of this step (max 100 chars)",
      "details": "Detailed explanation of what happens in this step (max 200 chars)"
    }
  ]
}

Requirements:
- Generate exactly 3-4 highlights
- Generate 3-5 workflow steps that reflect the actual process described in SKILL.md
- Use clear, professional language
- Be specific to what this skill actually does (don't be generic)
- The tagline should be compelling and action-oriented
- Workflow steps should follow the actual process described in the SKILL.md`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
    seed: 42,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from LLM");

  const result = JSON.parse(content);

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
 * and generates content for them via the DeepSeek API.
 * Returns true if any new content was generated (so the caller can re-read the TOML).
 *
 * This function is specific to the amplify plugin template.
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

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log(
      "  ℹ DEEPSEEK_API_KEY not set — skipping LLM content generation.\n" +
      "    To generate content locally, set DEEPSEEK_API_KEY in .env\n" +
      "    Skills without content will be omitted from the website: " + missingSkills.join(", ")
    );
    return false;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
  });

  let generated = false;

  for (const skillName of missingSkills) {
    const skillMdPath = join(plugin.path, "skills", skillName, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      console.error(`  ✗ ${skillName}: SKILL.md not found`);
      continue;
    }

    const skillMdContent = readFileSync(skillMdPath, "utf-8");

    console.log(`  ⟳ ${skillName}: generating content via DeepSeek API...`);
    try {
      const entry = await generateSkillContent(client, skillName, skillMdContent);
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

    // --- Generate missing skill content (amplify only) ---
    if (plugin.name === "amplify") {
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
    const pluginCurrentHash = computeHash(pluginTomlRaw);
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
