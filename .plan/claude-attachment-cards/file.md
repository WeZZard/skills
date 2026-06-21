# File Card

## Payload Data Structure Outline

- Type: `file`
- Count: 37
- Shape: `type`, `filename`, `content`, `displayPath`
- `content` is often an object with nested file metadata and text.

## Semantic Intent

Show a referenced file, its display path, and readable file content metadata.

## Card Design

```text
+------------------------------------------------------------+
| [FILE] product-driver-m4-graph.json                        |
| File content attached                                      |
+------------------------------------------------------------+
| File                 /tmp/product-driver-m4-graph.json     |
| Display Path         ../../../../tmp/product-driver...     |
| Content Type         text                                  |
| Lines                28                                    |
+------------------------------------------------------------+
| File Content                          28 lines [Expand]    |
| {                                                          |
|   "version": 1,                                            |
|   "nodes": [                                               |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Prefer nested `content.file.content` when present.
- Use nested line metadata for facts.
- Fall back to rendering `content` as JSON when no nested text exists.
