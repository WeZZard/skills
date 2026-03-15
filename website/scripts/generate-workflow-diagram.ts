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
import TOML from "toml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLUGINS_DIR = join(__dirname, "../../claude");
const OUTPUT_DIR = join(__dirname, "../src/content/generated/workflow");

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Plugin discovery ---

function discoverPluginsWithPhilosophy(): Array<{ name: string; dir: string }> {
  const plugins: Array<{ name: string; dir: string }> = [];
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(PLUGINS_DIR, entry.name);
    if (existsSync(join(pluginDir, "website.philosophy.toml"))) {
      plugins.push({ name: entry.name, dir: pluginDir });
    }
  }
  return plugins;
}

// --- Types ---

interface TomlAddition {
  id: string;
  event: string; // matches TomlEvent.id
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
  highlight_image?: string;
  highlight_sound?: string;
  comparison_before_label?: string;
  comparison_before?: string;
  comparison_before_image?: string;
  comparison_after_label?: string;
  comparison_after?: string;
  comparison_after_image?: string;
  related_skills?: string[];
  additions?: TomlAddition[];
}

interface WebsiteConfig {
  skills?: {
    order?: string[];
  };
  philosophy: {
    events?: TomlEvent[];
    sections: TomlSection[];
  };
}

interface DiagramEvent {
  id: string;
  edge: "top" | "right" | "bottom" | "left";
  position: number;
  label: string;
}

interface PhilosophyHighlight {
  type: string;
  title: string;
  content: string;
  image?: string;
  sound?: string;
  comparison?: {
    before_label: string;
    before: string;
    before_image?: string;
    after_label: string;
    after: string;
    after_image?: string;
  };
}

interface WorkflowDiagramData {
  sourceHash: string;
  generatedAt: string;
  skillOrder?: string[];
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

function loadWebsiteConfig(pluginDir: string): WebsiteConfig {
  const content = readFileSync(join(pluginDir, "website.philosophy.toml"), "utf-8");
  return TOML.parse(content) as unknown as WebsiteConfig;
}

function discoverSkills(pluginDir: string): Array<{ name: string; content: string }> {
  const skills: Array<{ name: string; content: string }> = [];
  const skillsDir = join(pluginDir, "skills");

  if (!existsSync(skillsDir)) return skills;

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
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

  if (section.highlight_image) {
    highlight.image = section.highlight_image;
  }

  if (section.highlight_sound) {
    highlight.sound = section.highlight_sound;
  }

  if (
    section.comparison_before_label &&
    section.comparison_before &&
    section.comparison_after_label &&
    section.comparison_after
  ) {
    highlight.comparison = {
      before_label: section.comparison_before_label,
      before: section.comparison_before,
      ...(section.comparison_before_image ? { before_image: section.comparison_before_image } : {}),
      after_label: section.comparison_after_label,
      after: section.comparison_after,
      ...(section.comparison_after_image ? { after_image: section.comparison_after_image } : {}),
    };
  }

  return highlight;
}

// --- Process a single plugin ---

function processPlugin(plugin: { name: string; dir: string }, forceRegenerate: boolean): void {
  console.log(`\n📦 Plugin: ${plugin.name}`);

  const hooksJsonPath = join(plugin.dir, "hooks/hooks.json");
  const websiteTomlPath = join(plugin.dir, "website.philosophy.toml");

  // Load source files
  const hooksRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, "utf-8") : "{}";
  const websiteRaw = readFileSync(websiteTomlPath, "utf-8");
  const websiteConfig = loadWebsiteConfig(plugin.dir);
  const skills = discoverSkills(plugin.dir);

  console.log(`  Found ${websiteConfig.philosophy.sections.length} philosophy section(s)`);
  console.log(`  Found ${skills.length} skill(s)`);

  // Read events from TOML config
  const tomlEvents = websiteConfig.philosophy.events || [];
  if (tomlEvents.length === 0) {
    console.error("  ✗ No events defined in website.philosophy.toml [philosophy.events]");
    return;
  }
  console.log(`  Found ${tomlEvents.length} diagram event(s) in TOML`);

  // Compute combined hash for cache invalidation
  const skillContents = skills.map((s) => s.content);
  const currentHash = computeCombinedHash(hooksRaw, websiteRaw, skillContents);

  const outputPath = join(OUTPUT_DIR, `${plugin.name}.json`);
  const existingHash = getExistingHash(outputPath);

  // Skip regeneration if sources unchanged and output exists (unless --force)
  if (!forceRegenerate && currentHash === existingHash) {
    console.log(`  ✓ Sources unchanged (hash: ${currentHash})`);
    return;
  }

  if (forceRegenerate) {
    console.log(`  ⟳ Forced regeneration requested...`);
  } else {
    console.log(`  ⟳ Sources changed (hash: ${currentHash}), regenerating...`);
  }

  // Assemble diagram events from TOML
  const diagramEvents: DiagramEvent[] = tomlEvents.map((event) => ({
    id: event.id,
    edge: event.edge,
    position: event.position,
    label: event.label,
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
  const skillOrder = websiteConfig.skills?.order;
  const output: WorkflowDiagramData = {
    sourceHash: currentHash,
    generatedAt: new Date().toISOString(),
    ...(skillOrder && skillOrder.length > 0 ? { skillOrder } : {}),
    diagram: {
      events: diagramEvents,
      rect: { width: 600, height: 400, rx: 24 },
    },
    philosophies,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`  ✓ Generated workflow diagram (hash: ${currentHash})`);
}

// --- Main ---

function main() {
  const forceRegenerate = process.argv.includes("--force");
  const plugins = discoverPluginsWithPhilosophy();

  console.log(`🔄 Generating workflow diagram data for ${plugins.length} plugin(s)`);

  for (const plugin of plugins) {
    processPlugin(plugin, forceRegenerate);
  }

  console.log("\n✨ Done!");
}

main();
