---
name: execute-plan
description: <EXTREMELY_IMPORTANT>You MUST use execute-plan immediately when you have a finalized plan file and are ready to begin implementation. Always use this skill before starting to write code based on a plan.</EXTREMELY_IMPORTANT>
---

# Executing Plans

**Announce at start:** "I'm using the execute-plan skill to implement this plan."

## The Process

### Step 1: Load The Plan File

You **MUST** read the plan file and locate its task execution diagram: the ordered task list, where each task carries its **ID**, **Name**, **Dependencies**, **Acceptance Criteria**, **Max Attempts**, and optional **Human Gate** (see `${CLAUDE_PLUGIN_ROOT}/references/plan-task-guidelines.md`).

### Step 2: Decide Inline vs Engine Execution

**Execute inline** (in the main agent, no engine) **ONLY** when the plan is trivial: a single task, or a few small independent tasks with no parallel coordination and no external-agent executor. In that case implement the work, self-audit against each acceptance criterion, then go to **Step 6**.

**Otherwise use the engine** (Steps 4–6). You **MUST** use the engine whenever the plan has dependencies, parallelism, external-agent executors, or non-trivial tasks.

### Step 3: Compile the Graph

#### 3.1 Dump the graph to JSON

Transcribe the plan's task list into a JSON file — a **faithful 1:1 transcription**, not a creative conversion. Each task becomes one object:

```json
{
   "version": 1,
   "nodes": [
      {
         "id": "...", "name": "...", "deps": ["..."],
         "acceptance_criteria": ["...", "..."],
         "impl": { "executor": "subagent(<subagent-name>)" },
         "audit": { "executor": "subagent(<subagent-name>)" },
         "human_gate": true|false, "max_attempts": [max_attempts]
      }
   ]
}
```

It **MUST** validate against `${CLAUDE_PLUGIN_ROOT}/schemas/task-graph.schema.json`. Write it to a temporary file.

#### 3.2 Initialize the engine

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" init --graph <tmp.json> --salt "<plan title>"
```

The command prints a `GRAPH_ID` on stdout. Capture it; use it as `--id <GRAPH_ID>` for every subsequent call. The engine explodes each task `T` into `T.impl → T.audit` subnodes and stores state in an amplify-owned directory. If `init` reports validation errors, fix the dump (or stop and report if the plan itself is inconsistent).

### Step 4: Run the Scheduling Loop

Repeat until `ready` prints nothing:

1. **Get ready subnodes:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" ready --id <GRAPH_ID>
   ```

2. **Spawn every ready subnode.** When more than one is ready you **MUST** spawn them in a **single message** so they advance in parallel. Each `ready`/`complete`/`fail` line is **tab-separated** — `<subnode-id>\t<executor>`, where `<executor>` is `subagent(<name>)` (see the **Runtime Contract** in the plan). The spawn strategy is the **same for every subnode**:

   1. Split the line on the tab; parse the **role** from the id suffix — `.impl` → implementer, `.audit` → auditor.
   2. Choose, detect, and degrade `<executor>` per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`. The executor comes straight from the tool output; do **not** re-read the graph for it.
   3. Build the prompt from the role's guideline:
      - You **MUST** use `${CLAUDE_PLUGIN_ROOT}/references/implementer-design-guidelines.md` for an implementer.
      - You **MUST** use `${CLAUDE_PLUGIN_ROOT}/references/auditor-design-guidelines.md` for an auditor.
   4. Spawn `subagent(<name>)` with the Agent tool (`subagent_type: <name>`), passing `model` plus that prompt.
      - A built-in executor takes the prompt directly, with the tools its role allows (an auditor is read-only).
      - A driver executor takes the prompt as its **delegated body**, following that driver's own Input contract.

3. **Apply each result to the engine:**

   - Implementer returns `STATUS: COMPLETE` → `complete --id <GRAPH_ID> --node T.impl` (this readies `T.audit`).
   - Implementer returns `STATUS: BLOCKED` → stop and raise the human (genuine blocker; see **Step 7**).
   - Auditor returns `VERDICT: PASS` → `complete --id <GRAPH_ID> --node T.audit` (this readies the successor tasks' `.impl`).
   - Auditor returns `VERDICT: FAIL` → `fail --id <GRAPH_ID> --node T.audit --reason "<short reason>"`. The engine either reopens `T.impl` for another attempt (re-spawn the implementer **with the auditor's FINDINGS**) or, once `max_attempts` is reached, marks the task `failed`, logs it, and lets successors proceed. A `failed` task does **not** halt the plan.

   Each `complete`/`fail` prints the newly-ready subnode set — one `<id>\t<executor>` line per subnode — feed it into the next iteration.

4. **Human verification gates:** before completing a task whose `human_gate` is true, stop and raise a gate with the **AskUserQuestion** tool. Continue only after the user verifies.

### Step 5: Complete

1. Run the plan's **Verification** section as a single lightweight end-to-end integration check (run the test suite / commands the plan specifies).
2. Emit the final audit table:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" report --id <GRAPH_ID>
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
