---
name: recover-from-errors
description: You SHALL use when you continually encounter errors or unexpected issues during plan execution.
---

# Recover from Errors

This skill helps prevent goal drift when tool invocations fail.

When you encounter errors with tool calls (e.g., wrong arguments, missing files, permission issues), **DO NOT** simply generalize or guess new parameters, alternative tool locations, as this often leads to drifting away from the original goal by introducing noise to the context.

## Recovery Procedure

1. **Check the Plan**: Immediately look up the plan file of the session to verify the context of the current operation.
2. **Verify Alignment**: Determine if the tool call that generated the error is actually part of the tasks currently being executed in the plan.
    * *Ask Yourself*: "Is the action I just attempted explicitly required by the current step in the plan?"
3. **Re-align to the Plan**:
    * If the failing action **IS** part of the plan: Analyze why it failed (e.g., prerequisite missing, wrong path) and fix the specific issue.
    * f the failing action **IS NOT** part of the plan: **STOP calling the tool again**. You may have drifted. Re-read the plan and get back on track with the specified tasks.
