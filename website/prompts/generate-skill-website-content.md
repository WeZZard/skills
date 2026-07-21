# Generate skill website content (Pi)

Generate website content for one published Claude Code plugin skill from the supplied `SKILL.md`.

The caller discovers published skills only at the plugin root under
`skills/<name>/SKILL.md`. It supplies exactly one discovered file per request.
Treat that input as published. Do not inspect repository paths or classify
publication. The caller excludes repository-only skills under `.agents/skills/`.

## Output

Return **only** a JSON object with these fields:

```json
{
  "display_name": "Human-readable skill name (title case, 2-4 words)",
  "tagline": "A compelling one-line tagline (max 80 chars)",
  "short_summary": "One-sentence summary (max 150 chars)",
  "full_summary": "2-3 sentence summary (max 500 chars)",
  "highlights": [
    { "title": "Highlight Title", "description": "2-3 sentences (max 300 chars)" }
  ],
  "workflow": [
    {
      "name": "Step Name",
      "description": "Brief step (max 100 chars)",
      "details": "Detailed step (max 200 chars)"
    }
  ]
}
```

Requirements:

- Exactly 3-4 highlights
- 3-5 workflow steps reflecting the actual process in SKILL.md
- Be specific to the skill; avoid generic filler
