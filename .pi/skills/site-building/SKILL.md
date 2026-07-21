---
name: site-building
description: Generates structured website copy for one published plugin skill from its supplied SKILL.md source. Use only for the queued skills-website content job.
---

# Site-Building Content

Generate accurate website copy from the supplied `SKILL.md` content.

## Input contract

- The caller discovers published skills only at the plugin root under `skills/<name>/SKILL.md`.
- The caller supplies exactly one discovered `SKILL.md` per request.
- Treat the supplied skill as published. Do not inspect repository paths or classify whether the skill should be published.
- Repository-only skills under `.agents/skills/` are outside this process and are never supplied.

## Rules

- Describe only behavior supported by the source.
- Use concrete product language. Do not invent capabilities, compatibility, or outcomes.
- Preserve the skill's terminology and intended audience.
- Return one JSON object and no surrounding prose or Markdown fences.
- Use exactly these fields:

```json
{
  "display_name": "Human-readable skill name",
  "tagline": "One-line tagline",
  "short_summary": "One-sentence summary",
  "full_summary": "Two or three sentences",
  "highlights": [
    { "title": "Highlight title", "description": "Highlight description" }
  ],
  "workflow": [
    {
      "name": "Workflow step",
      "description": "Brief action",
      "details": "Detailed action"
    }
  ]
}
```

## Limits

- Keep `display_name` within 80 characters.
- Keep `tagline` within 80 characters.
- Keep `short_summary` within 150 characters.
- Keep `full_summary` within 500 characters.
- Include three or four highlights. Keep each title within 100 characters and each description within 300 characters.
- Include three to five workflow steps. Keep each name and description within 100 characters and each detail within 200 characters.
