# Queued Command Card

## Payload Data Structure Outline

- Type: `queued_command`
- Count: 337
- Shapes:
  - `type`, `prompt`, `commandMode`
  - `type`, `prompt`, `source_uuid`, `commandMode`
  - `type`, `prompt`, `commandMode`, `origin`

## Semantic Intent

Show a queued prompt or command request and where it came from.

## Card Design

```text
+------------------------------------------------------------+
| [QUEUED COMMAND] Prompt queued                             |
| A command-mode prompt was queued for the session            |
+------------------------------------------------------------+
| Command Mode         prompt                                |
| Source UUID          d04e...                               |
| Origin               plugin or unknown                     |
+------------------------------------------------------------+
| Queued Prompt                           84 chars [Expand]  |
| The computer-use mcp is now online                         |
+------------------------------------------------------------+
```

## Rendering Notes

- Use `Queued Prompt` for `prompt`.
- Show `Source UUID` and `Origin` only when present.
