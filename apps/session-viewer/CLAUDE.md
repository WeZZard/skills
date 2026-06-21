# Session Viewer

## Claude Code Attachment Scanner

Use `uv run python scripts/scan_claude_attachments.py` from this app directory when:

- Adding or changing Claude Code attachment card presentations.
- Investigating a user-provided Claude Code transcript that contains an unknown or surprising attachment type.
- Auditing whether the renderer still covers all attachment types present under a Claude projects directory.
- Updating fixture coverage for attachment cards in `scripts/validate_browser.py`.

Prefer scanning the same source directory the app will read:

```bash
uv run python scripts/scan_claude_attachments.py --projects-dir ~/.claude/projects
uv run python scripts/scan_claude_attachments.py --claude-config-dir ~/.claude --json
```

The utility is for Claude Code JSONL transcripts only. Do not use it for OpenCode sessions, which are stored in `opencode.db` and should be inspected through the OpenCode store path.
