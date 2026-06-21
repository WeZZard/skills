# Claude Attachment Cards Plan

## Goal

Design semantic, human-readable cards for every Claude Code attachment type found in `/Users/wezzard/.claude/projects`, so the implementation can cover all observed payloads at once instead of adding card types one by one.

## Scan Baseline

- Root scanned: `/Users/wezzard/.claude/projects`
- JSONL files scanned: 1,447
- Attachment events: 8,178
- Unique attachment types: 27
- Parse errors: 0

## Shared Card Rules

- Cards must extract useful information for humans; they must not mirror raw payload fields unless the field itself is meaningful.
- Raw JSON remains available through existing Raw surfaces.
- Visible labels must be human-readable with spaces and correct acronym casing, for example `Tool Use ID`, `Pending MCP Servers`, `Plan File Path`, `Output File Path`.
- Long sections may be collapsed, but truncated sections must show an `Expand` button in the section title bar and expand in place.
- Do not show full stdout/stderr bodies in the card. If stdout contains semantic JSON, parse and show the extracted meaning.
- Delta cards must show both added and removed sides, including empty `None` states.

## Shared Skeleton

```text
+------------------------------------------------------------+
| [KIND BADGE] Human title                            status |
| Semantic summary                                           |
+------------------------------------------------------------+
| Key facts                                                  |
| Field Label            value                               |
| Field Label            value                               |
+------------------------------------------------------------+
| Meaningful Section Title                    count [Expand] |
| extracted, human-useful content                            |
| ...                                                        |
+------------------------------------------------------------+
```

## Attachment Inventory

| Type | Count | Plan |
|---|---:|---|
| `hook_additional_context` | 2,378 | [hook-additional-context.md](hook-additional-context.md) |
| `skill_listing` | 1,197 | [skill-listing.md](skill-listing.md) |
| `deferred_tools_delta` | 1,164 | [deferred-tools-delta.md](deferred-tools-delta.md) |
| `task_reminder` | 969 | [task-reminder.md](task-reminder.md) |
| `todo_reminder` | 493 | [todo-reminder.md](todo-reminder.md) |
| `hook_success` | 466 | [hook-success.md](hook-success.md) |
| `queued_command` | 337 | [queued-command.md](queued-command.md) |
| `command_permissions` | 233 | [command-permissions.md](command-permissions.md) |
| `edited_text_file` | 217 | [edited-text-file.md](edited-text-file.md) |
| `plan_mode` | 172 | [plan-mode.md](plan-mode.md) |
| `plan_mode_exit` | 137 | [plan-mode-exit.md](plan-mode-exit.md) |
| `mcp_instructions_delta` | 96 | [mcp-instructions-delta.md](mcp-instructions-delta.md) |
| `agent_listing_delta` | 82 | [agent-listing-delta.md](agent-listing-delta.md) |
| `plan_mode_reentry` | 64 | [plan-mode-reentry.md](plan-mode-reentry.md) |
| `file` | 37 | [file.md](file.md) |
| `date_change` | 35 | [date-change.md](date-change.md) |
| `nested_memory` | 29 | [nested-memory.md](nested-memory.md) |
| `hook_non_blocking_error` | 13 | [hook-non-blocking-error.md](hook-non-blocking-error.md) |
| `auto_mode` | 10 | [auto-mode.md](auto-mode.md) |
| `auto_mode_exit` | 10 | [auto-mode-exit.md](auto-mode-exit.md) |
| `plan_file_reference` | 9 | [plan-file-reference.md](plan-file-reference.md) |
| `invoked_skills` | 9 | [invoked-skills.md](invoked-skills.md) |
| `compact_file_reference` | 8 | [compact-file-reference.md](compact-file-reference.md) |
| `task_status` | 6 | [task-status.md](task-status.md) |
| `ultra_effort_enter` | 3 | [ultra-effort-enter.md](ultra-effort-enter.md) |
| `goal_status` | 3 | [goal-status.md](goal-status.md) |
| `hook_blocking_error` | 1 | [hook-blocking-error.md](hook-blocking-error.md) |

## Implementation Outline

- Build a shared attachment card model with:
  - `type`, `badge`, `title`, `summary`, `facts`, `sections`, `rawEventKey`
  - `sections[].label`, `sections[].kind`, `sections[].countLabel`, `sections[].collapsed`, `sections[].expanded`, `sections[].expandable`
- Add semantic extractors by attachment type. Unknown types fall back to scalar facts plus expandable object/list/text sections.
- Add a shared label formatter that preserves common acronyms: `ID`, `MCP`, `JSON`, `URL`, `CLI`, `API`.
- Add expand/collapse state keyed by `rawEventKey + section.fieldKey`.

## Verification Outline

- Extend the browser fixture or scanner fixture to include all 27 attachment types.
- Verify every type renders a card with a badge, title, summary, facts, and at least one meaningful content section or explicit empty state.
- Verify long sections expand and collapse in place.
- Verify Raw still contains complete payloads.
- Run:
  - `uv run python -m compileall -q app scripts tests`
  - `uv run pytest`
  - `uv run ruff check .`
  - `node --check app/static/js/conversation.js`
  - `uv run python scripts/validate_browser.py`
