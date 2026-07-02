#!/usr/bin/env node

/**
 * Generate website skill content via OpenCode when TOML entries are incomplete.
 * Writes JSON only (does not patch plugin TOML in catalog PRs).
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { isOpenCodeAvailable, runOpenCodePrompt } from "./opencode-run.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_WEBSITE_PROMPT = join(
  __dirname,
  "../../website/prompts/generate-skill-website-content.md",
);

export function skillTomlHasBasics(entry) {
  return Boolean(entry?.display_name);
}

export function isWebsiteLlmAvailable() {
  return isOpenCodeAvailable();
}

export async function generateSkillContentWithLlm(
  skillName,
  skillMdContent,
  options = {},
) {
  if (!isOpenCodeAvailable()) {
    throw new Error(
      "OpenCode CLI is required for LLM website generation when TOML is incomplete",
    );
  }

  const prompt = [
    `Generate website JSON for skill "${skillName}".`,
    "Use the attached prompt file for field requirements.",
    "Return ONLY valid JSON — no markdown fences or commentary.",
    "",
    "## SKILL.md",
    skillMdContent,
  ].join("\n");

  const result = runOpenCodePrompt({
    prompt,
    promptFile: options.promptFile ?? SKILL_WEBSITE_PROMPT,
    cwd: options.cwd ?? join(__dirname, "../.."),
    model: options.model,
    files: options.files,
  });

  return {
    display_name: result.display_name,
    tagline: result.tagline,
    short_summary: result.short_summary,
    full_summary: result.full_summary,
    highlights: result.highlights,
    workflow: result.workflow,
  };
}
