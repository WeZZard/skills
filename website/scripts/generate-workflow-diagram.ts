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

const PLUGIN_DIR = join(__dirname, "../../claude/intelligence-scale");
const HOOKS_JSON = join(PLUGIN_DIR, "hooks/hooks.json");
const WEBSITE_TOML = join(PLUGIN_DIR, "website.philosophy.toml");
const SKILLS_DIR = join(PLUGIN_DIR, "skills");
const OUTPUT_DIR = join(__dirname, "../src/content/generated/workflow");

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

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
  comparison_before_label?: string;
  comparison_before?: string;
  comparison_after_label?: string;
  comparison_after?: string;
  related_skills?: string[];
  additions?: TomlAddition[];
}

interface WebsiteConfig {
  skill_order?: string[];
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

// --- Main ---

function main() {
  const forceRegenerate = process.argv.includes("--force");

  console.log("🔄 Generating workflow diagram data for intelligence-scale\n");

  // Load source files
  const hooksRaw = readFileSync(HOOKS_JSON, "utf-8");
  const websiteRaw = readFileSync(WEBSITE_TOML, "utf-8");
  const websiteConfig = loadWebsiteConfig();
  const skills = discoverSkills();

  console.log(`  Found ${websiteConfig.philosophy.sections.length} philosophy section(s)`);
  console.log(`  Found ${skills.length} skill(s)`);

  // Read events from TOML config
  const tomlEvents = websiteConfig.philosophy.events || [];
  if (tomlEvents.length === 0) {
    console.error("  ✗ No events defined in website.philosophy.toml [philosophy.events]");
    process.exit(1);
  }
  console.log(`  Found ${tomlEvents.length} diagram event(s) in TOML`);

  // Compute combined hash for cache invalidation
  const skillContents = skills.map((s) => s.content);
  const currentHash = computeCombinedHash(hooksRaw, websiteRaw, skillContents);

  const outputPath = join(OUTPUT_DIR, "intelligence-scale.json");
  const existingHash = getExistingHash(outputPath);

  // Skip regeneration if sources unchanged and output exists (unless --force)
  if (!forceRegenerate && currentHash === existingHash) {
    console.log(`\n  ✓ Sources unchanged (hash: ${currentHash})`);
    console.log("\n✨ Done!");
    return;
  }

  if (forceRegenerate) {
    console.log(`\n  ⟳ Forced regeneration requested...`);
  } else {
    console.log(`\n  ⟳ Sources changed (hash: ${currentHash}), regenerating...`);
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
  const skillOrder = websiteConfig.skill_order;
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

  console.log("\n✨ Done!");
}

main();
