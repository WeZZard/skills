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

interface PhilosophySectionAddition {
  id: string;
  event: string;
  type: string;
  label: string;
  description: string;
  effect: string;
}

interface PhilosophySectionHighlight {
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

interface PhilosophySection {
  id?: string;
  title: string;
  content: string;
  additions?: PhilosophySectionAddition[];
  highlight?: PhilosophySectionHighlight;
  highlight_title?: string;
  highlight_content?: string;
  comparison_before_label?: string;
  comparison_before?: string;
  comparison_after_label?: string;
  comparison_after?: string;
}

interface WebsiteConfig {
  philosophy: {
    intro: string;
    sections: PhilosophySection[];
  };
}

interface DiagramEvent {
  id: string;
  edge: "top" | "right" | "bottom" | "left";
  position: number;
  label: string;
  tooltip: string;
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
    content: string;
    enhancedContent: string;
    additions: PhilosophySectionAddition[];
    highlight: PhilosophySectionHighlight;
    relatedSkills: string[];
  }>;
}

// --- Utility functions (same patterns as generate-content.ts) ---

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
 * Convert a title string to a kebab-case id
 */
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

// --- Static diagram structure ---

function buildStaticDiagramEvents(): Omit<DiagramEvent, "tooltip">[] {
  return [
    // Top edge: SessionStart, UserPromptSubmit
    {
      id: "SessionStart",
      edge: "top" as const,
      position: 0.33,
      label: "Session Start",
    },
    {
      id: "UserPromptSubmit",
      edge: "top" as const,
      position: 0.67,
      label: "User Prompt Submit",
    },
    // Right edge: PreToolUse, PostToolUse, PostToolUseFailure at 1/4, 1/2, 3/4
    {
      id: "PreToolUse",
      edge: "right" as const,
      position: 0.25,
      label: "Pre Tool Use",
    },
    {
      id: "PostToolUse",
      edge: "right" as const,
      position: 0.5,
      label: "Post Tool Use",
    },
    {
      id: "PostToolUseFailure",
      edge: "right" as const,
      position: 0.75,
      label: "Post Tool Use Failure",
    },
    // Bottom edge: ExitPlanMode, EnterPlanMode
    {
      id: "ExitPlanMode",
      edge: "bottom" as const,
      position: 0.33,
      label: "Exit Plan Mode",
    },
    {
      id: "EnterPlanMode",
      edge: "bottom" as const,
      position: 0.67,
      label: "Enter Plan Mode",
    },
    // Left edge: SubagentStop, SubagentSpawn at 1/3, 2/3
    {
      id: "SubagentStop",
      edge: "left" as const,
      position: 0.33,
      label: "Subagent Stop",
    },
    {
      id: "SubagentSpawn",
      edge: "left" as const,
      position: 0.67,
      label: "Subagent Spawn",
    },
  ];
}

// --- Build highlight from TOML config or fallback to defaults ---

