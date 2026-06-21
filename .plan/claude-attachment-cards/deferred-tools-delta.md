# Deferred Tools Delta Card

## Payload Data Structure Outline

- Type: `deferred_tools_delta`
- Count: 1,164
- Shapes:
  - `type`, `addedNames`, `addedLines`, `removedNames`, `readdedNames`
  - plus optional `pendingMcpServers`

## Semantic Intent

Show tool availability changes honestly. Delta means added, removed, and re-added sides must all be visible.

## Card Design

```text
+------------------------------------------------------------+
| [TOOLS DELTA] Deferred tools changed                       |
| 167 tools added, 0 removed, 0 re-added                     |
+------------------------------------------------------------+
| Added Tools          167                                   |
| Removed Tools        0                                     |
| Re-added Tools       0                                     |
| Pending MCP Servers  0                                     |
+------------------------------------------------------------+
| Added Tools                            167 items [Expand]  |
| + CronCreate                                               |
| + CronDelete                                               |
| + CronList                                                 |
| + DesignSync                                               |
| +161 more                                                  |
+------------------------------------------------------------+
| Removed Tools                                     0 items   |
| None                                                       |
+------------------------------------------------------------+
| Re-added Tools                                    0 items   |
| None                                                       |
+------------------------------------------------------------+
| Tool Details                          167 items [Expand]   |
| CronCreate                                                |
| CronDelete                                                |
| CronList                                                  |
| +164 more                                                 |
+------------------------------------------------------------+
```

## Rendering Notes

- `Added Tools` comes from `addedNames`.
- `Removed Tools` comes from `removedNames`.
- `Re-added Tools` comes from `readdedNames`.
- `Tool Details` comes from `addedLines` when it differs meaningfully from `addedNames`.
- Always show empty delta sides as `None`.
