# Hook Non-Blocking Error Card

## Payload Data Structure Outline

- Type: `hook_non_blocking_error`
- Count: 13
- Shape: `type`, `hookName`, `toolUseID`, `hookEvent`, `stderr`, `stdout`, `exitCode`, `command`, `durationMs`

## Semantic Intent

Show hook failure details that did not block execution.

## Card Design

```text
+------------------------------------------------------------+
| [HOOK WARNING] Stop                                exit 127 |
| Hook failed with non-blocking error                         |
+------------------------------------------------------------+
| Hook Event           Stop                                  |
| Hook Name            Stop                                  |
| Tool Use ID          f5610fd3-...                          |
| Command              node "${CLAUDE_PLUGIN_ROOT}/..."      |
| Exit Code            127                                   |
| Duration             10 ms                                 |
+------------------------------------------------------------+
| Error Message                          86 chars [Expand]   |
| Failed with non-blocking status code: /bin/sh: node...      |
+------------------------------------------------------------+
```

## Rendering Notes

- Extract `stderr` into `Error Message`.
- Do not show empty stdout.
