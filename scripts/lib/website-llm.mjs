#!/usr/bin/env node

/** Generate and validate website skill content through the bounded Pi runner. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPiAvailable, runPiPrompt } from "./pi-run.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_WEBSITE_PROMPT = join(
  __dirname,
  "../../website/prompts/generate-skill-website-content.md",
);

export function skillTomlHasBasics(entry) {
  return Boolean(entry?.display_name);
}

export function isWebsiteLlmAvailable() {
  return isPiAvailable();
}

function requireString(value, field, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Pi response field ${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`Pi response field ${field} exceeds ${maxLength} characters`);
  }
  return value;
}

export function validateGeneratedSkillContent(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Pi response must be a JSON object");
  }
  if (!Array.isArray(result.highlights) || result.highlights.length < 3 || result.highlights.length > 4) {
    throw new Error("Pi response must contain 3-4 highlights");
  }
  if (!Array.isArray(result.workflow) || result.workflow.length < 3 || result.workflow.length > 5) {
    throw new Error("Pi response must contain 3-5 workflow steps");
  }

  return {
    display_name: requireString(result.display_name, "display_name", 80),
    tagline: requireString(result.tagline, "tagline", 80),
    short_summary: requireString(result.short_summary, "short_summary", 150),
    full_summary: requireString(result.full_summary, "full_summary", 500),
    highlights: result.highlights.map((highlight, index) => ({
      title: requireString(highlight?.title, `highlights[${index}].title`, 100),
      description: requireString(
        highlight?.description,
        `highlights[${index}].description`,
        300,
      ),
    })),
    workflow: result.workflow.map((step, index) => ({
      name: requireString(step?.name, `workflow[${index}].name`, 100),
      description: requireString(
        step?.description,
        `workflow[${index}].description`,
        100,
      ),
      details: requireString(step?.details, `workflow[${index}].details`, 200),
    })),
  };
}

export async function generateSkillContentWithLlm(
  skillName,
  skillMdContent,
  options = {},
) {
  const runPrompt = options.runPrompt ?? runPiPrompt;
  const basePrompt = [
    `Generate website JSON for skill "${skillName}".`,
    "Apply the site-building skill loaded for this run.",
    "Return only valid JSON with no Markdown fences or commentary.",
    "",
    "## SKILL.md",
    skillMdContent,
  ].join("\n");

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1
      ? basePrompt
      : [
          basePrompt,
          "",
          "## Correction required",
          `Your previous response failed validation: ${lastError.message}`,
          "Return a corrected JSON object. Recheck every required field, array size, and character limit before responding.",
        ].join("\n");
    try {
      const result = await runPrompt({
        prompt,
        promptFile: options.promptFile ?? SKILL_WEBSITE_PROMPT,
        cwd: options.cwd ?? join(__dirname, "../.."),
        files: options.files ?? [],
        now: options.now ?? new Date(),
      });
      return validateGeneratedSkillContent(result);
    } catch (error) {
      lastError = error;
      if (error?.name === "SiteBuildingWindowError") throw error;
    }
  }
  throw new Error(`Pi returned invalid website content twice: ${lastError.message}`);
}
