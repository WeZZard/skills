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
3. You **MUST** identify which tasks require human verification.
4. You **MUST** attach a human gate only to a task that is a **source** (no dependencies — its gate is raised at the start of execution) or a **sink** (no other task depends on it — its gate is raised at the end). A start gate verifies a precondition; an end gate verifies a final result.
5. You **MUST** identify assumptions in the plan and develop the task dependencies based on the dependencies of the assumptions.
6. You **MUST** order tasks to match the **testing strategy**.

<TESTING_STRATEGY_EXAMPLES>

1. Reproducer before fix for bugs
2. Integration/E2E after their prerequisites unless the plan documents a different dependency

</TESTING_STRATEGY_EXAMPLES>

**MUST NOT:**

- You **MUST NOT** attach a human gate to an **interior** task (one with both dependencies and dependents).
- You **MUST NOT** create tasks that are just "validate" or "check" - those are part of execution

## Communication

**MUST:**

1. You **MUST** output the tasks with: (1) a task list and (2) a paired execution diagram.
2. You **MUST** output the execution diagram before the tast list.
3. You **MUST** output the task list in an ordered list follows the format in **Appendix B: Task List Format**.
4. You **MUST** output the execution diagram follows the format in **Appendix A: Execution Diagram Format**.
5. You **MUST** ensure contents in the execution diagram and the task list consistent and aligned with each other.

**MUST NOT:**

1. You **MUST NOT** output the execution diagram after the tast list.

## Appendix A: Execution Diagram Format

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

## Appendix B: Task List Format

Each task in the plan contains both the implementation and audit information.

You **MUST** present the task list with the following format:

<TASK_LIST_EXAMPLE>

```markdown
**1. ID: <task_id_1>, Name: <Task 1 Name>:**

**Acceptance Criteria:**

1. <criteria_1>
2. <criteria_2>
...

Executor (impl/audit): <impl_executor>/<audit_executor>, max attempts: <max_attempts>, human gate: <Yes|No>

**2. ID: <task_id_2>, Name: <Task 2 Name>:**
    
**Dependencies:** <task_id_1>

**Acceptance Criteria:**

1. <criteria_1>
2. <criteria_2>
...

Executor (impl/audit): <impl_executor>/<audit_executor>, max attempts: <max_attempts>, human gate: <Yes|No>

**3. ID: <task_id_2>, Name: <Task 3 Name>:**

**Dependencies:** <task_id_1>, <task_id_2>

**Acceptance Criteria:**

1. <criteria_1>
2. <criteria_2>
...

Executor (impl/audit): <impl_executor>/<audit_executor>, max attempts: <max_attempts>, human gate: <Yes|No>
```

</TASK_LIST_EXAMPLE>

**Task List Item Filling Rules:**

- **Name** — a short human-readable title.
- **ID** — a unique identifier matching `^[A-Za-z0-9_-]+$` (no dots; the engine reserves `.` for subnode names).
- **Dependencies** — the ids of the tasks this task depends on. A task's implementer starts only after every dependency's audit has passed.
- **Acceptance Criteria** — independently checkable statements that define done. The auditor verifies each against evidence.
- **Executor (impl/audit)** — Choose `impl.executor` and `audit.executor` per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`, writing each as `subagent(<name>)`. That document is the source of truth for which subagent to use and its availability and degradation behavior; do not restate those rules here.
- **Max Attempts** — the number of implement→audit attempts before the task is logged `failed` (non-halting).
- **Human Gate** (optional) — set when the task requires human verification per **Appendix C: Identify Human Checkpoints** in `write-plan/SKILL.md`.

**MUST:**

1. You **MUST** use human-readable label (Name, ID, Dependencies, Acceptance Criteria, Executor (impl/audit), Max Attempts, Human Gate) in the task list.

**MUST NOT:**

1. You **MUST NOT** split a task's implementer and auditor into two separate tasks in the plan.
2. You **MUST NOT** use machine-readable label (name, id, deps, acceptance_criteria, impl, audit, max_attempts, human_gate) in the task list.

</PLAN_TASK_GUIDELINES>
