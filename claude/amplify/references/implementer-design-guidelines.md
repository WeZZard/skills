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

## Definition of Done

- The definition of done is the task's `acceptance_criteria`, verbatim.
- The implementer **MUST** treat each acceptance criterion as a requirement to satisfy.
- The implementer **MUST** self-check against each acceptance criterion before returning.

## Posture

- You **MUST** instruct the implementer to follow **DRY** and **YAGNI**.
- You **MUST** instruct the implementer to reuse existing functions and utilities over writing new code.
- You **MUST** instruct the implementer to use **TDD** where the task is test-bearing, and to write a reproducer before the fix for bug tasks.

## Fix Attempts

When an implementer is re-spawned because the auditor returned a failure, its prompt:

- **MUST** include the auditor's FINDINGS.
- **MUST** focus on resolving exactly those defects.
- **MUST NOT** regress prior passing criteria.

## Implementer Response Contract

The implementer's final message **MUST** be exactly this structured block. The orchestrator parses it, so it **MUST** be reproduced in this form:

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

</IMPLEMENTER_DESIGN_GUIDELINES>
