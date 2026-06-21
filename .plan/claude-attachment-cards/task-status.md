# Task Status Card

## Payload Data Structure Outline

- Type: `task_status`
- Count: 6
- Shape: `type`, `taskId`, `taskType`, `description`, `status`, `deltaSummary`, `outputFilePath`

## Semantic Intent

Show the state of a delegated or local task.

## Card Design

```text
+------------------------------------------------------------+
| [TASK STATUS] Implement engine-loop-state          complete|
| Local agent task completed                                |
+------------------------------------------------------------+
| Task ID              af0f7940a364ab246                    |
| Task Type            local_agent                           |
| Status               completed                             |
| Output File          /private/tmp/claude-501/...           |
+------------------------------------------------------------+
| Description                            28 chars            |
| Implement engine-loop-state                                |
+------------------------------------------------------------+
| Delta Summary                                             |
| None                                                       |
+------------------------------------------------------------+
```

## Rendering Notes

- `Description` is usually short but should support expansion.
- Omit `Delta Summary` only if it is absent; show `None` when explicitly null.
