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

1. **Node kinds.** The engine is a general DAG engine over typed node kinds (`implement`, `agent`, `fn`, `expand`, `switch`); every node carries a required, explicit `type`. For a standard implement-and-audit plan — the common case for this skill — transcribe **each task as an `implement` node** (the shape shown above). The implementer always runs `subagent(general-purpose)`, so for an `implement` node you **MUST NOT** emit a per-implementer `executor`; specialized GUI/behavioral work is an auditor choice, resolved at runtime by the audit-resolver. (The `resolve`/`audit` subnodes of an `implement` node are created at runtime by the lifecycle, never by this dump.) When a plan task is itself authored as a generalized kind, emit that kind with its declared fields and an `output_schema` (`agent`: `prompt` + `output_schema` + `max_attempts`; `fn`: `module` + `export` + `output_schema` + optional `require`; `expand`: `over` + `template` + `gather`; `switch`: `over` + `cases`) — see `${CLAUDE_PLUGIN_ROOT}/schemas/node-types.json`. Graph **growth** at runtime happens only through `expand`/`switch`; never author the raw `spawn-task`/`add-dep`/`remove-dep`/`remove-task` verbs (they are engine-internal).
2. You **MUST** set `nodes[].human_gate` to `false` if the task **IS NOT** a human gate or **HAVEN'T MENTIONED ITSELF** as a human gate.
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

The command prints a `GRAPH_ID` on stdout. Capture it; use it as `--id <GRAPH_ID>` for every subsequent call. The engine explodes each `implement` task `T` into `T.impl → T.resolve` subnodes (the `T.audit.<i>` auditor subnodes are created at runtime by the `resolve` verb); generalized kinds (`agent`/`fn`/`expand`/`switch`) are scheduled directly by their task id, with no subnodes. State lives in an amplify-owned directory. If `init` reports validation errors, fix the dump (or stop and report if the plan itself is inconsistent).

**Single-writer commits (you do not manage this).** Every state mutation — each `complete`, and every `expand`/`switch`/`dispatch` — is serialized per run by a `GRAPH_ID`-scoped commit lock inside the engine. `fn` *compute* still runs in parallel, but the *commit* is single-writer, so even if several background completions land at once **no update is lost**. This is automatic and uncontended-no-op; there is no lock for you to acquire here (that is only the separate `hold`/`release` gate for exclusive host resources, below).

### Step 4: Run the Scheduling Loop (background, continuous)

Dispatch every subagent in the **background** and react to each completion. Keep going until **nothing is in flight** and `report` shows no `INCOMPLETE` task — *not* merely until `ready` is momentarily empty (an exclusive subnode may be deferred while its resource is busy).

Every `<task-notification>` from a subagent you dispatched is a **resume signal** for this loop, not a stop — the `SubagentStop` and `Stop` hooks now enforce loop continuation deterministically. On any completion you **MUST** apply the result, run `ready`, dispatch what it unblocks, and continue; you **MUST NOT** end your turn while `report` shows any `INCOMPLETE` task or any subagent is still in flight.

1. **Get the ready set (optionally windowed):**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" ready --id <GRAPH_ID> [--window <N>]
   ```

   Each `ready`/`complete`/`resolve`/`fail` line is **tab-separated** — `<node-id>\t<executor>`. With no `--window` the whole ready set is emitted (the default). Pass **`--window N`** to bound concurrency: the engine emits at most `max(0, N − in-flight)` ready nodes in stable order and defers the rest (they reappear on a later `ready` once a slot frees). Use a window when a wide fan-out would otherwise dispatch hundreds of subagents at once; honor it — never dispatch beyond what `ready --window N` returns.

   **Classify each ready node by kind**, then dispatch it (step 2):
   - A **legacy `implement` subnode** — id has a role suffix: `.impl` → implementer, `.resolve` → audit-resolver, `.audit.<i>` → auditor. The `<executor>` comes straight from the tool output; do **not** re-read the graph for it.
   - A **generalized flat node** — a bare task id (no role suffix). Look up its `type` in the dump you authored (`agent`/`fn`/`expand`/`switch`). For an `agent` the `<executor>` is on the ready line; `fn`/`expand`/`switch` are engine-driven (empty executor).

2. **Dispatch each ready node in the background, by kind.**

   **A) `implement` subnodes** (`.impl` / `.resolve` / `.audit.<i>`) — for a subnode `S` with executor `E`:

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
      - implementer: You **MUST** build `implementer`'s spawning prompt by following the guidelines: `${CLAUDE_PLUGIN_ROOT}/references/implementer-design-guidelines.md`
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

   **B) Generalized flat nodes** — dispatch by `type` (these have no subnode, so there is no `dispatch` verb for them; the `expand`/`switch` verbs settle their node in one commit, and `agent`/`fn` settle on `complete`):

   - **`agent`**: spawn the subagent (`subagent_type` = the executor on the ready line) in the **background** with `run_in_background: true`. Apply the exclusive-resource gate (A.1) the same way when its executor is exclusive. The agent reads its inputs **by reference** (`node task.mjs resolve-context --id <GRAPH_ID> --node <id> --inputs` → one `{status, output?}` envelope per dep), does its work, writes its typed output to the value store, and returns **only a handle/status** — the output bytes never enter your context.
   - **`fn`**: run its pure compute in the **background**, in parallel, READ-ONLY on engine state:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" exec-node --id <GRAPH_ID> --node <id>   # run_in_background: true
     ```

     `exec-node` reads the node's input envelopes from the store, runs `module#export` as a pure function, validates the result against `output_schema`, writes the value, and prints **only the handle**. Several ready `fn`s run as parallel background tasks; you commit each result in the next step.
   - **`expand`**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" expand --id <GRAPH_ID> --node <id>` — one commit that reads the `over` upstream's list, creates one child from `template` per element (each bound to its element **by reference**), wires each to `gather`, and settles the node. An empty list creates no children.
   - **`switch`**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" switch --id <GRAPH_ID> --node <id>` — one commit that instantiates **only** the matching case and settles the node.

   After each `expand`/`switch`, run `ready` again and dispatch what it unblocks. Honor `--window` throughout: dispatch only what `ready --window N` returns.

