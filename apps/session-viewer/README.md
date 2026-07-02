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

## Timeline performance architecture

Timeline boot uses protocol v2 (`GET /api/conversation/{agent}/{id}/timeline`):

- Block geometry is purely ordinal (`y = ordinal x 40`, `x = lane x 208`) and
  one capsule equals one non-blank JSONL line, so the boot payload ships only
  **capsule seeds** for the main track (kind ingredients, nav-key fields, a
  140-char preview) plus per-subagent **capsule counts** — never message
  bodies. A 500-subagent session boots in a few hundred gzipped KB instead of
  tens of MB.
- A persistent per-session SQLite index (`~/.cache/session-viewer`, override
  with `SESSION_VIEWER_CACHE_DIR`) caches newline counts per transcript file
  (keyed by mtime+size) and the built boot payload (keyed by the session
  fingerprint), so warm boots are single-digit milliseconds. Deleting the
  cache only costs a rebuild.
- Track content loads per file on visibility (`/track/{id}` parses one JSONL,
  not the session tree); the detail popup upgrades seed capsules via
  `/message`; `/raw_event` reads its line directly (with path containment).
  Waterfall lazily loads the full main track on first entry.
- The client renders blocks in pooled, recycled, `translate3d`-positioned
  tiles (`timeline_renderer.js`, one tile per lane x 16-row chunk, UIKit
  UICollectionView-style). Scroll frames inside the same tile window do zero
  DOM work; geometry recomputes only per epoch (resize, data arrival, search
  visibility), never per frame. Not-yet-loaded rows render as fixed-geometry
  skeleton blocks that swap in place when data arrives.
- Parsing runs in a thread pool off the event loop; responses are gzipped and
  ETagged (`If-None-Match` revalidation returns 304).

Live sessions: any file append changes the fingerprint, which rebuilds the
boot payload on the next load (only changed files are re-scanned). In-place
incremental append indexing and client-side live polling are possible future
extensions on the same fingerprint scheme.

## Utilities

Scan Claude Code JSONL transcripts for message kinds and structural shapes:

```bash
uv run python scripts/scan_claude_message_kinds.py --projects-dir ~/.claude/projects
uv run python scripts/scan_claude_message_shapes.py --projects-dir ~/.claude/projects --json
uv run python scripts/compile_claude_message_type_design.py \
  --projects-dir ~/.claude/projects \
  --array-output reports/claude-transcript-scans/message-type-array.json \
  --design-output reports/claude-transcript-scans/message-type-card-design.md
```

Both scanners recurse through main and subagent JSONL transcripts. The legacy
`scripts/scan_claude_attachments.py` command remains available for
attachment-only audits.

The compiler combines the kind and shape scans into a top-level type/subtype
array and a renderer design report for Waterfall cards, Waterfall navigation
items, Timeline blocks, and Timeline detail cards.
