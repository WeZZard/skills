# Skill Listing Card

## Payload Data Structure Outline

- Type: `skill_listing`
- Count: 1,197
- Shapes:
  - `type`, `content`, `skillCount`, `isInitial`, `names`
  - `type`, `content`, `skillCount`, `isInitial`
- `content` is a newline-separated skill description list.
- `names` may be absent; use `content` parsing as fallback.

## Semantic Intent

Show the available skills by name and expose descriptions only when useful.

## Card Design

```text
+------------------------------------------------------------+
| [SKILL LISTING] Available skills                           |
| 32 skills listed                                           |
+------------------------------------------------------------+
| Skill Count          32                                    |
| Initial Listing      Yes                                   |
| Skill Names          32                                    |
| Descriptions         7,130 chars                           |
+------------------------------------------------------------+
| Skill Names                            32 items [Expand]   |
| linear-cli                                                 |
| product-planning                                           |
| done                                                       |
| next                                                       |
| +28 more                                                   |
+------------------------------------------------------------+
| Skill Descriptions                  7,130 chars [Expand]   |
| linear-cli: Manage Linear issues and projects...           |
| product-planning: Facilitate product thinking...           |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Prefer `names` for `Skill Names`.
- Parse `content` lines into `Skill Descriptions`.
- Do not call this section `Content`.
