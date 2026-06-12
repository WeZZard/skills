# Task Design Guidelines

<TASK_DESIGN_GUIDELINES>

## Task Design Principles

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
7. You **MUST** trace each task's **Acceptance Criteria** to the **design aspect** it realizes and the **Verification** case(s) it satisfies, attaching cases by **Scope** per **Appendix B** (Unit → the implementing task; Integration / System / End-to-end(E2E) / Regression → a sink task or the plan's end-to-end check).

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

Each task declares its implementation side; its auditors are resolved at runtime by the audit-resolver agent and are not declared in the plan.

You **MUST** present the task list with the following format:

<TASK_LIST_EXAMPLE>

```markdown
**1. ID: <task_id_1>, Name: <Task 1 Name>:**

**Acceptance Criteria:** (Aspect: <Design component>)

1. [Verifies <case-id>] <one-line restatement of the cited Verification case>
2. [Task-local] <done-criterion with no Verification case>
...

Executor: <impl_executor> (impl), max attempts: <max_attempts>, human gate: <Yes|No>

**2. ID: <task_id_2>, Name: <Task 2 Name>:**
    
**Dependencies:** <task_id_1>

**Acceptance Criteria:** (Aspect: <Design component>)

1. [Verifies <case-id>] <one-line restatement of the cited Verification case>
2. [Task-local] <done-criterion with no Verification case>
...

Executor: <impl_executor> (impl), max attempts: <max_attempts>, human gate: <Yes|No>

**3. ID: <task_id_2>, Name: <Task 3 Name>:**

**Dependencies:** <task_id_1>, <task_id_2>

**Acceptance Criteria:** (Aspect: <Design component>)

1. [Verifies <case-id>] <one-line restatement of the cited Verification case>
2. [Task-local] <done-criterion with no Verification case>
...

Executor: <impl_executor> (impl), max attempts: <max_attempts>, human gate: <Yes|No>
```

</TASK_LIST_EXAMPLE>

**Task List Item Filling Rules:**

- **Name** — a short human-readable title.
- **ID** — a unique identifier matching `^[A-Za-z0-9_-]+$` (no dots; the engine reserves `.` for subnode names).
- **Dependencies** — the ids of the tasks this task depends on. A task's implementer starts only after every dependency **task** is done (its implementer passed and all of its runtime-resolved auditors passed).
- **Acceptance Criteria** — independently checkable statements that define done, each traced to the plan. Lead the block with a header naming the **design aspect** this task realizes: `(Aspect: <Design component — User Story | Architecture | Algorithm | Data Structure | User Interface | User Interaction | Business>)`. Then tag each criterion:
  - `[Verifies <case-id>]` — the criterion satisfies that **Verification** case; restate the case in one line so the task is readable on its own (the **Verification** section stays canonical).
  - `[Task-local]` — a done-criterion that no **Verification** case covers (for example an internal code-quality or convention requirement).

  Attach **Verification** cases by **Scope**: **Unit** cases attach to the implementing (leaf) task; **Integration**, **System**, **End-to-end(E2E)**, and **Regression** cases verify the assembled result and attach to a **sink** task or to the plan's end-to-end check (execute-plan Step 5) — never to a leaf task that cannot satisfy them alone. A plan with no **Verification** section uses only the `(Aspect: …)` header and `[Task-local]` criteria. Every runtime-resolved auditor verifies each against evidence.
- **Executor** — Choose `impl.executor` per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`, writing it as `subagent(<name>)`. That document is the source of truth for which subagent to use and its availability and degradation behavior; do not restate those rules here. The auditors are not chosen here — the audit-resolver picks each auditor's executor at runtime.
- **Max Attempts** — the number of implement→audit attempts before the task is logged `failed` (non-halting).
- **Human Gate** (optional) — set when the task requires human verification per **Appendix C: Identify Human Checkpoints** in `write-plan/SKILL.md`.

**MUST:**

1. You **MUST** use human-readable label (Name, ID, Dependencies, Acceptance Criteria, Executor, Max Attempts, Human Gate) in the task list.

**MUST NOT:**

1. You **MUST NOT** split a task's implementer and its audit into two separate tasks in the plan.
2. You **MUST NOT** use machine-readable label (name, id, deps, acceptance_criteria, impl, max_attempts, human_gate) in the task list.

</TASK_DESIGN_GUIDELINES>
