# Plan File Reference Card

## Payload Data Structure Outline

- Type: `plan_file_reference`
- Count: 9
- Shape: `type`, `planFilePath`, `planContent`

## Semantic Intent

Show the referenced implementation plan and its content.

## Card Design

```text
+------------------------------------------------------------+
| [PLAN FILE] cached-skipping-moth.md                        |
| Plan file referenced                                       |
+------------------------------------------------------------+
| Plan File            /Users/wezzard/.claude/plans/...      |
| Content              4,200 chars                           |
+------------------------------------------------------------+
| Plan Content                       4,200 chars [Expand]    |
| # product-driver - Per-Idea Process Graph                  |
| > For Claude:                                              |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Title uses plan filename.
- `Plan Content` expands in place.
