# Agent Listing Delta Card

## Payload Data Structure Outline

- Type: `agent_listing_delta`
- Count: 82
- Shape: `type`, `addedTypes`, `addedLines`, `removedTypes`, `isInitial`, `showConcurrencyNote`

## Semantic Intent

Show agent catalog changes and expose descriptions from detailed listing lines.

## Card Design

```text
+------------------------------------------------------------+
| [AGENTS DELTA] Agent catalog changed                       |
| 18 agents added, 0 removed                                 |
+------------------------------------------------------------+
| Added Agents         18                                    |
| Removed Agents       0                                     |
| Initial Listing      Yes                                   |
| Concurrency Note     Available                             |
+------------------------------------------------------------+
| Added Agents                            18 items [Expand]  |
| + amplify:audit-resolver                                  |
| + amplify:browser-use-chrome-devtools                     |
| + amplify:browser-use-playwright                          |
| +14 more                                                   |
+------------------------------------------------------------+
| Removed Agents                                   0 items    |
| None                                                       |
+------------------------------------------------------------+
| Agent Details                          18 items [Expand]   |
| amplify:audit-resolver: Resolve the auditor panel...       |
| amplify:browser-use-chrome-devtools: Drive...              |
| +16 more                                                   |
+------------------------------------------------------------+
```

## Rendering Notes

- `Added Agents` comes from `addedTypes`.
- `Agent Details` comes from `addedLines`.
- `Concurrency Note` shows a status message when `showConcurrencyNote` is true.
