---
name: execute-plan
description: <EXTREMELY_IMPORTANT>You MUST use execute-plan immediately when you have a finalized plan file and are ready to begin implementation. Always use this skill before starting to write code based on a plan.</EXTREMELY_IMPORTANT>
---

# Executing Plans

**Announce at start:** "I'm using the execute-plan skill to implement this plan."

## Execution Process

### Step 1: Load The Plan File

You **MUST** read the plan file and locate its task execution diagram: the ordered task list, where each task carries its **ID**, **Name**, **Dependencies**, **Executor**, **Acceptance Criteria**, **Max Attempts**, and optional **Human Gate** (see `${CLAUDE_PLUGIN_ROOT}/references/task-design-guidelines.md`).

### Step 2: Decide Inline vs Engine Execution

**Execute inline** (in the main agent, no engine) **ONLY** when the plan is trivial: a single task, or a few small independent tasks with no parallel coordination and no external-agent executor. In that case implement the work, self-audit against each acceptance criterion, then go to **Step 6**. During inline implementation, if a tool call fails repeatedly, re-check the plan/task scope and fix the specific cause rather than guessing new parameters or paths.

**Otherwise use the engine** (Steps 4–6). You **MUST** use the engine whenever the plan has dependencies, parallelism, external-agent executors, or non-trivial tasks.

### Step 3: Compile the Graph

#### 3.1 Dump the graph to JSON

Transcribe the plan's task list into a JSON file — a **faithful 1:1 transcription**, not a creative conversion. Each task becomes one object:

```json
{
   "version": 1,
   "plan_file": "<absolute path to the session plan file>",
   "variables": {
      "$AMPLIFY_COMPUTER_USE_AVAILABLE": true|false,
      "$AMPLIFY_CUA_AVAILABLE": true|false,
      "$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE": true|false,
      "$AMPLIFY_PLAYWRIGHT_AVAILABLE": true|false,
      "$AMPLIFY_CODEX_AVAILABLE": true|false,
      "$AMPLIFY_KIMI_AVAILABLE": true|false,
      "$AMPLIFY_USE_CODEX_APPROVED": true|false|null,
      "$AMPLIFY_USE_KIMI_APPROVED": true|false|null
   },
   "nodes": [
      {
         "id": "...", "type": "implement", "name": "...", "deps": ["..."],
         "acceptance_criteria": ["...", "..."],
         "design_aspect": "<the task's (Aspect: …) design component>",
         "human_gate": true|false, "max_attempts": [max_attempts]
      }
   ]
}
```

1. You **MUST** set `nodes[].type` to `"implement"` on every node you author — the dump only ever emits `implement` nodes. The implementer always runs `subagent(general-purpose)`, so you **MUST NOT** emit a per-implementer `executor`; specialized GUI/behavioral work is an auditor choice, resolved at runtime by the audit-resolver. (The `resolve`/`audit`/`reduce` node types exist in the registry but are created at runtime by the lifecycle, never by this dump.)
2. You **MUST** set `nodes[].human_gate` to `false` is the task **IS NTO** a human gate or **HAVEN'T MENTIONED ITSELF** as a human gate.
3. You **MUST** set each `nodes[].design_aspect` to the task's `(Aspect: …)` design component (e.g. Architecture, Data Structure, User Interaction).
4. You **MUST** set `plan_file` to the absolute path of the session plan file.
5. You **MUST** fill `variables` with the latest values of the following in-session variable as key-value pairs:
   - `$AMPLIFY_COMPUTER_USE_AVAILABLE`
   - `$AMPLIFY_CUA_AVAILABLE`
   - `$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE`
   - `$AMPLIFY_PLAYWRIGHT_AVAILABLE`
   - `$AMPLIFY_CODEX_AVAILABLE`
   - `$AMPLIFY_KIMI_AVAILABLE`
   - `$AMPLIFY_USE_CODEX_APPROVED`
   - `$AMPLIFY_USE_KIMI_APPROVED`
