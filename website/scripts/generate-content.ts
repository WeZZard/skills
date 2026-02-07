import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import matter from "gray-matter";
import OpenAI from "openai";

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

// Marketplace configuration
interface MarketplaceConfig {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; description: string }>;
}

function loadMarketplaceConfig(): MarketplaceConfig {
  const content = readFileSync(MARKETPLACE_JSON, "utf-8");
  return JSON.parse(content);
}

// Plugin generated content schema
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

// Skill generated content schema
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

/**
 * Convert hyphenated name to Title Case display name
 */
function toDisplayName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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

/**
 * Discover all plugins in the claude directory
 */
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

async function generatePluginContent(
  client: OpenAI,
  pluginName: string,
  pluginContent: string,
  skillNames: string[],
  marketplaceConfig: MarketplaceConfig
): Promise<PluginGenerated["plugin"]> {
  const { data: frontmatter } = matter(pluginContent);
  const displayName = frontmatter.displayName || toDisplayName(pluginName);
  const tagline = frontmatter.tagline || "";

  // Generate install commands from marketplace config
  const marketplaceName = marketplaceConfig.name;
  const ownerName = marketplaceConfig.owner.name;
  const marketplaceCommand = `/plugin marketplace add ${ownerName}/skills`;
  const installCommand = `/plugin install ${pluginName}@${marketplaceName}`;

  const prompt = `You are analyzing a Claude Code plugin definition. Generate a user-friendly explanation for a plugin gallery website.

Input PLUGIN.md:
---
${pluginContent}
---

Skills in this plugin: ${skillNames.join(", ")}

Output a JSON object with this exact structure:
{
  "shortDescription": "One concise sentence (max 120 chars) for display on index cards",
  "fullDescription": "2-3 sentences providing a complete overview for the detail page",
  "useCases": [
    {
      "title": "Use case title (2-4 words)",
      "description": "1-2 sentence explanation of this use case"
    }
  ]
}

Requirements:
- shortDescription: Ultra-concise for card display
- fullDescription: Complete but accessible explanation
- useCases: Extract 3-5 key use cases from the plugin content
- Use simple, clear language accessible to developers
- Focus on user benefits and outcomes`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
    seed: 42,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from LLM");

  const parsed = JSON.parse(content);
  return {
    name: pluginName,
    displayName,
    tagline,
    shortDescription: parsed.shortDescription,
    fullDescription: parsed.fullDescription,
    useCases: parsed.useCases,
    skillCount: skillNames.length,
    skills: skillNames,
    marketplaceCommand,
    installCommand,
  };
}

async function generateSkillContent(
  client: OpenAI,
  skillName: string,
  pluginName: string,
  skillContent: string
): Promise<SkillGenerated["skill"]> {
  const displayName = toDisplayName(skillName);

  const prompt = `You are analyzing a Claude Code skill definition. Generate a user-friendly explanation for a skill gallery website.

Input SKILL.md:
---
${skillContent}
---

Output a JSON object with this exact structure:
{
  "tagline": "One compelling sentence hook (max 80 chars) that captures the skill's essence",
  "shortSummary": "One concise sentence (max 120 chars) for display on index cards",
  "fullSummary": "2-3 sentences providing a complete overview for the detail page",
  "highlights": [
    {
      "title": "Short highlight title (2-4 words)",
      "description": "2-3 sentence explanation of this key feature or benefit"
    }
  ],
  "workflow": {
    "steps": [
      {
        "name": "Step name (2-4 words)",
        "description": "Brief description (1 sentence)",
        "details": "Extended explanation for detail page (2-3 sentences, optional)"
      }
    ]
  }
}

Requirements:
- tagline: Compelling, action-oriented hook
- shortSummary: Ultra-concise for card display
- fullSummary: Complete but accessible explanation
- highlights: Extract 3-5 key features/benefits from the skill
- workflow.steps: Clear sequential steps showing how the skill works
- Use simple, clear language accessible to developers unfamiliar with the skill
- Focus on user benefits and outcomes, not implementation details
- Do NOT include any mermaid diagrams`;

  const response = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
    seed: 42,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from LLM");

  const parsed = JSON.parse(content);
  return {
    name: skillName,
    displayName,
    pluginName,
    tagline: parsed.tagline,
    shortSummary: parsed.shortSummary,
    fullSummary: parsed.fullSummary,
    highlights: parsed.highlights,
    workflow: parsed.workflow,
  };
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("Error: DEEPSEEK_API_KEY environment variable is required");
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
  });

  const marketplaceConfig = loadMarketplaceConfig();
  const plugins = discoverPlugins();
  console.log(`Found ${plugins.length} plugin(s) to process\n`);

  for (const plugin of plugins) {
    console.log(`\n📦 Plugin: ${plugin.name} (${plugin.skillNames.length} skills)`);

    // Process plugin
    const pluginMdPath = join(plugin.path, "PLUGIN.md");
    const pluginOutputPath = join(PLUGINS_OUTPUT_DIR, `${plugin.name}.json`);

    const pluginRawContent = readFileSync(pluginMdPath, "utf-8");
    const pluginCurrentHash = computeHash(pluginRawContent);
    const pluginExistingHash = getExistingHash(pluginOutputPath);

    if (pluginCurrentHash === pluginExistingHash) {
      console.log(`  ✓ Plugin unchanged (hash: ${pluginCurrentHash})`);
    } else {
      console.log(`  ⟳ Generating plugin content...`);
      try {
        const pluginData = await generatePluginContent(
          client,
          plugin.name,
          pluginRawContent,
          plugin.skillNames,
          marketplaceConfig
        );

        const output: PluginGenerated = {
          sourceHash: pluginCurrentHash,
          generatedAt: new Date().toISOString(),
          plugin: pluginData,
        };

        writeFileSync(pluginOutputPath, JSON.stringify(output, null, 2) + "\n");
        console.log(`  ✓ Plugin generated (hash: ${pluginCurrentHash})`);
      } catch (error) {
        console.error(`  ✗ Plugin failed:`, error);
      }
    }

    // Process skills for this plugin
    const skillsDir = join(plugin.path, "skills");

    for (const skillName of plugin.skillNames) {
      const skillPath = join(skillsDir, skillName, "SKILL.md");
      const skillOutputPath = join(SKILLS_OUTPUT_DIR, `${skillName}.json`);

      const skillRawContent = readFileSync(skillPath, "utf-8");
      const skillCurrentHash = computeHash(skillRawContent);
      const skillExistingHash = getExistingHash(skillOutputPath);

      if (skillCurrentHash === skillExistingHash) {
        // Check if pluginName field exists in existing file
        try {
          const existing = JSON.parse(readFileSync(skillOutputPath, "utf-8"));
          if (existing.skill?.pluginName === plugin.name) {
            console.log(`  ✓ ${skillName}: unchanged (hash: ${skillCurrentHash})`);
            continue;
          }
        } catch {}
      }

      console.log(`  ⟳ ${skillName}: generating...`);

      try {
        const skillData = await generateSkillContent(
          client,
          skillName,
          plugin.name,
          skillRawContent
        );

        const output: SkillGenerated = {
          sourceHash: skillCurrentHash,
          generatedAt: new Date().toISOString(),
          skill: skillData,
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
