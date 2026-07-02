#!/usr/bin/env node

/**
 * Generate website skill content via DeepSeek when TOML entries are incomplete.
 * Writes JSON only (does not patch plugin TOML in catalog PRs).
 */

const PROMPT = `You are generating website content for a Claude Code plugin skill.

## Context

### Skill (SKILL.md for "{{skillName}}")
{{skillMd}}

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

function buildPrompt(skillName, skillMd) {
  return PROMPT.replace("{{skillName}}", skillName).replace("{{skillMd}}", skillMd);
}

function skillTomlComplete(entry) {
  return Boolean(
    entry?.display_name &&
      entry?.tagline &&
      entry?.short_summary &&
      entry?.full_summary &&
      Array.isArray(entry?.highlights) &&
      entry.highlights.length > 0 &&
      Array.isArray(entry?.workflow) &&
      entry.workflow.length > 0,
  );
}

export { buildPrompt, skillTomlComplete };

export async function generateSkillContentWithLlm(skillName, skillMdContent, options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for LLM website generation when TOML is incomplete",
    );
  }

  const baseURL = options.baseURL ?? "https://api.deepseek.com/v1";
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: buildPrompt(skillName, skillMdContent) }],
      response_format: { type: "json_object" },
      temperature: 0,
      seed: 42,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No response from DeepSeek API");
  }

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
