# Plan Mode Card

## Payload Data Structure Outline

- Type: `plan_mode`
- Count: 172
- Shape: `type`, `reminderType`, `isSubAgent`, `planFilePath`, `planExists`

## Semantic Intent

Show that Claude entered planning mode and whether the plan file exists.

## Card Design

```text
+------------------------------------------------------------+
| [PLAN MODE] Entered plan mode                              |
| Planning reminder is active                                |
+------------------------------------------------------------+
| Reminder Type        full                                  |
| Subagent             No                                    |
| Plan File            /Users/wezzard/.claude/plans/...      |
| Plan Exists          No                                    |
+------------------------------------------------------------+
| Plan File Status                                           |
| Plan file is referenced but does not exist on disk.         |
+------------------------------------------------------------+
```

## Rendering Notes

- Convert booleans to `Yes` / `No`.
- Show a status section when `planExists` is false.
