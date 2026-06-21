# Command Permissions Card

## Payload Data Structure Outline

- Type: `command_permissions`
- Count: 233
- Shape: `type`, `allowedTools`

## Semantic Intent

Show which tools became allowed for command execution.

## Card Design

```text
+------------------------------------------------------------+
| [COMMAND PERMISSIONS] Tool permissions updated             |
| 1 tool allowed                                             |
+------------------------------------------------------------+
| Allowed Tools        1                                     |
+------------------------------------------------------------+
| Allowed Tools                                  1 item       |
| Read                                                       |
+------------------------------------------------------------+
```

## Rendering Notes

- Render `Allowed Tools` as a list.
- Empty list should show `None`.
