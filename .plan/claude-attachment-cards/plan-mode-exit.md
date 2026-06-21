# Plan Mode Exit Card

## Payload Data Structure Outline

- Type: `plan_mode_exit`
- Count: 137
- Shape: `type`, `planFilePath`, `planExists`

## Semantic Intent

Show that Claude exited planning mode and whether the referenced plan artifact exists.

## Card Design

```text
+------------------------------------------------------------+
| [PLAN MODE EXIT] Exited plan mode                          |
| Planning mode ended                                        |
+------------------------------------------------------------+
| Plan File            /Users/wezzard/.claude/plans/...      |
| Plan Exists          No                                    |
+------------------------------------------------------------+
| Plan File Status                                           |
| Plan file is referenced but does not exist on disk.         |
+------------------------------------------------------------+
```

## Rendering Notes

- Omit the status section when `planExists` is true unless there is more useful context.
