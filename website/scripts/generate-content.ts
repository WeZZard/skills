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

const SKILLS_DIR = join(__dirname, "../../plugins/wezzard/skills");
const OUTPUT_DIR = join(__dirname, "../src/content/generated");

interface SkillGenerated {
  sourceHash: string;
  generatedAt: string;
  skill: {
    name: string;
    tagline: string;
    summary: string;
    workflow: {
      mermaid: string;
      steps: Array<{ name: string; description: string }>;
    };
    principles: string[];
  };
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
  const prompt = `You are analyzing a Claude Code skill definition. Generate a user-friendly explanation.

Input SKILL.md:
---
${skillContent}
---

Output a JSON object with this exact structure:
{
  "tagline": "One sentence hook (max 80 chars)",
  "summary": "2-3 sentence explanation for users unfamiliar with the skill",
  "workflow": {
    "mermaid": "A Mermaid flowchart diagram (graph TD format) showing the skill's process flow",
    "steps": [{"name": "Step name", "description": "Brief description of what happens"}]
  },
  "principles": ["Key principle 1", "Key principle 2", ...]
}

Requirements:
- Keep workflow diagram structure stable (same tasks = same structure)
- Use simple, clear language
- Focus on what the user experiences, not implementation details
- The mermaid diagram should use graph TD format with descriptive node labels
- Extract principles from the skill's key principles or guidelines section`;

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
    tagline: parsed.tagline,
    summary: parsed.summary,
    workflow: parsed.workflow,
    principles: parsed.principles,
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
