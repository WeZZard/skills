# Compact File Reference Card

## Payload Data Structure Outline

- Type: `compact_file_reference`
- Count: 8
- Shape: `type`, `filename`, `displayPath`

## Semantic Intent

Show a compact reference to a file without attached content.

## Card Design

```text
+------------------------------------------------------------+
| [FILE REFERENCE] task.test.mjs                             |
| File referenced                                            |
+------------------------------------------------------------+
| File                 /Users/wezzard/.../task.test.mjs      |
| Display Path         claude/amplify/scripts/task.test.mjs  |
+------------------------------------------------------------+
```

## Rendering Notes

- No expandable content section is required.
- Title uses basename of `filename`.
