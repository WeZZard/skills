# Plan Mode Reentry Card

## Payload Data Structure Outline

- Type: `plan_mode_reentry`
- Count: 64
- Shape: `type`, `planFilePath`

## Semantic Intent

Show that the session returned to an existing plan workflow.

## Card Design

```text
+------------------------------------------------------------+
| [PLAN MODE REENTRY] Re-entered plan mode                   |
| Existing plan workflow resumed                             |
+------------------------------------------------------------+
| Plan File            /Users/wezzard/.claude/plans/...      |
+------------------------------------------------------------+
```

## Rendering Notes

- If future payloads include existence or status, add a `Plan File Status` section.
