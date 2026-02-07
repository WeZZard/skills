import { createHash } from "crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import OpenAI from "openai";
import TOML from "toml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: join(__dirname, "../../.env") });

const PLUGIN_DIR = join(__dirname, "../../claude/intelligence-scale");
const HOOKS_JSON = join(PLUGIN_DIR, "hooks/hooks.json");
const WEBSITE_TOML = join(PLUGIN_DIR, "website.toml");
const SKILLS_DIR = join(PLUGIN_DIR, "skills");
const OUTPUT_DIR = join(__dirname, "../src/content/generated/workflow");

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Types ---

interface HooksConfig {
  description: string;
  hooks: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string; timeout?: number }>;
    }>
  >;
}

interface TomlAddition {
  id: string;
  event: string;
  type: string;
  label: string;
  description: string;
  effect: string;
}

interface TomlEvent {
  id: string;
  edge: "top" | "right" | "bottom" | "left";
  position: number;
  label: string;
}

interface TomlSection {
  title: string;
  highlight_title?: string;
  highlight_content?: string;
  comparison_before_label?: string;
  comparison_before?: string;
  comparison_after_label?: string;
  comparison_after?: string;
  related_skills?: string[];
  additions?: TomlAddition[];
}

interface WebsiteConfig {
  philosophy: {
    intro: string;
    events?: TomlEvent[];
    sections: TomlSection[];
  };
}

interface DiagramEvent {
  id: string;
  edge: "top" | "right" | "bottom" | "left";
  position: number;
  label: string;
  tooltip: string;
}

interface PhilosophyHighlight {
  type: string;
  title: string;
  content: string;
  comparison?: {
    before_label: string;
    before: string;
    after_label: string;
    after: string;
  };
}

