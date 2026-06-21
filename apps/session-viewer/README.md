# Session Viewer

Read-only FastAPI web GUI for Claude Code JSONL sessions and OpenCode SQLite sessions.

## Run

```bash
uv run python -m app --claude-config-dir ~/.claude --opencode-data-dir ~/.local/share/opencode
```

Claude source precedence:

1. `--projects-dir` or `CLAUDE_PROJECTS_DIR`
2. `--claude-config-dir` or `CLAUDE_CONFIG_DIR`, using `<config>/projects`
3. `--claude-home` or `CLAUDE_CODE_HOME`, using `<home>/projects`
4. default `~/.claude/projects`

OpenCode source precedence:

1. `--opencode-data-dir` or `OPENCODE_DATA_DIR`
2. `$XDG_DATA_HOME/opencode`
3. default `~/.local/share/opencode`

The dashboard also accepts URL-scoped source path inputs for each tab. These
values are not written to app config, cookies, or local storage.

## Verify

```bash
uv run pytest
uv run ruff check .
node --check app/static/js/conversation.js
uv run playwright install chromium
uv run python scripts/validate_browser.py
uv run python scripts/validate_reference_interaction_plan.py
```

The UI exposes stable transcript-element selectors such as
`data-testid="transcript-message"`, `data-testid="tool-call"`,
`data-testid="tool-result"`, `data-testid="subagent-node"`, and
`data-testid="subagent-toggle"` for browser validation.

`scripts/validate_browser.py` builds temporary Claude and OpenCode fixtures,
starts the viewer on a free local port, and verifies dashboard/conversation
rendering, source tabs, Timeline as the default layout, Waterfall navigation,
Backward/Forward focus restoration, golden-section Waterfall sizing, Agent Tree
subagent toggles, independent subagent scrolling, timeline spawn edges,
large-session DOM budgets, OpenCode transcript readability, and
Studio/desktop/mobile overflow.

## Utilities

Scan Claude Code JSONL transcripts for attachment types and payload shapes:

```bash
uv run python scripts/scan_claude_attachments.py --projects-dir ~/.claude/projects
uv run python scripts/scan_claude_attachments.py --claude-config-dir ~/.claude --json
```
