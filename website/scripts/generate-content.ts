import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import matter from "gray-matter";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: join(__dirname, "../../.env") });

const SKILLS_DIR = join(__dirname, "../../claude/intelligence-scale/skills");
const OUTPUT_DIR = join(__dirname, "../src/content/generated");

// New schema for editorial redesign
interface SkillGenerated {
  sourceHash: string;
  generatedAt: string;
  skill: {
    name: string;
    displayName: string;
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
 * Convert hyphenated skill name to Title Case display name
 * "write-plan" → "Write Plan"
 * "recover-from-errors" → "Recover From Errors"
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

async function generateSkillContent(
  client: OpenAI,
  skillName: string,
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

  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${skillDirs.length} skills to process\n`);

  for (const skillName of skillDirs) {
    const skillPath = join(SKILLS_DIR, skillName, "SKILL.md");
    const outputPath = join(OUTPUT_DIR, `${skillName}.json`);

    if (!existsSync(skillPath)) {
      console.log(`⚠ Skipping ${skillName}: no SKILL.md found`);
      continue;
    }

    const rawContent = readFileSync(skillPath, "utf-8");
    const currentHash = computeHash(rawContent);
    const existingHash = getExistingHash(outputPath);

    if (currentHash === existingHash) {
      console.log(`✓ ${skillName}: unchanged (hash: ${currentHash})`);
      continue;
    }

    console.log(`⟳ ${skillName}: generating...`);

    try {
      const { data: frontmatter, content } = matter(rawContent);
      const skill = await generateSkillContent(client, skillName, rawContent);

      const output: SkillGenerated = {
        sourceHash: currentHash,
        generatedAt: new Date().toISOString(),
        skill,
      };

      writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
      console.log(`✓ ${skillName}: generated (hash: ${currentHash})`);
    } catch (error) {
      console.error(`✗ ${skillName}: failed -`, error);
    }
  }

  console.log("\nDone!");
}

main();
