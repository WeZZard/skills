---
name: execute-plan
description: You MUST invoke this skill immediately when you have a finalized plan file and are ready to begin implementation. Always use this skill before starting to write code based on a plan.
---

# Executing Plans

## Overview

Load plan, execute tasks, raise human verification gate if necessary.

**Core principle:** Execute with human verification gate.

**Announce at start:** "I'm using the execute-plan skill to implement this plan."

## The Process

### Step 1: Load The Plan File

1. Read plan file

### Step 2: Execute Tasks by Maximizing the Parallelism

You **MUST** execute the tasks with subagents by maximizing the parallelism but also take the tasks dependencies into consideration.

### Step 3: Raise Human Verification Gate If Neccessary

Some tasks may require human verification. Stop execution and raise a gate with the AskUserQuestion tool for human verification.

### Step 4: Continue

Based on feedback:

- Apply changes if needed
- Execute the tasks
- Repeat until complete

## Additional Conditions to Stop and Ask for Help

**STOP executing immediately when:**

- Hit a blocker mid-batch (missing dependency, test fails, instruction unclear)
- Findings indicate the plan has critical gaps preventing execution
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## Remember

- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Between batches: just report and wait
- Stop when blocked, don't guess