function buildHighlightFromConfig(section: PhilosophySection): PhilosophySectionHighlight {
  // If highlight is already provided in the section, use it
  if (section.highlight) {
    return section.highlight;
  }

  // If highlight fields are provided in TOML, build from them
  if (section.highlight_title && section.highlight_content) {
    const highlight: PhilosophySectionHighlight = {
      type: section.comparison_before ? "insight" : "feature",
      title: section.highlight_title,
      content: section.highlight_content,
    };

    // Add comparison if all comparison fields are present
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

  // Fallback to default highlight
  return getDefaultHighlight(section.title);
}

// --- Default additions and highlights for philosophy sections ---

function getDefaultAdditions(sectionTitle: string): PhilosophySectionAddition[] {
  const defaults: Record<string, PhilosophySectionAddition[]> = {
    "Addressing the Review Burden": [
      {
        id: "session-start-context",
        event: "SessionStart",
        type: "hook",
        label: "Context Injection",
        description: "Injects skill context and session state on startup",
        effect: "Reduces review burden by pre-loading relevant context",
      },
    ],
    "Polished Plan Structure": [
      {
        id: "enter-plan-mode-structure",
        event: "EnterPlanMode",
        type: "hook",
        label: "Plan Mode Entry",
        description: "Triggers structured plan template when entering plan mode",
        effect: "Ensures plans follow a reviewable, consistent structure",
      },
      {
        id: "post-tool-plan-check",
        event: "PostToolUse",
        type: "hook",
        label: "Post-Plan Validation",
        description: "Validates plan structure after plan mode tool use",
        effect: "Catches structural issues early in the planning phase",
      },
    ],
    "Maximizing Task Parallelism": [
      {
        id: "user-prompt-parallelism",
        event: "UserPromptSubmit",
        type: "hook",
        label: "Parallelism Reminder",
        description: "Reminds to spawn subagents for independent tasks",
        effect: "Maximizes concurrent execution of independent work",
      },
      {
        id: "subagent-spawn-parallel",
        event: "SubagentSpawn",
        type: "event",
        label: "Subagent Spawning",
        description: "Parallel task execution via subagent spawning",
        effect: "Enables concurrent work on independent plan tasks",
      },
    ],
    "Error Recovery": [
      {
        id: "tool-failure-recovery",
        event: "PostToolUseFailure",
        type: "hook",
        label: "Error Recovery Hook",
        description: "Triggers error recovery procedure on tool failures",
        effect: "Prevents goal drift by re-aligning to the session plan",
      },
    ],
    "Plan Execution Audit": [
      {
        id: "subagent-stop-audit",
        event: "SubagentStop",
        type: "hook",
        label: "Post-Subagent Audit",
        description: "Checks plan compliance when subagent work completes",
        effect: "Verifies each parallel task met its planned objectives",
      },
    ],
  };

  return defaults[sectionTitle] || [];
}

function getDefaultHighlight(sectionTitle: string): PhilosophySectionHighlight {
  const defaults: Record<string, PhilosophySectionHighlight> = {
    "Addressing the Review Burden": {
      type: "insight",
      title: "Why Plans Fail",
      content:
        "Traditional plans describe state transitions for humans who imagine outcomes. LLMs living in this context hallucinate because they lack grounded state awareness.",
      comparison: {
        before_label: "Traditional Plan",
        before: "Describe current state → list changes → hope for the best",
        after_label: "Intelligence Scale Plan",
        after:
          "Structured template → verification gates → evidence-based execution",
      },
    },
    "Polished Plan Structure": {
      type: "feature",
      title: "Structured Plan Template",
      content:
        "Plans include task dependencies, verification steps, human verification gates, and explicit file paths—reducing ambiguity and review effort.",
    },
    "Maximizing Task Parallelism": {
      type: "feature",
      title: "Automatic Parallelism",
      content:
        "Every user prompt triggers a reminder to spawn subagents for independent tasks, ensuring maximum throughput without manual orchestration.",
    },
    "Error Recovery": {
      type: "insight",
      title: "Preventing Goal Drift",
      content:
        "When tools fail, the natural instinct is to generalize or guess. Intelligence Scale forces re-alignment to the plan, preventing cascading errors.",
      comparison: {
        before_label: "Without Recovery",
        before: "Tool fails → guess new params → drift from goal → waste context",
        after_label: "With Recovery",
        after:
          "Tool fails → check plan → verify alignment → fix specific issue",
      },
    },
    "Plan Execution Audit": {
      type: "feature",
      title: "Compliance Verification",
      content:
        "After execution, every task is verified against the plan with evidence-based status reporting: Done, Partial, or Missing.",
    },
  };

  return (
    defaults[sectionTitle] || {
      type: "insight",
      title: sectionTitle,
      content: "Key insight for this philosophy section.",
    }
  );
}

// --- Determine related skills for each philosophy section ---

function getRelatedSkills(sectionTitle: string): string[] {
  const mapping: Record<string, string[]> = {
    "Addressing the Review Burden": ["using-skills", "brainstorming"],
    "Polished Plan Structure": ["write-plan", "brainstorming"],
    "Maximizing Task Parallelism": ["execute-plan"],
    "Error Recovery": ["recover-from-errors"],
    "Plan Execution Audit": ["audit-plan"],
  };

  return mapping[sectionTitle] || [];
}

// --- AI generation ---

async function generateTooltipsAndEnhancedContent(
  client: OpenAI,
  events: Omit<DiagramEvent, "tooltip">[],
  hooksConfig: HooksConfig,
  sections: PhilosophySection[],
  skills: Array<{ name: string; content: string }>
): Promise<{
  tooltips: Record<string, string>;
  enhancedContents: Record<string, string>;
}> {
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

### Philosophy Sections
${sections.map((s, i) => `${i + 1}. "${s.title}": ${s.content.slice(0, 200)}...`).join("\n")}

## Task

Generate a JSON object with two fields:

1. "tooltips": An object mapping each event ID to a short tooltip string (max 60 characters). The tooltip should concisely explain what happens at this hook point in the Claude Code lifecycle. Be specific to Intelligence Scale's usage.

2. "enhancedContents": An object mapping each philosophy section title to an enhanced version of its content (2-3 sentences). The enhanced content should be more engaging and website-friendly while preserving the original meaning. Write for developers visiting a plugin gallery.

Output format:
{
  "tooltips": {
    "SessionStart": "...",
    "UserPromptSubmit": "...",
    "PreToolUse": "...",
    "PostToolUse": "...",
    "PostToolUseFailure": "...",
    "ExitPlanMode": "...",
    "EnterPlanMode": "...",
    "SubagentStop": "...",
    "SubagentSpawn": "..."
  },
  "enhancedContents": {
    "Section Title": "Enhanced content..."
  }
}

Requirements:
- Tooltips: Max 60 chars each, action-oriented, specific to Intelligence Scale
- Enhanced contents: 2-3 sentences, engaging, developer-friendly, preserve original meaning
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

  return JSON.parse(content);
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

  // Build static diagram events
  const staticEvents = buildStaticDiagramEvents();

  // Call DeepSeek API
  console.log("  ⟳ Calling DeepSeek API for tooltips and enhanced content...");

  try {
    const { tooltips, enhancedContents } =
      await generateTooltipsAndEnhancedContent(
        client,
        staticEvents,
        hooksConfig,
        websiteConfig.philosophy.sections,
        skills
      );

    // Assemble diagram events with tooltips
    const diagramEvents: DiagramEvent[] = staticEvents.map((event) => ({
      ...event,
      tooltip: tooltips[event.id] || `${event.label} event`,
    }));

    // Assemble philosophy sections
    const philosophies = websiteConfig.philosophy.sections.map((section) => {
      const id = section.id || toId(section.title);
      const additions =
        section.additions && section.additions.length > 0
          ? section.additions
          : getDefaultAdditions(section.title);
      const highlight = buildHighlightFromConfig(section);
      const relatedSkills = getRelatedSkills(section.title);
      const enhancedContent =
        enhancedContents[section.title] || section.content;

      return {
        id,
        title: section.title,
        content: section.content,
        enhancedContent,
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
