# Plan Task Guidelines

<PLAN_TASK_GUIDELINES>

## Task Design Principles

- You **MUST** make each task concentrate on one aspect of the task and aware of context window size.
- You **MUST** not put too many actions into one task.
- You **MUST** slice big tasks into smaller ones to maintain context effectiveness.
- You **MUST** identify which task requires human verification and prioritize it to the plan start.
- You **MUST** identify hypotheses in the plan and organize the task with the dependency order.
- You **MUST** order tasks to match the testing strategy (e.g., reproducer before fix for bugs; integration/E2E after their prerequisites unless the plan documents a different dependency).

## Task Output Principles

**MUST:**

1. You **MUST** output the tasks with: (1) a task list and (2) a paired execution diagram.
2. You **MUST** output the task list in an ordered list where each item carries the **Appendix A: Appendix A: Task Item Format** attributes.
3. You **MUST** output the execution diagram with one of the following forms:
    - Ordered list or cascaded ordered list with task number and name if linear/tree dependencies are appeared. You **MUST NOT** connect list items with `|` in this case.
    - Workflow diagram with ordered task number and name ONLY if non-linear and graph-level dependencies are appeared. You **MUST NOT** output Mermaid syntax in this case.
4. You **MUST** ensure contents in the execution diagram and the task list consistent and aligned with each other.

**MUST NOT:**

1. You **MUST NOT** author machine-readable JSON — execute-plan dumps the folded graph and the concurrency engine explodes it.
2. You **MUST NOT** illustrate with any of the following forms:`
    - Unordered list
    - Pure text descriptions

<WORKFLOW_DIAGRAM_EXAMPLE>

```markdown
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   ┌─────────────────┐                                       │
│   │ 1. {task-name}  │                                       │
│   └────────┬────────┘                                       │
│            │                                                │
│            ▼                                                │
│   ┌─────────────────┐                                       │
│   │ 2. {task-name}  │                                       │
│   └────────┬────────┘                                       │
│            │                                                │
│            ▼                                                │
│   ┌─────────────────┐                                       │
│   │ 3. {task-name}  │                                       │
│   └─────────────────┘                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

</WORKFLOW_DIAGRAM_EXAMPLE>

**Workflow Diagram Rules:**

1. **Always use bounding box** - Wrap in outer box
2. **Sequential flow** - Use `│` and `▼` arrows between tasks
3. **Parallel tasks** - Show side-by-side with horizontal connection:

   ```markdown
   │            ┌─────────────────┐   ┌─────────────────┐
   ├───────────►│ 2a. {task}      │   │ 2b. {task}      │◄────┤
   │            └────────┬────────┘   └────────┬────────┘     │
   │                     └──────────┬──────────┘              │
   │                                ▼                         │
   ```

4. **Repetitive tasks** - Show with double-line box and loop indicator:

   ```markdown
   │            │                                                   │
   │            ▼                                                   │
   │   ╔═════════════════════════╗                                  │
   │   ║ 2. {task-name}     [×N] ║ ◀─╮                              │
   │   ╚═════════════════════════╝   │ repeat (sequantial|parallel) │
   │            │ ───────────────────╯                              │
   │            ▼                                                   │
   ```

   - Use `╔═══╗` double-line box to highlight iteration
   - Add loop arrow `◀─╮` with `│ repeat` and return line `───╯`

## Appendix A: Task Item Format

Each task in the plan contains both the implementation and audit information.

You **MUST** present each task item with the following format:

<TASK_ITEM_EXAMPLE>

```markdown
1. <Name>
    - ID: <task_id>
    - Dependencies: <task_id_1>, <task_id_2>, <task_id_3> ...
    - Acceptance Criteria:
        1. <criteria_1>
        2. <criteria_2>
        ...
    - Audit Level: <audit_level>, max attempts: <max_attempts>, human gate: <Yes|No>
```

</TASK_ITEM_EXAMPLE>

**MUST:**

1. You **MUST** attribute the corresponding item in each task with the following explanations (these map one-to-one to `schemas/task-graph.schema.json`):
    - **Name** — a short human-readable title.
    - **ID** — a unique identifier matching `^[A-Za-z0-9_-]+$` (no dots; the engine reserves `.` for subnode names).
    - **Dependencies** — the ids of the tasks this task depends on. A task's implementer starts only after every dependency's audit has passed.
    - **Acceptance Criteria** — independently checkable statements that define done. The auditor verifies each against evidence.
    - **Audit Level** — Use **$AMPLIFY_PLAN_AUDIT_LEVEL**. `1` for an Opus blind-subagent audit (the default), or `2` for an external-agent (Codex) audit that degrades to Level 1 when Codex is absent.
    - **Max Attempts** — the number of implement→audit attempts before the task is logged `failed` (non-halting).
    - **Human Gate** (optional) — set when the task requires human verification per **Appendix C: Identify Human Checkpoints** in `write-plan/SKILL.md`.

**MUST NOT:**

1. You **MUST NOT** split a task's implementer and auditor into two separate tasks in the plan.

</PLAN_TASK_GUIDELINES>