6. You **MUST** write the JSON object to a temporary file.
7. You **MUST** validate the generated JSON file against `${CLAUDE_PLUGIN_ROOT}/schemas/task-graph.schema.json`.

#### 3.2 Initialize the engine

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" init --graph <tmp.json> --salt "<plan title>"
```

The command prints a `GRAPH_ID` on stdout. Capture it; use it as `--id <GRAPH_ID>` for every subsequent call. The engine explodes each task `T` into `T.impl → T.resolve` subnodes (the `T.audit.<i>` auditor subnodes are created at runtime by the `resolve` verb) and stores state in an amplify-owned directory. If `init` reports validation errors, fix the dump (or stop and report if the plan itself is inconsistent).

### Step 4: Run the Scheduling Loop (background, continuous)

Dispatch every subagent in the **background** and react to each completion. Keep going until **nothing is in flight** and `report` shows no `INCOMPLETE` task — *not* merely until `ready` is momentarily empty (an exclusive subnode may be deferred while its resource is busy).

Every `<task-notification>` from a subagent you dispatched is a **resume signal** for this loop, not a stop — the `SubagentStop` and `Stop` hooks now enforce loop continuation deterministically. On any completion you **MUST** apply the result, run `ready`, dispatch what it unblocks, and continue; you **MUST NOT** end your turn while `report` shows any `INCOMPLETE` task or any subagent is still in flight.

1. **Get the ready set:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" ready --id <GRAPH_ID>
   ```

   Each `ready`/`complete`/`resolve`/`fail` line is **tab-separated** — `<subnode-id>\t<executor>`. Parse the **role** from the id: `.impl` → implementer, `.resolve` → audit-resolver, `.audit.<i>` → auditor. The `<executor>` comes straight from the tool output; do **not** re-read the graph for it.

