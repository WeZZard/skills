---
name: divide-and-conquer
description: <EXTREMELY_IMPORTANT>You MUST use divide-and-conquer when the user wants to break a large job into a parallel, subagent-driven workflow — either decomposing a bare prompt into a reviewable graph (Mode A) or running a skill that ships its own workflow graph plus helper code (Mode B). Use it for wide fan-outs (e.g. "research all of these", "process each of these in its own context") where one long context would degrade.</EXTREMELY_IMPORTANT>
---

# Divide & Conquer

**Announce at start:** "I'm using the divide-and-conquer skill to decompose this into a parallel workflow."

Divide & conquer turns a job into a **folded task graph** of typed nodes and runs it on the generalized amplify engine (`${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs`), so independent work fans out across **isolated subagent contexts** and only handles — never payload bytes — cross the orchestrator. The graph is built from four node kinds (see `${CLAUDE_PLUGIN_ROOT}/schemas/node-types.json`):

- `agent` — a non-deterministic unit dispatched to a subagent; reads its inputs by reference, writes a typed output to the value store.
- `fn` — a deterministic pure module export (a transform or a gather/reduce step).
- `expand` — a fan-out combinator: one child per element of an upstream list, each bound to its element by reference, all wired into a `gather`.
- `switch` — a branch combinator over an enumerable selector.

There are **two entry modes**.

---

## Mode A — Decompose a bare prompt (human-reviewed)

Use Mode A when the user hands you a **bare prompt** ("research X across these N angles", "do Y for each of these items") and there is no pre-built graph. The flow is **decompose → validate → human review/edit → run**.

### A.1 Decompose with a sub-agent

You **MUST** spawn ONE decomposition sub-agent (`subagent(general-purpose)`, in the background) whose job is to turn the bare prompt into a **DRAFT folded-graph declaration** — a JSON object shaped like the Mode B graph below (`version`, `plan_file`, `variables`, `nodes`), using only the `agent`/`fn`/`expand`/`switch` kinds, every node carrying an explicit `output_schema`. Its prompt MUST:

1. Carry the user's bare prompt verbatim plus the node-kind contract from `${CLAUDE_PLUGIN_ROOT}/schemas/node-types.json`.
2. Require a real fan-out where the work is naturally parallel: an `expand` over the list of units, one `agent` child per unit (each researching/processing exactly one unit in its own context), gathered by an `fn` reducer (`require: "all-resolved"`) so partial results still gather.
3. Return ONLY the draft graph JSON (no prose), so you can validate it directly.

You **MUST NOT** decompose by hand when the prompt is non-trivial; that is the sub-agent's job.

### A.2 Validate the draft

You **MUST** validate the returned draft before showing it:

1. Write it to a temporary file.
2. Validate it against `${CLAUDE_PLUGIN_ROOT}/schemas/task-graph.schema.json`.
3. Dry-run `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" init --graph <tmp.json>` — this runs the engine's `validateGraph` (unknown types, switch exhaustiveness, dangling deps, missing `output_schema` are all rejected here). If it fails, hand the errors back to the decomposition sub-agent and re-decompose; do not patch the graph silently.

### A.3 Surface for human review/edit (plan mode)

The draft is a **plan**, not a fait accompli. You **MUST** present the validated draft graph to the human for review and editing in **plan mode** (e.g. via **ExitPlanMode** / the plan gate), showing the fan-out width, the per-unit work, and the gather step. You **MUST NOT** run it until the human approves; the human may edit nodes (prompts, the unit list, the schema) before approving. Re-validate (A.2) after any human edit.

### A.4 Run

Once the human approves the (possibly edited) draft, run it through the engine. You **MUST** hand off to `amplify:execute-plan`'s scheduling loop to drive it — `init` (capture the `GRAPH_ID`), then `ready` / dispatch `agent` in the background / `exec-node` for `fn` / `expand` / `switch`, honoring `--window` for wide fan-outs and the single-writer commit lock. Present the gathered result.

---

## Mode B — Run a skill that ships a graph (no gate)

Use Mode B when a skill **ships its own workflow**: a JSON folded-graph declaration plus the `fn` module files it references, all in the skill's own folder. There is no decomposition and no review gate — the graph is authored, so the engine **loads, validates, and runs it directly**.

A Mode B skill folder ships:

- `graph.json` — the folded-graph declaration (`agent`/`fn`/`expand`/`switch` nodes, each with an `output_schema`).
- one or more `fn` module files, referenced from `graph.json` by a path **relative to the graph file** (e.g. `"module": "./fns/gather.mjs"`).

**Module resolution.** When the engine loads the graph, a node's **relative** `module` resolves against the **directory of the graph JSON** (the skill dir), not the cwd that ran `init` — `init` records that directory and `exec-node` resolves against it. An **absolute** `module` is used verbatim. So the skill's modules travel with the skill folder; no absolute paths are baked in.

### B.1 Run a Mode B skill

```bash
# 1. Load + validate + initialize (modules resolve relative to <skill>/graph.json's dir).
node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" init --graph <skill-dir>/graph.json
# -> prints the GRAPH_ID. A validation error here means the shipped graph is invalid; fix the skill, do not patch around it.

# 2. Drive it with the execute-plan scheduling loop, exactly as for any graph:
#    ready --window N -> dispatch agent (background) / exec-node fn / expand / switch -> complete -> repeat
```

You **MUST** drive the run with `amplify:execute-plan`'s scheduling loop (`ready`/`complete`/`exec-node`/`expand`/`switch`, the concurrency `--window`, the single-writer commit lock); divide-and-conquer authors/loads the graph, execute-plan runs it. Reductions use `fn` nodes with `require: "all-resolved"` (typically `gatherSuccesses` from `${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle.mjs`), so the run still gathers the successes when some children fail.

### B.2 Reference example

A runnable Mode B example ships at `${CLAUDE_PLUGIN_ROOT}/skills/divide-and-conquer/examples/wide-research/`:

- `graph.json` — a wide fan-out: a `seed` `fn` emits the subtopic list, a `research` `expand` runs one `agent` per subtopic in its own context, and a `gather` `fn` (`require: "all-resolved"`, re-exporting `gatherSuccesses`) reduces the per-subtopic findings.
- `fns/seed.mjs`, `fns/gather.mjs` — the deterministic helpers, referenced relative to the skill dir.

To run it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs" init --graph "${CLAUDE_PLUGIN_ROOT}/skills/divide-and-conquer/examples/wide-research/graph.json"`, then drive with execute-plan. Authoring your own Mode B skill means copying this shape into a new folder.

---

## Principles

**MUST:**

- Quarantine non-determinism in `agent` nodes; keep `fn` nodes pure, so the graph shape is a pure function of recorded values.
- Pass values **by reference** — the orchestrator handles only ids/handles; payload bytes never enter its context.
- Make every fan-out gather with an `fn` reducer (`require: "all-resolved"`) so partial results still gather and one failure never sinks the run.
- Grow the graph only through `expand`/`switch`; never author the engine-internal raw mutation verbs.

**MUST NOT:**

- You **MUST NOT** run a Mode A draft before the human approves it.
- You **MUST NOT** hand-edit a Mode B skill's graph to work around a validation failure — fix the skill.
- You **MUST NOT** track the graph in memory; the engine state is the source of truth.
