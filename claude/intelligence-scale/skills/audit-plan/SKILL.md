---
name: audit-plan
description: You MUST invoke after plan execution completes to verify all planned changes were implemented correctly. Use as the final step of a plan-based workflow.
---

# Audit Plan Execution

## Overview

Verify that every task in the session plan file was implemented correctly by comparing planned changes against actual state.

**Core principle:** Trust evidence, not assumptions. Check every task.

**Announce at start:** "I'm using the audit-plan skill to verify plan execution."

## The Process

### Step 1: Load The Plan File

1. Read the session plan file (path is in conversation context from the planning session)
2. Extract the task list and all file references

### Step 2: Verify Each Task

For each task in the plan:

1. **Check file existence:** Glob/Read files the task was supposed to create or modify
2. **Check file content:** Verify the changes match what the plan specified (exact code, structure, config values)
3. **Check deletions:** Confirm files or code blocks the plan said to remove are actually gone
4. **Run verification commands:** If the plan included commands with expected output, run them

### Step 3: Report

Present a structured summary:

```
## Audit Summary

| # | Task | Status | Evidence |
|---|------|--------|----------|
| 1 | ... | Done / Partial / Missing | What was checked |
| 2 | ... | Done / Partial / Missing | What was checked |

### Issues Found
- [List any discrepancies, if none say "None"]
```

**Status definitions:**
- **Done** — All planned changes for this task are present and correct
- **Partial** — Some changes present, others missing or incorrect
- **Missing** — Task was not implemented

## Remember

- Read the plan file first, every time
- Check actual files, don't rely on memory of what was done
- Report evidence for each verdict
- If a task has no verifiable artifacts (e.g., "research X"), mark as Done if conversation shows it happened
- Don't fix issues found — just report them. The user decides next steps.