interface WorkflowDiagramData {
  sourceHash: string;
  generatedAt: string;
  diagram: {
    events: DiagramEvent[];
    rect: { width: number; height: number; rx: number };
  };
  philosophies: Array<{
    id: string;
    title: string;
    additions: TomlAddition[];
    highlight: PhilosophyHighlight;
    relatedSkills: string[];
  }>;
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

function toId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Source loading ---

function loadHooksConfig(): HooksConfig {
  const content = readFileSync(HOOKS_JSON, "utf-8");
  return JSON.parse(content);
}

function loadWebsiteConfig(): WebsiteConfig {
  const content = readFileSync(WEBSITE_TOML, "utf-8");
  return TOML.parse(content) as unknown as WebsiteConfig;
}

function discoverSkills(): Array<{ name: string; content: string }> {
  const skills: Array<{ name: string; content: string }> = [];

  if (!existsSync(SKILLS_DIR)) return skills;

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (existsSync(skillMdPath)) {
      skills.push({
        name: entry.name,
        content: readFileSync(skillMdPath, "utf-8"),
      });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Compute combined hash of all source files ---

function computeCombinedHash(
  hooksContent: string,
  websiteContent: string,
  skillContents: string[]
): string {
  const combined = [hooksContent, websiteContent, ...skillContents].join("\n---BOUNDARY---\n");
  return computeHash(combined);
}

// --- Build highlight from TOML config ---

function buildHighlight(section: TomlSection): PhilosophyHighlight {
  const highlight: PhilosophyHighlight = {
    type: section.comparison_before ? "insight" : "feature",
    title: section.highlight_title || section.title,
    content: section.highlight_content || "",
  };

  if (
    section.comparison_before_label &&
    section.comparison_before &&
    section.comparison_after_label &&
    section.comparison_after
  ) {
    highlight.comparison = {
      before_label: section.comparison_before_label,
      before: section.comparison_before,
      after_label: section.comparison_after_label,
      after: section.comparison_after,
    };
  }

  return highlight;
}

// --- AI generation (tooltips only) ---

async function generateTooltips(
  client: OpenAI,
  events: TomlEvent[],
  hooksConfig: HooksConfig,
  skills: Array<{ name: string; content: string }>
): Promise<Record<string, string>> {
  const hookEventNames = Object.keys(hooksConfig.hooks);
  const skillNames = skills.map((s) => s.name);

  const prompt = `You are analyzing a Claude Code plugin called "Intelligence Scale" that uses hooks and skills to enhance AI-assisted development workflows.

## Context

### Hook Events Defined in hooks.json
${hookEventNames.map((name) => `- ${name}`).join("\n")}

### Skills Available
${skillNames.map((name) => `- ${name}`).join("\n")}

### Diagram Events (markers on a rounded rectangle)
${events.map((e) => `- ${e.id} (${e.edge} edge, position ${e.position}): "${e.label}"`).join("\n")}

## Task

Generate a JSON object with one field:

"tooltips": An object mapping each event ID to a short tooltip string (max 60 characters). The tooltip should concisely explain what happens at this hook point in the Claude Code lifecycle. Be specific to Intelligence Scale's usage.

Output format:
{
  "tooltips": {
${events.map((e) => `    "${e.id}": "..."`).join(",\n")}
  }
}

Requirements:
- Tooltips: Max 60 chars each, action-oriented, specific to Intelligence Scale
- Use simple, clear language`;

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
  return result.tooltips || {};
}

// --- Main ---

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

  console.log("🔄 Generating workflow diagram data for intelligence-scale\n");

  // Load source files
  const hooksRaw = readFileSync(HOOKS_JSON, "utf-8");
  const websiteRaw = readFileSync(WEBSITE_TOML, "utf-8");
  const hooksConfig = loadHooksConfig();
  const websiteConfig = loadWebsiteConfig();
  const skills = discoverSkills();

  console.log(`  Found ${Object.keys(hooksConfig.hooks).length} hook event(s)`);
  console.log(`  Found ${websiteConfig.philosophy.sections.length} philosophy section(s)`);
  console.log(`  Found ${skills.length} skill(s)`);

  // Read events from TOML config
  const tomlEvents = websiteConfig.philosophy.events || [];
  if (tomlEvents.length === 0) {
    console.error("  ✗ No events defined in website.toml [philosophy.events]");
    process.exit(1);
  }
  console.log(`  Found ${tomlEvents.length} diagram event(s) in TOML`);

  // Compute combined hash for cache invalidation
  const skillContents = skills.map((s) => s.content);
  const currentHash = computeCombinedHash(hooksRaw, websiteRaw, skillContents);

  const outputPath = join(OUTPUT_DIR, "intelligence-scale.json");
  const existingHash = getExistingHash(outputPath);

  if (currentHash === existingHash) {
    console.log(`\n  ✓ Sources unchanged (hash: ${currentHash})`);
    console.log("\n✨ Done!");
    return;
  }

  console.log(`\n  ⟳ Sources changed (hash: ${currentHash}), regenerating...`);

  // Call DeepSeek API for tooltips
  console.log("  ⟳ Calling DeepSeek API for tooltips...");

  try {
    const tooltips = await generateTooltips(
      client,
      tomlEvents,
      hooksConfig,
      skills
    );

    // Assemble diagram events with tooltips
    const diagramEvents: DiagramEvent[] = tomlEvents.map((event) => ({
      ...event,
      tooltip: tooltips[event.id] || `${event.label} event`,
    }));

    // Assemble philosophy sections — all content from TOML
    const philosophies = websiteConfig.philosophy.sections.map((section) => {
      const id = toId(section.title);
      const additions = section.additions || [];
      const highlight = buildHighlight(section);
      const relatedSkills = section.related_skills || [];

      return {
        id,
        title: section.title,
        additions,
        highlight,
        relatedSkills,
      };
    });

    // Build output
    const output: WorkflowDiagramData = {
      sourceHash: currentHash,
      generatedAt: new Date().toISOString(),
      diagram: {
        events: diagramEvents,
        rect: { width: 600, height: 400, rx: 24 },
      },
      philosophies,
    };

    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
    console.log(`  ✓ Generated workflow diagram (hash: ${currentHash})`);
  } catch (error) {
    console.error("  ✗ Generation failed:", error);
    process.exit(1);
  }

  console.log("\n✨ Done!");
}

main();
