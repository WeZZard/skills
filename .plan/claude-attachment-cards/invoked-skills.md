# Invoked Skills Card

## Payload Data Structure Outline

- Type: `invoked_skills`
- Count: 9
- Shape: `type`, `skills`
- `skills` is an array of objects with `name`, `path`, and `content`.

## Semantic Intent

Show which skills were invoked and make their loaded content available on demand.

## Card Design

```text
+------------------------------------------------------------+
| [INVOKED SKILLS] Skills loaded                             |
| 3 skills invoked                                           |
+------------------------------------------------------------+
| Skills               3                                     |
+------------------------------------------------------------+
| Skill Names                              3 items           |
| amplify:brainstorming                                    |
| amplify:write-plan                                       |
| amplify:execute-plan                                     |
+------------------------------------------------------------+
| Skill Contents                       3 items [Expand]      |
| amplify:brainstorming - Base directory...                  |
| amplify:write-plan - Base directory...                     |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- Prefer skill names in the first section.
- Put full skill content behind expandable `Skill Contents`.
