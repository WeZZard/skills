# Todo Reminder Card

## Payload Data Structure Outline

- Type: `todo_reminder`
- Count: 493
- Shape: `type`, `content`, `itemCount`
- Same structural family as `task_reminder`.

## Semantic Intent

Show pending todo reminders, separate from execution task reminders.

## Card Design

```text
+------------------------------------------------------------+
| [TODO REMINDER] Todo reminder                              |
| No active todo reminders                                   |
+------------------------------------------------------------+
| Todo Items           0                                     |
+------------------------------------------------------------+
| Todos                                            0 items    |
| None                                                       |
+------------------------------------------------------------+
```

## Rendering Notes

- If `content` is non-empty, render `Todos` as an expandable ordered list.
- Empty state must be explicit, not omitted.
