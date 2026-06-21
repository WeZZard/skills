# Nested Memory Card

## Payload Data Structure Outline

- Type: `nested_memory`
- Count: 29
- Shape: `type`, `path`, `content`, `displayPath`
- `content` is an object with `path`, `type`, `content`, and `contentDiffersFromDisk`.

## Semantic Intent

Show loaded memory context and whether it differs from disk.

## Card Design

```text
+------------------------------------------------------------+
| [NESTED MEMORY] CLAUDE.md                                  |
| Project memory loaded                                      |
+------------------------------------------------------------+
| Path                 /Users/wezzard/.../CLAUDE.md          |
| Display Path         ../CLAUDE.md                          |
| Memory Type          Project                               |
| Differs From Disk    No                                    |
+------------------------------------------------------------+
| Memory Content                    1,200 chars [Expand]     |
| # CLAUDE.md                                               |
| This directory provides Claude Code plugin.                |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Extract nested `content.content` into `Memory Content`.
- Booleans render as `Yes` / `No`.
