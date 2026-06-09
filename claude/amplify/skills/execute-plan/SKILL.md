---
name: execute-plan
description: <EXTREMELY_IMPORTANT>You MUST use execute-plan immediately when you have a finalized plan file and are ready to begin implementation. Always use this skill before starting to write code based on a plan.</EXTREMELY_IMPORTANT>
---

# Executing Plans

**Announce at start:** "I'm using the execute-plan skill to implement this plan."

## The Process

### Step 1: Load The Plan File

You **MUST** read the plan file and locate its task execution diagram: the ordered task list, where each task carries its **id**, **name**, **deps**, **acceptance criteria**, **audit level**, **max attempts**, and optional **human gate** (see `${CLAUDE_PLUGIN_ROOT}/references/plan-task-guidelines.md`).

### Step 2: Decide Inline vs Engine Execution

**Execute inline** (in the main agent, no engine) **ONLY** when the plan is trivial: a single task, or a few small independent tasks with no parallel coordination and no Level-2 audit. In that case implement the work, self-audit against each acceptance criterion, then go to **Step 6**.

**Otherwise use the engine** (Steps 4–6). You **MUST** use the engine whenever the plan has dependencies, parallelism, Level-2 audits, or non-trivial tasks.

### Step 3: Compile the Graph

#### 3.1 Dump the folded graph to JSON

Transcribe the plan's folded task list into a folded JSON file — a **faithful 1:1 transcription**, not a creative conversion. Each task becomes one object:

```json
{
   "version": 1,
   "nodes": [
      {
         "id": "...", "name": "...", "deps": ["..."],
         "acceptance_criteria": ["...", "..."],
         "audit_level": [audit_level], "human_gate": true|false, "max_attempts": [max_attempts]
      }
   ]
}
```

It **MUST** validate against `${CLAUDE_PLUGIN_ROOT}/schemas/task-graph.schema.json`. Write it to a temporary file.

#### 3.2 Initialize the engine

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/concurrency.mjs" init --graph <tmp.json> --salt "<plan title>"
```

The command prints a `GRAPH_ID` on stdout. Capture it; use it as `--id <GRAPH_ID>` for every subsequent call. The engine explodes each task `T` into `T.impl → T.audit` subnodes and stores state in an amplify-owned directory. If `init` reports validation errors, fix the dump (or stop and report if the plan itself is inconsistent).

### Step 4: Run the Scheduling Loop

Repeat until `ready` prints nothing:

1. **Get ready subnodes:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/concurrency.mjs" ready --id <GRAPH_ID>
   ```

2. **Spawn every ready subnode.** You **MUST** spawn all ready subnodes; when more than one is ready you **MUST** spawn them in a **single message** so they advance in parallel. Map each subnode to a subagent:

   - `T.impl` → an **implementer** subagent, designed per `${CLAUDE_PLUGIN_ROOT}/references/implementer-design-guidelines.md`. Provide the task's acceptance criteria, exact file paths, and the artifacts of completed dependency tasks. It returns the `STATUS: COMPLETE | BLOCKED` contract.
   - `T.audit` → a blind **auditor** subagent, designed per `${CLAUDE_PLUGIN_ROOT}/references/auditor-design-guidelines.md`. It returns the `VERDICT: PASS | FAIL` contract.

3. **Apply each result to the engine:**

   - Implementer returns `STATUS: COMPLETE` → `complete --id <GRAPH_ID> --node T.impl` (this readies `T.audit`).
   - Implementer returns `STATUS: BLOCKED` → stop and raise the human (genuine blocker; see **Step 7**).
   - Auditor returns `VERDICT: PASS` → `complete --id <GRAPH_ID> --node T.audit` (this readies the successor tasks' `.impl`).
   - Auditor returns `VERDICT: FAIL` → `fail --id <GRAPH_ID> --node T.audit --reason "<short reason>"`. The engine either reopens `T.impl` for another attempt (re-spawn the implementer **with the auditor's FINDINGS**) or, once `max_attempts` is reached, marks the task `failed`, logs it, and lets successors proceed. A `failed` task does **not** halt the plan.

   Each `complete`/`fail` prints the newly-ready subnode set — feed it into the next iteration.

4. **Human verification gates:** before completing a task whose `human_gate` is true, stop and raise a gate with the **AskUserQuestion** tool. Continue only after the user verifies.

### Step 5: Complete

1. Run the plan's **Verification** section as a single lightweight end-to-end integration check (run the test suite / commands the plan specifies).
2. Emit the final audit table:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/concurrency.mjs" report --id <GRAPH_ID>
   ```

   Present it to the user. Call out any task with verdict `FAILED` explicitly.

### Step 6: Conditions to Stop and Ask for Help

**STOP executing immediately when:**

- An implementer returns `STATUS: BLOCKED` (missing dependency, contradictory instruction).
- The integration check fails in a way the per-task audits did not catch.
- You don't understand an instruction, or the plan has critical gaps preventing execution.

Audit exhaustion is **not** a stop condition — it is logged as a `failed` task and surfaced in the report. **Ask for clarification rather than guessing.**

## Remember

**MUST:**

- Each task is implement-and-audit; never skip the auditor.
- Spawn all ready subnodes at once; one message when several are ready.
- You **MUST** drive the engine with `ready` / `complete` / `fail`;
- Re-spawn a failed implementer with the auditor's findings; stop only on genuine blockers.
- Finish with the integration check and the audit-table report.

**MUST NOT:**

- You **MUST NOT** track the graph by memory.
