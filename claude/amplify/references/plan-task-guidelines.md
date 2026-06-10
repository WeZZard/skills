# Plan Task Guidelines

<PLAN_TASK_GUIDELINES>

## Task Design

**MUST:**

1. You **MUST** break down the goal into discrete tasks.
2. Each task **MUST** suffice the following criteria:
    - Has a single, clear purpose.
    - Represent a logical step in the plan.
    - Has identifiable inputs and outputs
    - Is neither too granular nor too broad

## Dependencies Design

**MUST:**

1. You **MUST** identify which task requires human verification and prioritize it to the execution start.
2. You **MUST** identify assumptions in the plan and develop the task dependencies based on the dependencies of the assumptions.
3. You **MUST** order tasks to match the **testing strategy**.

<TESTING_STRATEGY_EXAMPLES>

1. Reproducer before fix for bugs
2. Integration/E2E after their prerequisites unless the plan documents a different dependency

</TESTING_STRATEGY_EXAMPLES>

**MUST NOT:**

- You **MUST NOT** create tasks that are just "validate" or "check" - those are part of execution

## Communication

**MUST:**

1. You **MUST** output the tasks with: (1) a task list and (2) a paired execution diagram.
2. You **MUST** output the execution diagram before the tast list.
3. You **MUST** output the task list in an ordered list follows the format in **Appendix A: Task List Format**.
4. You **MUST** output the execution diagram follows the format in **Appendix B: Execution Diagram Format**.
5. You **MUST** ensure contents in the execution diagram and the task list consistent and aligned with each other.

## Appendix A: Task List Format

Each task in the plan contains both the implementation and audit information.

You **MUST** present the task list with the following format:

<TASK_LIST_EXAMPLE>

```markdown
1. <Task 1 Name>
    - ID: <task_id_1>
    - Acceptance Criteria:
        1. <criteria_1>
        2. <criteria_2>
        ...
    - Audit Level: <audit_level>, max attempts: <max_attempts>, human gate: <Yes|No>
2. <Task 2 Name>
    - ID: <task_id_2>
    - Dependencies: <task_id_1>
    - Acceptance Criteria:
        1. <criteria_1>
        2. <criteria_2>
        ...
    - Audit Level: <audit_level>, max attempts: <max_attempts>, human gate: <Yes|No>
3. <Task 3 Name>
    - ID: <task_id_2>
    - Dependencies: <task_id_1>, <task_id_2>
    - Acceptance Criteria:
        1. <criteria_1>
        2. <criteria_2>
        ...
    - Audit Level: <audit_level>, max attempts: <max_attempts>, human gate: <Yes|No>
```

</TASK_LIST_EXAMPLE>

**Task List Item Filling Rules:**

- **Name** — a short human-readable title.
- **ID** — a unique identifier matching `^[A-Za-z0-9_-]+$` (no dots; the engine reserves `.` for subnode names).
- **Dependencies** — the ids of the tasks this task depends on. A task's implementer starts only after every dependency's audit has passed.
- **Acceptance Criteria** — independently checkable statements that define done. The auditor verifies each against evidence.
- **Audit Level** — Use **$AMPLIFY_PLAN_AUDIT_LEVEL**. `1` for an Opus blind-subagent audit (the default), or `2` for an external-agent (Codex) audit that degrades to Level 1 when Codex is absent.
- **Max Attempts** — the number of implement→audit attempts before the task is logged `failed` (non-halting).
- **Human Gate** (optional) — set when the task requires human verification per **Appendix C: Identify Human Checkpoints** in `write-plan/SKILL.md`.

**MUST NOT:**

1. You **MUST NOT** split a task's implementer and auditor into two separate tasks in the plan.

## Appendix B: Execution Diagram Format

<EXECUTION_DIAGRAM_EXAMPLE>

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

</EXECUTION_DIAGRAM_EXAMPLE>

**Execution Diagram Rules:**

1. **Always use bounding box** - Wrap in outer box
2. **Sequential flow** - Use `│` and `▼` arrows between tasks
3. **Parallel tasks** - Show side-by-side with horizontal connection:

   ```markdown
   │            ┌─────────────────┐   ┌─────────────────┐
   ├───────────►│ 2. {task}       │   │ 3. {task}       │◄────┤
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

**MUST NOT:**

1. You **MUST NOT** author machine-readable JSON.
2. You **MUST NOT** illustrate with any of the following forms:
    - Unordered list
    - Pure text descriptions

</PLAN_TASK_GUIDELINES>
