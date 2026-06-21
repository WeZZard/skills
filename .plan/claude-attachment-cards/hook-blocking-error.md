# Hook Blocking Error Card

## Payload Data Structure Outline

- Type: `hook_blocking_error`
- Count: 1
- Shape: `type`, `hookName`, `toolUseID`, `hookEvent`, `blockingError`
- `blockingError` is an object with a message and command.

## Semantic Intent

Show hook failure that blocked execution and the command that failed.

## Card Design

```text
+------------------------------------------------------------+
| [HOOK BLOCKED] Stop                                        |
| Hook blocked execution                                     |
+------------------------------------------------------------+
| Hook Event           Stop                                  |
| Hook Name            Stop                                  |
| Tool Use ID          08446c51-...                          |
+------------------------------------------------------------+
| Blocking Error                         140 chars [Expand]  |
| amplify:execute-plan loop has ready work but no...         |
+------------------------------------------------------------+
| Blocking Command                                           |
| node "${CLAUDE_PLUGIN_ROOT}/hooks/loop-resume.mjs"         |
+------------------------------------------------------------+
```

## Rendering Notes

- Extract nested `blockingError.blockingError` into `Blocking Error`.
- Extract nested `blockingError.command` into `Blocking Command`.
