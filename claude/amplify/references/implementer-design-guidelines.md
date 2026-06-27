# Implementer Design Guidelines

<IMPLEMENTER_DESIGN_GUIDELINES>

When execute-plan reaches a ready `<id>.impl` subnode, it spawns an IMPLEMENTER subagent.
You **MUST** design that subagent—model, tools, and prompt—adaptively from the task's actual content, and you **MUST** require the implementer to return the response contract below.

## Executor Selection

The implementer executor is **always** `subagent(general-purpose)`. You **MUST NOT** select a per-task implementer executor — the `implement` node type fixes it to `subagent(general-purpose)` (see `${CLAUDE_PLUGIN_ROOT}/schemas/node-types.json`). Specialized GUI/behavioral/external executors are **auditor** choices, resolved at runtime by the `amplify:audit-resolver` agent onto the audit panel (per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`), never onto the implementer.

You design only the implementer's **model tier** and its read-only tools:

### Built-in Agents Model-Tier Selection

You **MUST** choose the model tier from the task's actual complexity. You **MUST NOT** default to a single tier for every task.

- **Haiku:** Use for trivial mechanical edits—a single tiny edit, a rename, a one-line config change.
- **Sonnet:** Use for normal implementation—multi-file or multi-step changes with ordinary logic.
- **Opus:** Use for reasoning-heavy tasks of bounded scope—intricate logic, cross-cutting design, or subtle correctness concerns.
- **Fable:** Use for the most demanding tasks of large or long-horizon scope—multi-step agentic work, deep cross-system reasoning, or high-stakes correctness; the most capable tier, and the most costly.

## Tools

The Agent tool can set only `model` at spawn, not `tools`/`mcpServers`. The implementer is always the built-in `subagent(general-purpose)`. Therefore:

**MUST:**

1. You **MUST** spawn the implementer (`subagent(general-purpose)`) read-only: Read, Grep, Glob, Bash (Bash for the task's verification commands only), passing only `model` plus the prompt.

**MUST NOT:**

1. You **MUST NOT** grant any auditor tools that modify files. The auditor verifies, it does not fix.
2. You **MUST NOT** attempt to set tools or mcpServers at spawn — they are ignored.
3. You **MUST NOT** grant or allow the `Agent` tool to any spawned subagent — every subagent is a leaf and **MUST NOT** spawn further subagents. Built-in executors (`general-purpose`/`explore`/`plan`) carry the `Agent` tool and cannot be tools-restricted at spawn, so the spawning prompt **MUST** restate the Agent-tool ban and the graph-engine ban.

## Context Injection

The implementer prompt **MUST** include:

- The task's exact file paths.
- The artifacts and outputs of the upstream (dependency) tasks this task builds on.
- The relevant existing code and patterns to reuse.
- Clear scope boundaries: what is in scope versus what is explicitly out of scope.
- The session **plan file path** (`PLAN FILE:`) and the task's **design aspect** (`DESIGN ASPECT:`). The implementer **MAY** read the plan's Design and Verification sections to ground THIS task, but **MUST** keep to its declared scope (FILES IN SCOPE / OUT OF SCOPE) and **MUST NOT** implement against other tasks.

## Fix Attempts

When an implementer is re-spawned because the auditor returned a failure, its prompt:

- **MUST** include the auditor's FINDINGS.
- **MUST** focus on resolving exactly those defects.
- **MUST NOT** regress prior passing criteria.

## On Repeated Tool Errors

**MUST:**

1. When a tool call fails repeatedly (e.g., wrong arguments, missing files, permission issues), the implementer **MUST** re-read the task scope (FILES IN SCOPE / acceptance criteria) and confirm the failing call is actually required by the current step.
2. If the failing call IS in scope, the implementer **MUST** analyze the specific cause of failure and fix exactly that cause.
3. If the failing call IS NOT in scope, the implementer **MUST** stop making that call and return to the plan.

**MUST NOT:**

1. The implementer **MUST NOT** guess new parameters, alternate tool names, or alternative file paths when a tool call fails — doing so introduces noise and drifts away from the task.
2. If the specific cause cannot be fixed and the call is required, the implementer **MUST** return `STATUS: BLOCKED` with a clear description of the blocker. Do **NOT** use `BLOCKED` to signal that the audit might fail.

## Spawning Prompt Template

This is the implementer's prompt; `execute-plan` spawns the chosen `impl.executor` with it under the single spawn strategy in its scheduling loop (the model follows **Model-Tier Selection**). Replace every `<...>` placeholder. Omit the `PRIOR AUDIT FINDINGS` block on the first attempt; include it (verbatim from the auditor) on a re-spawn.

<IMPLEMENTER_SPAWNING_PROMPT_TEMPLATE>

````markdown
## Goal
You are the IMPLEMENTER for task <id> in an execute-plan run.
Implement it, then self-check.

GOAL: <task name / one-line goal>
PLAN FILE: <absolute path to the session plan file — you MAY read its Design/Verification for THIS task, stay in scope>
DESIGN ASPECT: <the task's (Aspect: …) design component>

FILES IN SCOPE: <exact paths to create/modify/delete>
OUT OF SCOPE: <what you must not touch>
UPSTREAM ARTIFACTS: <paths/outputs from completed dependency tasks to build on>
REUSE: <existing functions/utilities/patterns to prefer over new code>

## Acceptance Criteria

<ACCEPTANCE_CRITERIA>
- <criterion 1 from task's acceptance_criteria>
- <criterion 2 from task's acceptance_criteria>
- ...
</ACCEPTANCE_CRITERIA>

- You **MUST** treat each acceptance criterion as a requirement to satisfy.
- You **MUST** self-check against each acceptance criterion before returning.

## Implementation Principles

POSTURE: DRY, YAGNI; reuse over new code; TDD where the task is test-bearing
(write a reproducer before the fix for bug tasks).

You **MUST NOT** use the `Agent` tool and **MUST NOT** spawn subagents — you are a leaf in the execution tree.
You **MUST NOT** run the graph engine (`task.mjs`). No subcommand is yours to run.

**MUST NOT:**

- You **MUST NOT** run `task.mjs init`
- You **MUST NOT** run `task.mjs ready`
- You **MUST NOT** run `task.mjs dispatch`
- You **MUST NOT** run `task.mjs active`
- You **MUST NOT** run `task.mjs complete`
- You **MUST NOT** run `task.mjs resolve`
- You **MUST NOT** run `task.mjs fail`
- You **MUST NOT** run `task.mjs hold`
- You **MUST NOT** run `task.mjs release`
- You **MUST NOT** run `task.mjs holds`
- You **MUST NOT** run `task.mjs wait-for-free`
- You **MUST NOT** run `task.mjs resource-of`
- You **MUST NOT** run `task.mjs report`
- You **MUST NOT** run `task.mjs status`

PRIOR AUDIT FINDINGS (resolve exactly these; do not regress passing criteria):
<auditor FINDINGS — omit this block on the first attempt>

## Response

You **MUST** return EXACTLY this block as your final message, with no extra commentary:

```markdown
TASK: <id>
CHANGES: <one-paragraph summary of what was done>
FILES: <path — ADD|MODIFY|DELETE>   (one per line)
SELF-CHECK: <each acceptance criterion → met / not-met + one-line evidence>
STATUS: COMPLETE | BLOCKED — <reason if blocked>
```

- `STATUS: COMPLETE` means the implementer believes all acceptance criteria are met and the task is ready for audit.
- `STATUS: BLOCKED` means a genuine blocker—a missing dependency or a contradictory instruction. On `BLOCKED`, the orchestrator stops and raises the human.
- You **MUST NOT** use `BLOCKED` to signal that the audit might fail.
````

<IMPLEMENTER_SPAWNING_PROMPT_TEMPLATE>

</IMPLEMENTER_DESIGN_GUIDELINES>
