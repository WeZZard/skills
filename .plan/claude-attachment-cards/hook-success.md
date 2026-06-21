# Hook Success Card

## Payload Data Structure Outline

- Type: `hook_success`
- Count: 466
- Shape: `type`, `hookName`, `toolUseID`, `hookEvent`, `content`, `stdout`, `stderr`, `exitCode`, `command`, `durationMs`
- Semantic hint: all scanned `stdout` values are JSON; 206 contain `hookSpecificOutput.additionalContext`.

## Semantic Intent

Show the hook outcome and extract useful context from stdout JSON. Do not render a generic Standard Output section.

## Card Design

```text
+------------------------------------------------------------+
| [HOOK SUCCESS] SessionStart:startup                 exit 0 |
| Session start hook added execution context                 |
+------------------------------------------------------------+
| Hook Event           SessionStart                          |
| Hook Name            SessionStart:startup                  |
| Tool Use ID          311ef9d1-...                          |
| Command              ${CLAUDE_PLUGIN_ROOT}/hooks/...       |
| Exit Code            0                                     |
| Duration             637 ms                                |
+------------------------------------------------------------+
| Additional Context                  3,514 chars [Expand]   |
| # Using Amplify Skills                                      |
| <EXTREMELY_IMPORTANT>                                      |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Parse `stdout` as JSON.
- If `stdout.hookSpecificOutput.additionalContext` exists, render it as `Additional Context`.
- If no semantic content is extractable, show `Output: Available in Raw` in key facts only.
- Never render full stdout/stderr bodies in the card.
