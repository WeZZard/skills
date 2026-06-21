# Date Change Card

## Payload Data Structure Outline

- Type: `date_change`
- Count: 35
- Shape: `type`, `newDate`

## Semantic Intent

Show that the session date boundary changed.

## Card Design

```text
+------------------------------------------------------------+
| [DATE CHANGE] Date changed                                 |
| Session date changed to 2026-06-14                         |
+------------------------------------------------------------+
| New Date             2026-06-14                            |
+------------------------------------------------------------+
```

## Rendering Notes

- No content section is needed.
- Use locale formatting only if the app already formats dates elsewhere.