2. **Dispatch each ready subnode in the background.** For a subnode `S` with executor `E`:

   1. **Exclusive-resource gate.** Ask the engine whether `E` is exclusive:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" resource-of --executor "<E>"
      ```

      If it prints a resource class `R` (e.g. `computer-use`, `chrome-devtools`), acquire the host-global lock by starting a **background holder** and reading its first line:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" hold --resource <R> --owner "<GRAPH_ID>:<S>"   # run_in_background: true
      ```

      It prints `HELD` (acquired — it then keeps holding the kernel `flock`) or `BUSY owner=<owner>` (held by this run **or another Claude Code session**). On `BUSY`, **defer** `S` and record its blocked resource `R` (an in-session holder's completion will re-dispatch it; an external holder is handled by the **idle-Monitor step below**). On `HELD`, proceed and remember `(R, "<GRAPH_ID>:<S>")` to release when `S` finishes. If `resource-of` prints nothing, `E` is non-exclusive — skip this gate.
   2. **Build the spawning prompt by role:**
      - implemeter: You **MUST** build `implementer`'s spawning prompt by following the guidelines: `${CLAUDE_PLUGIN_ROOT}/references/implementer-design-guidelines.md`
      - audit-resolver: You **MUST** build `subagent(amplify:audit-resolver)`'s spawning prompt with the following template:
         <AUDIT_RESOLVER_SPAWNING_PROMPT_TEMPLATE>

         ```markdown
         GRAPH_ID: <GRAPH_ID>
         TASK: <id>
         CHANGED FILES: <paths / globs the implementer reported>
         ```

         </AUDIT_RESOLVER_SPAWNING_PROMPT_TEMPLATE>
      - auditor: You **MUST** spawn all the <subagent_type> with its <audit_prompt> **verbatim** in the audit-resolver's response:
         <AUDIT_RESOLVER_RESPONSE_EXAMPLE>

         ```markdown
         PANEL:
         [
            { "focus": "<short focus name>", "executor": "subagent(<subagent_type>)", "audit_prompt": "<audit_prompt>" },
            ...
         ]
         ```

         </AUDIT_RESOLVER_RESPONSE_EXAMPLE>
   3. **Spawn it in the background** with the Agent tool (`subagent_type: <name>`, `run_in_background: true`), passing `model` plus the spawning prompt. Immediately after spawning, mark the subnode as dispatched:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" dispatch --id <GRAPH_ID> --node <SUBNODE>
      ```

      1. You **MUST** spawn in the background.
      2. You **MUST** call `dispatch` immediately after spawning each subnode.
      3. You **MUST** dispatch all ready, non-deferred subnodes.
      4. You **MUST NOT** spawn in the foreground.

3. **On each background completion, apply it and dispatch what it unblocks:**

   - Implementer `STATUS: COMPLETE` → `complete --id <GRAPH_ID> --node T.impl` (readies `T.resolve`).
   - Implementer `STATUS: BLOCKED` → stop and raise the human (genuine blocker; see **Step 6**).
   - Audit-resolver `PANEL` → `resolve --id <GRAPH_ID> --node T.resolve --panel '<panel-json>'` (registers + readies `T.audit.<i>`).
   - Auditor `VERDICT: PASS` → `complete --id <GRAPH_ID> --node T.audit.<i>`.
   - Auditor `VERDICT: FAIL` → `fail --id <GRAPH_ID> --node T.audit.<i> --reason "<short reason>"`.

   **Release the lock** of any completed exclusive subnode: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" release --resource <R> --owner "<GRAPH_ID>:<S>"`. (A crash or shutdown needs no release — the holder dies with the session and the kernel frees the `flock`.) Then **dispatch the newly-ready subnodes** the `complete`/`resolve`/`fail` printed (back to step 2), and retry any previously **deferred** exclusive subnode.

   The engine aggregates each round: a task is done only when **every** auditor passes; on any FAIL it reopens `T.impl` (re-spawn the implementer **with the failing auditors' FINDINGS**), resets `T.resolve`, and drops the auditors so the next round re-resolves from the new diff — or, once `max_attempts` is reached, logs the task `failed` (non-halting; successors proceed).

4. **Human verification gates:** for a task whose `human_gate` is true, after its auditors all pass (the task is done) stop before dispatching its successors and raise a gate with the **AskUserQuestion** tool. Continue only after the user verifies.

5. **Idle on a busy resource → arm a Monitor (don't end the turn idle).** When nothing is in flight, run `report --id <GRAPH_ID>`; if every task is PASS/FAILED, **stop**. Otherwise the only thing blocking progress is a deferred subnode whose exclusive resource is held — by this run or, with no completion event coming, **another Claude Code session/process**. Arm a **persistent Monitor** whose command waits for any blocked resource to free:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" wait-free --resource <comma-joined blocked classes>
   ```

   It heartbeats while held and prints `RELEASED <resource>` then exits as soon as one frees (`FREE` or a dead/`STALE` holder). On that completion, re-attempt `hold` for the deferred subnodes, dispatch the acquirers, and resume the loop (step 2). In-session contention rarely reaches here — the holder's completion event re-dispatches the deferred subnode first; the Monitor exists for **external** holders, which emit no completion event of their own.

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

## Execution Principles

**MUST:**

- Each task is implement-and-audit; never skip the auditor.
- Dispatch every subagent in the **background** (`run_in_background: true`) and react to each completion; don't block on a batch.
- You **MUST** drive the engine with `ready` / `complete` / `resolve` / `fail`, and gate exclusive executors with `resource-of` → `hold` → `release`; when idle on a busy resource, arm a `wait-free` Monitor and resume on `RELEASED`.
- Re-spawn a failed implementer with the auditor's findings; stop only on genuine blockers.
- Finish with the integration check and the audit-table report.
- You **MUST** treat every background-completion notification as a signal to resume the scheduling loop; you **MUST NOT** end your turn while `report` shows any `INCOMPLETE` task or any subagent is in flight.

**MUST NOT:**

- You **MUST NOT** track the graph by memory.
