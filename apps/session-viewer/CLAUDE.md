# Session Viewer

## Claude Code Transcript Scanners

Use the two-step Claude transcript scanner workflow from this app directory when:

- Adding or changing Claude Code message navigation items, Waterfall cards, Timeline blocks, or Timeline detail cards.
- Investigating unknown Claude Code transcript message kinds, including true system events.
- Auditing whether renderer fixtures cover all message kinds and structural shapes under a Claude projects directory.
- Updating fixture coverage for Claude Code cards in `scripts/validate_browser.py`.

Prefer scanning the same source directory the app will read:

```bash
uv run python scripts/scan_claude_message_kinds.py --projects-dir ~/.claude/projects
uv run python scripts/scan_claude_message_shapes.py --projects-dir ~/.claude/projects --json
uv run python scripts/compile_claude_message_type_design.py \
  --projects-dir ~/.claude/projects \
  --array-output reports/claude-transcript-scans/message-type-array.json \
  --design-output reports/claude-transcript-scans/message-type-card-design.md
```

The kind scanner identifies the two-level viewer taxonomy (`lineKind / contentKind`) across main and subagent JSONL files. The shape scanner groups structural variants inside each kind so card designs can be based on observed payloads.

Use the compiler when renderer work needs a single machine-readable array of
all observed type/subtype records plus shape-aware design guidance for
Waterfall cards, Waterfall navigation items, Timeline blocks, and Timeline
detail cards.

`scripts/scan_claude_attachments.py` remains as a compatibility wrapper for attachment-only audits.

The utility is for Claude Code JSONL transcripts only. Do not use it for OpenCode sessions, which are stored in `opencode.db` and should be inspected through the OpenCode store path.
