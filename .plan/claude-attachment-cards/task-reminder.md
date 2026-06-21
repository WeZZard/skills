# Task Reminder Card

## Payload Data Structure Outline

- Type: `task_reminder`
- Count: 969
- Shape: `type`, `content`, `itemCount`
- `content` is an array of reminder items.

## Semantic Intent

Show whether Claude has active task reminders and list them when present.

## Card Design

```text
+------------------------------------------------------------+
| [TASK REMINDER] Task reminder                              |
| No active task reminders                                   |
+------------------------------------------------------------+
| Reminder Items       0                                     |
+------------------------------------------------------------+
| Reminders                                        0 items    |
| None                                                       |
+------------------------------------------------------------+
```

When reminders exist:

```text
+------------------------------------------------------------+
| Reminders                              6 items [Expand]    |
| 1. Finish verification                                    |
| 2. Update plan audit                                      |
| 3. Capture screenshots                                    |
| +3 more                                                   |
+------------------------------------------------------------+
```

## Rendering Notes

- Summary is `No active task reminders` when `itemCount` is 0.
- Use `Reminders`, not `Content`, for the section label.