3. **On each background completion, apply it and dispatch what it unblocks:**

   *Implement subnodes:*
   - Implementer `STATUS: COMPLETE` → `complete --id <GRAPH_ID> --node T.impl` (readies `T.resolve`).
   - Implementer `STATUS: BLOCKED` → stop and raise the human (genuine blocker; see **Step 6**).
   - Audit-resolver `PANEL` → `resolve --id <GRAPH_ID> --node T.resolve --panel '<panel-json>'` (registers + readies `T.audit.<i>`).
   - Auditor `VERDICT: PASS` → `complete --id <GRAPH_ID> --node T.audit.<i>`.
   - Auditor `VERDICT: FAIL` → `fail --id <GRAPH_ID> --node T.audit.<i> --reason "<short reason>"`.

   *Generalized flat nodes:*
   - **`agent`** returns its output handle/value → `complete --id <GRAPH_ID> --node <id> --output-ref <handle>` (or `--output '<json>'`). The engine validates it against `output_schema` and records it **by reference**.
   - **`fn`** `exec-node` printed a handle → `complete --id <GRAPH_ID> --node <id> --output-ref <handle>`.
   - **`expand` / `switch`** are already settled by their verb above — no separate `complete`.

   These `complete`s all flow through the engine's single-writer commit lock, so several background results landing at once each commit atomically and **none is lost** — `fn` compute is parallel, the commit is serialized.

   **Release the lock** of any completed exclusive subnode: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" release --resource <R> --owner "<GRAPH_ID>:<S>"`. (A crash or shutdown needs no release — the holder dies with the session and the kernel frees the `flock`.) Then **dispatch the newly-ready nodes** the `complete`/`resolve`/`fail`/`expand`/`switch` printed (back to step 2), and retry any previously **deferred** exclusive subnode.

   For an `implement` node, the engine aggregates each audit round: the task is done only when **every** auditor passes; on any FAIL it reopens `T.impl` (re-spawn the implementer **with the failing auditors' FINDINGS**), resets `T.resolve`, and drops the auditors so the next round re-resolves from the new diff — or, once `max_attempts` is reached, logs the task `failed` (non-halting; successors proceed). (This implement-and-audit lifecycle is one node kind among several — the engine no longer special-cases only this shape; the same scheduling loop drives the generalized `agent`/`fn`/`expand`/`switch` kinds above. The raw graph-mutation verbs `spawn-task`/`add-dep`/`remove-dep`/`remove-task` are engine-internal — used only by `expand`/`switch`/loop — and must never be called from this loop.)

4. **Human verification gates:** for a task whose `human_gate` is true, after its auditors all pass (the task is done) stop before dispatching its successors and raise a gate with the **AskUserQuestion** tool. Continue only after the user verifies.

5. **Idle on a busy resource → arm a Monitor (don't end the turn idle).** When nothing is in flight, run `report --id <GRAPH_ID>`; if every task is PASS/FAILED, **stop**. Otherwise the only thing blocking progress is a deferred subnode whose exclusive resource is held — by this run or, with no completion event coming, **another Claude Code session/process**. Arm a **persistent Monitor** whose command waits for any blocked resource to free:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" wait-for-free --resource <comma-joined blocked classes>
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

- An `implement` task is implement-and-audit; never skip the auditor. The engine also drives the generalized kinds — dispatch `fn` via background `exec-node`, `agent` in the background, and run `expand`/`switch` as one-commit verbs — through the same scheduling loop.
- Dispatch every subagent and every `fn` compute in the **background** (`run_in_background: true`) and react to each completion; don't block on a batch.
- You **MUST** drive the engine with `ready` (with `--window N` to bound concurrency) / `complete` (`--output-ref`/`--output` to record a node's output by reference) / `resolve` / `fail` / `exec-node` / `expand` / `switch`, and gate exclusive executors with `resource-of` → `hold` → `release`; when idle on a busy resource, arm a `wait-for-free` Monitor and resume on `RELEASED`. Commits are serialized per run by the engine's `GRAPH_ID`-scoped lock, so concurrent completions never lose an update; you do not manage that lock.
- You **MUST NOT** call the raw graph-mutation verbs (`spawn-task`/`add-dep`/`remove-dep`/`remove-task`) — they are engine-internal; runtime graph growth flows only through `expand`/`switch`.
- Re-spawn a failed implementer with the auditor's findings; stop only on genuine blockers.
- Finish with the integration check and the audit-table report.
- You **MUST** treat every background-completion notification as a signal to resume the scheduling loop; you **MUST NOT** end your turn while `report` shows any `INCOMPLETE` task or any subagent is in flight.

**MUST NOT:**

- You **MUST NOT** track the graph by memory.
- You **MUST NOT** decide an external agent driver's completion (codex, kimi) by scanning or killing host processes (`ps`/`pgrep`/`pkill`); its subagent's completion is the only signal, and its `[amplify-external-agent]` trailer reports the external pid and exit — read the verdict above it.
