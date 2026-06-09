# Implementer Design Guidelines

<IMPLEMENTER_DESIGN_GUIDELINES>

When execute-plan reaches a ready `<id>.impl` subnode, it spawns an IMPLEMENTER subagent.
You **MUST** design that subagent—model, tools, and prompt—adaptively from the task's actual content, and you **MUST** require the implementer to return the response contract below.

## Model-Tier Selection

You **MUST** choose the model tier from the task's actual complexity. You **MUST NOT** default to a single tier for every task.

- **Haiku:** Use for trivial mechanical edits—a single tiny edit, a rename, a one-line config change.
- **Sonnet:** Use for normal implementation—multi-file or multi-step changes with ordinary logic.
- **Opus:** Use for reasoning-heavy tasks—intricate logic, cross-cutting design, or subtle correctness concerns.

## Tool Granting

- You **MUST** grant only the tools the task needs.
- You **MUST** grant Edit/Write only when the task changes files.
- You **MUST** grant Bash only when the task must run commands.
- You **MUST** grant web tools only when the task requires research.
- You **MUST NOT** over-grant tools beyond what the task requires.

## Context Injection

The implementer prompt **MUST** include:

- The task's exact file paths.
- The artifacts and outputs of the upstream (dependency) tasks this task builds on.
- The relevant existing code and patterns to reuse.
- Clear scope boundaries: what is in scope versus what is explicitly out of scope.

## Fix Attempts

When an implementer is re-spawned because the auditor returned a failure, its prompt:

- **MUST** include the auditor's FINDINGS.
- **MUST** focus on resolving exactly those defects.
- **MUST NOT** regress prior passing criteria.

## Spawning Prompt Template

You **MUST** spawn the implementer with the Agent tool using the configuration and prompt below. Replace every `<...>` placeholder. Omit the `PRIOR AUDIT FINDINGS` block on the first attempt; include it (verbatim from the auditor) on a re-spawn.

**Config:**

- `model:` `<haiku | sonnet | opus>` — per **Model-Tier Selection**.
- `tools:` `<only those the task needs>` — per **Tool Granting**.

**Prompt:**

<IMPLEMENTER_SPAWNINING_PROMPT_TEMPLATE>

````markdown
## Goal
You are the IMPLEMENTER for task <id> in an execute-plan run.
Implement it, then self-check.

GOAL: <task name / one-line goal>

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

<IMPLEMENTER_SPAWNINING_PROMPT_TEMPLATE>

</IMPLEMENTER_DESIGN_GUIDELINES>
