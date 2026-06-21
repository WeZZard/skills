# Goal Status Card

## Payload Data Structure Outline

- Type: `goal_status`
- Count: 3
- Shapes:
  - `type`, `met`, `sentinel`, `condition`
  - `type`, `met`, `condition`, `reason`, `iterations`, `durationMs`, `tokens`

## Semantic Intent

Show whether a persistent goal condition was met and why.

## Card Design

```text
+------------------------------------------------------------+
| [GOAL STATUS] Goal not met                                 |
| Goal condition still requires attention                    |
+------------------------------------------------------------+
| Met                  No                                    |
| Sentinel             Yes                                   |
| Iterations           3                                     |
| Duration             525 sec                               |
| Tokens               242,943                               |
+------------------------------------------------------------+
| Goal Condition                      620 chars [Expand]     |
| Let's review the test cases:                              |
| 1. Run the test cases...                                  |
| ...                                                        |
+------------------------------------------------------------+
| Reason                                  120 chars          |
| Verification incomplete...                                |
+------------------------------------------------------------+
```

## Rendering Notes

- Show optional fields only when present.
- Use `Goal Condition` for `condition`.
