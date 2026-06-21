# Hook Additional Context Card

## Payload Data Structure Outline

- Type: `hook_additional_context`
- Count: 2,378
- Shape: `type`, `content`, `hookName`, `toolUseID`, `hookEvent`
- `content` is an array of injected text blocks.

## Semantic Intent

Show what context was injected into the conversation and which hook injected it. This is human-useful prompt context, not raw transport data.

## Card Design

```text
+------------------------------------------------------------+
| [HOOK CONTEXT] UserPromptSubmit                            |
| Additional context injected into the prompt                 |
+------------------------------------------------------------+
| Hook Event           UserPromptSubmit                      |
| Hook Name            UserPromptSubmit                      |
| Tool Use ID          SessionStart or toolu_...             |
| Content              1 item / 3,514 chars                  |
+------------------------------------------------------------+
| Additional Context                    3,514 chars [Expand] |
| # Using Amplify Skills                                      |
| <EXTREMELY_IMPORTANT>                                      |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Section label is `Additional Context`.
- Collapse long content to 12 lines or 900 chars.
- Expand reveals all content array items in order.
