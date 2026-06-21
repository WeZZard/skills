# Edited Text File Card

## Payload Data Structure Outline

- Type: `edited_text_file`
- Count: 217
- Shape: `type`, `filename`, `snippet`

## Semantic Intent

Show which text file was edited and a readable snippet of the change context.

## Card Design

```text
+------------------------------------------------------------+
| [EDITED FILE] CLAUDE.md                                    |
| Text file edit recorded                                    |
+------------------------------------------------------------+
| File                 /Users/wezzard/CLAUDE.md              |
+------------------------------------------------------------+
| Snippet                                300 chars [Expand]  |
| 1  # CLAUDE.md                                            |
| 2                                                          |
| 3  ## Introduction                                        |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Title uses the basename of `filename`.
- Section label is `Snippet`.
- Long snippets expand in place.
