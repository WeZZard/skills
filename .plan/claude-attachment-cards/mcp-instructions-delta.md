# MCP Instructions Delta Card

## Payload Data Structure Outline

- Type: `mcp_instructions_delta`
- Count: 96
- Shape: `type`, `addedNames`, `addedBlocks`, `removedNames`

## Semantic Intent

Show MCP server instruction changes: added servers, removed servers, and instruction blocks.

## Card Design

```text
+------------------------------------------------------------+
| [MCP INSTRUCTIONS] MCP instructions changed                |
| 1 MCP server added, 0 removed                              |
+------------------------------------------------------------+
| Added Servers        1                                     |
| Removed Servers      0                                     |
| Instruction Blocks   1                                     |
+------------------------------------------------------------+
| Added Servers                                    1 item     |
| + cua-driver                                               |
+------------------------------------------------------------+
| Removed Servers                                  0 items    |
| None                                                       |
+------------------------------------------------------------+
| Instruction Blocks                    1 block [Expand]     |
| ## cua-driver                                             |
| cua-driver: cross-platform background computer-use...       |
| ...                                                        |
+------------------------------------------------------------+
```

## Rendering Notes

- `Added Servers` comes from `addedNames`.
- `Removed Servers` comes from `removedNames`.
- `Instruction Blocks` comes from `addedBlocks`.
- Always show removed side, even when empty.
