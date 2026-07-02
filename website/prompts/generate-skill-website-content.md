# Generate skill website content (OpenCode)

Generate website marketing content for a Claude Code plugin skill from its `SKILL.md`.

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
