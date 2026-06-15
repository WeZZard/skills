# Implementer Design Guidelines

<IMPLEMENTER_DESIGN_GUIDELINES>

When execute-plan reaches a ready `<id>.impl` subnode, it spawns an IMPLEMENTER subagent.
You **MUST** design that subagent—model, tools, and prompt—adaptively from the task's actual content, and you **MUST** require the implementer to return the response contract below.

## Executor Selection

You **MUST** choose `impl.executor` per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`. When the executor is a built-in subagent, grant its tools to fit the task:

### Built-tin Agents Model-Tier Selection

You **MUST** choose the model tier from the task's actual complexity. You **MUST NOT** default to a single tier for every task.

- **Haiku:** Use for trivial mechanical edits—a single tiny edit, a rename, a one-line config change.
- **Sonnet:** Use for normal implementation—multi-file or multi-step changes with ordinary logic.
- **Opus:** Use for reasoning-heavy tasks of bounded scope—intricate logic, cross-cutting design, or subtle correctness concerns.
- **Fable:** Use for the most demanding tasks of large or long-horizon scope—multi-step agentic work, deep cross-system reasoning, or high-stakes correctness; the most capable tier, and the most costly.

## Tools

The Agent tool can set only `model` at spawn, not `tools`/`mcpServers`. Therefore:

**MUST:**

1. For a built-in subagent executor (`subagent(general-purpose|explore|plan)`), you **MUST** spawn it read-only: Read, Grep, Glob, Bash (Bash for the task's verification commands only).
2. For a pre-defined subagent executor (`subagent(amplify:<name>)`), you **MUST** rely on that subagent file's frontmatter for tools/MCP and pass only `model` plus the prompt.

**MUST NOT:**

1. You **MUST NOT** grant any auditor tools that modify files. The auditor verifies, it does not fix.
2. You **MUST NOT** attempt to set tools or mcpServers at spawn — they are ignored.

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

<IMPLEMENTER_SPAWNINING_PROMPT_TEMPLATE>

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

PRIOR AUDIT FINDINGS (resolve exactly these; do not regress passing criteria):
<auditor FINDINGS — omit this block on the first attempt>

## Response

You **MUST** return EXACTLY this block as your final message, then the orchestrator-continuation footer below — and nothing else:

```markdown
TASK: <id>
CHANGES: <one-paragraph summary of what was done>
FILES: <path — ADD|MODIFY|DELETE>   (one per line)
SELF-CHECK: <each acceptance criterion → met / not-met + one-line evidence>
STATUS: COMPLETE | BLOCKED — <reason if blocked>
---
<ORCHESTRATOR_CONTINUATION>
**The amplify:execute-plan scheduling loop is NOT done; do not end your turn.** This completed subnode is a *resume* signal.

**MUST:**

1. You **MUST** apply this result with its engine verb — `complete` (a passing/done subnode), `fail` (a failing auditor), or `resolve` (a resolver panel): `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" <verb> --id <GRAPH_ID> --node <this subnode's id> [...]`
2. You **MUST** fetch the new ready set: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" ready --id <GRAPH_ID>`
3. You **MUST** dispatch every newly-ready subnode in the background (per execute-plan Step 4), then keep reacting to completions.

**MUST NOT:**

You **MUST NOT** end your turn while any task is `INCOMPLETE` or any subagent is still in flight — confirm with `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" report --id <GRAPH_ID>`.

</ORCHESTRATOR_CONTINUATION>
```

- `STATUS: COMPLETE` means the implementer believes all acceptance criteria are met and the task is ready for audit.
- `STATUS: BLOCKED` means a genuine blocker—a missing dependency or a contradictory instruction. On `BLOCKED`, the orchestrator stops and raises the human.
- You **MUST NOT** use `BLOCKED` to signal that the audit might fail.
````

<IMPLEMENTER_SPAWNINING_PROMPT_TEMPLATE>

You **MUST** substitute this run's `<GRAPH_ID>` into the implementer spawning prompt's orchestrator-continuation footer so the implementer echoes a runnable command.

</IMPLEMENTER_DESIGN_GUIDELINES>
