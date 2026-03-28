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

### Step 1: Check If It Is Necessary to Execute The Plan

The user may pause execution after approving the plan file or when the plan file is loaded at the start of a session.
You **CAN** continue the plan execution **ONLY** after you receive an explicit “continue” signal in the conversation and confirm there are no newer conflicting instructions.

### Step 2: Load The Plan File

Read plan file

### Step 3: Execute Tasks by Maximizing the Parallelism

#### 3.1: Build the Task Dependency Graph

Before executing any task, analyze the plan's task list and build a dependency graph:

1. Identify each task and its declared dependencies (upstream tasks it depends on).
2. Determine the **topological levels** of the graph:
   - **Level 0 (leaf tasks):** Tasks with no upstream dependencies.
   - **Level 1:** Tasks whose dependencies are all in Level 0.
   - **Level N:** Tasks whose dependencies are all in levels < N.

#### 3.2: Execute Level by Level, Leaves First

You **MUST** execute in topological order — start from Level 0 and proceed upward:

1. Execute **all tasks in the current level** in parallel.
2. Wait for **all tasks in the current level** to complete.
3. Merge and propagate results to the next level.
4. Repeat until all levels are complete.

#### 3.3: Decide Subagent vs Inline Execution per Task

You **MUST NOT** blindly spawn a subagent for every task. Apply the following decision rule:

**Spawn a subagent** when the task involves ANY of:
- Multiple file edits
- Running commands and interpreting output
- Research or web searches
- Non-trivial reasoning or multi-step logic

**Execute inline** (in the current agent context) when the task is ALL of:
- A single, small, self-contained action (e.g., one file edit under ~30 lines, one config change, one simple rename)
- Independent of other concurrent tasks' outputs
- Quick enough that subagent orchestration overhead would exceed the task itself

When multiple small independent tasks at the same level each qualify for inline execution, batch them together and execute them sequentially inline rather than spawning multiple subagents.

#### 3.4: Subagent Allocation Rules

When spawning subagents:
- You **MUST** spawn multiple agents in ONE message to maximize the parallelism.
- You **MUST** allocate one subagent per task (do not combine unrelated tasks into one subagent).
- You **MUST** provide each subagent with the full context it needs: relevant file paths, expected inputs from completed upstream tasks, and clear success criteria.
- You **MUST** wait for all subagents at the current level to complete before proceeding to the next level.

### Step 4: Raise Human Verification Gate If Neccessary

Some tasks may require human verification. Stop execution and raise a gate with the AskUserQuestion tool for human verification.

### Step 5: Continue

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
