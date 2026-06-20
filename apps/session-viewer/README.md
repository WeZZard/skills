# Claude Code Session Viewer

Read-only FastAPI web GUI for Claude Code JSONL sessions.

## Run

```bash
uv run python -m app --claude-home ~/.claude
```

Claude source precedence:

1. `--projects-dir` or `CLAUDE_PROJECTS_DIR`
2. `--claude-home` or `CLAUDE_CODE_HOME`, using `<home>/projects`
3. default `~/.claude/projects`

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

`scripts/validate_browser.py` builds a temporary Claude fixture, starts the
viewer on a free local port, and verifies dashboard/conversation rendering,
Focus and Overview layouts, left navigation tabs, Return/Forward
focus restoration, golden-section Focus sizing, Agent Tree subagent toggles,
independent subagent scrolling, overview spawn edges, large-session DOM
budgets, and Studio/desktop/mobile overflow.
