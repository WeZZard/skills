#!/usr/bin/env node
// Amplify task engine (structured concurrency).
//
// Ingests a FOLDED task graph (one node per implement-and-audit task, per
// schemas/task-graph.schema.json) and EXPLODES each task into <id>.impl and
// <id>.resolve subnodes. After the implementer completes, execute-plan spawns
// the audit-resolver agent (the <id>.resolve subnode); the resolver's panel is
// fed back via the `resolve` verb, which creates the runtime <id>.audit.<i>
// auditor subnodes. A task is done only when every resolved auditor passes on
// the same implementation; any failure reopens the implementer, drops the
// auditors, and re-resolves on the next attempt.
//
// State is keyed by a content hash of the folded graph (GRAPH_ID), so distinct
// plans never collide even when they share the same session plan-file path, and
// re-running an identical graph resumes cleanly. State lives in an amplify-owned
// directory, never under Claude Code's relocatable config directory.
//
// Verbs:
//   init     --graph <file> [--salt <text>]            -> prints GRAPH_ID
//   ready    --id <GRAPH_ID> [--window <N>]             -> prints ready subnodes.
//                                                          OPTIONAL --window N bounds concurrency:
//                                                          emits at most max(0, N - in-flight) of the
//                                                          otherwise-ready nodes (stable/sorted order),
//                                                          deferring the rest. With NO --window the
//                                                          behavior is UNBOUNDED and unchanged.
//   dispatch --id <GRAPH_ID> --node <subnode-id>        -> marks a pending subnode running
//   active   [--id <GRAPH_ID>] [--cwd <dir>] [--session <id>] [--json]
//                                                       -> lists still-active graphs (global);
//                                                          --id/--cwd/--session narrow the scan
//   complete --id <GRAPH_ID> --node <subnode-id>        -> prints newly-ready subnodes
//            [--output <json> | --output-file <path> | --output-ref <handle>]
//                                                       -> also records the node's output BY
//                                                          REFERENCE (validated vs output_schema)
//   resolve  --id <GRAPH_ID> --node <T>.resolve --panel <json>
//                                                       -> registers auditors, prints ready
//   fail     --id <GRAPH_ID> --node <T>.audit.<i> [--reason <text>]
//   hold     --resource <name> --owner <id> [--ttl <ms>] -> kernel-flock holder; prints HELD then
//                                                           blocks holding the lock | BUSY (exit 9)
//   release  --resource <name> [--owner <id>]            -> kill the holder, freeing the flock
//   holds    --resource <name>                           -> HELD <owner> | STALE | FREE
//   wait-for-free --resource <name[,name…]> [--interval <s>] -> block until any frees (prints RELEASED)
//   resource-of --executor <subagent(...)>               -> prints the exclusive resource class, if any
//   variables --id <GRAPH_ID>                        -> prints each injected variable as "<name>\t<value>"
//   resolve-context --id <GRAPH_ID> --node <task-id> -> dumps the audit-resolver's context for one task
//   resolve-context --id <GRAPH_ID> --node <node-id> --inputs
//                                                    -> one {status, output?} envelope per upstream dep
//                                                       (status done|failed), read from the value store
//   exec-node --id <GRAPH_ID> --node <fn-node-id>    -> run a deterministic fn node over its input
//                                                       envelopes, validate vs output_schema, write the
//                                                       value to the store, print ONLY the handle
//                                                       (READ-ONLY on engine state)
//   expand   --id <GRAPH_ID> --node <expand-node-id> -> fan-out: read the `over` upstream's list output,
//                                                       create one child from `template` per element in a
//                                                       SINGLE commit, bind each child to its element BY
//                                                       REFERENCE (a per-element store handle), wire each
//                                                       child to `gather`, tag it generatedBy the node;
//                                                       an empty list creates no children
//   switch   --id <GRAPH_ID> --node <switch-node-id> -> branch: read the `over` selector's output,
//                                                       match it (stringified: boolean -> "true"/"false",
//                                                       enum -> the value) to one of the node's `cases`,
//                                                       and instantiate ONLY that case's branch in a
//                                                       SINGLE commit (fresh id `<switch-id>-case-<key>`,
//                                                       no dots, tagged generatedBy the switch). Every
//                                                       node that depends on the switch is wired to also
//                                                       depend on the instantiated branch, so downstream
//                                                       wiring is stable regardless of which case fired.
//                                                       Exhaustiveness is enforced at validate_graph time,
//                                                       so a matching case always exists.
//   loop     --id <GRAPH_ID> --node <loop-switch-id> --state <handle>
//                                                    -> budgeted FORWARD UNROLL built ON switch (no new
//                                                       primitive, no back-edge): the loop's tail is a
//                                                       `switch` with a "continue" case (next iteration
//                                                       body) and a "stop" case (exit). One step reads the
//                                                       carried {budget, accumulator} from --state, routes
//                                                       continue iff budget>0 and no stop condition holds,
//                                                       and spawns ONE fresh forward node: a `<id>-iter-<k>`
//                                                       depending on the prior iteration (budget strictly
//                                                       decremented, accumulator folded, threaded BY
//                                                       REFERENCE), or the `<id>-exit`. Prints ONLY the
//                                                       threaded next-/final-state handle. Provably
//                                                       terminates (<= budget iterations) and stays acyclic;
//                                                       a re-run tears down + re-unrolls under GEN_CAP.
//   report   --id <GRAPH_ID>                            -> final task table
//   status   --id <GRAPH_ID>                            -> full subnode state table
//
// Graph-mutation primitives — INTERNAL USE ONLY. These verbs are called by the
// expand/switch/loop combinators (and by the active execute-plan engine) but are NOT
// part of the public graph-growth API. Public graph growth flows exclusively through
// `expand` and `switch`. Do not invoke these raw verbs from orchestration prompts.
//   spawn-task --id <GRAPH_ID> --task-id <id> --spec <json>  -> insert a task + its impl/resolve subnodes
//   remove-task --id <GRAPH_ID> --task-id <id> [--force]     -> remove a task + its subnodes (RELEASE after commit; --force to remove with running subnodes)
//   add-dep    --id <GRAPH_ID> --from <a> --to <b>           -> add edge a depends-on b
//   remove-dep --id <GRAPH_ID> --from <a> --to <b>           -> remove edge a depends-on b
//
// Subnode/executor lines are tab-separated: "<subnode-id>\t<executor>".
// No external dependencies (Node built-ins only).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, isAbsolute, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const IMPL = "impl";
const RESOLVE = "resolve";
const AUDIT = "audit";
const SEP = ".";
const DEFAULT_IMPL_EXECUTOR = "subagent(general-purpose)";
const RESOLVER_EXECUTOR = "subagent(amplify:audit-resolver)";
const REDUCER_EXECUTOR = "subagent(amplify:audit-reducer)";

// Folded-graph node types. Every node carries a required, explicit `type` naming
// one of these; the system file schemas/node-types.json declares each type's
// property template, which validateGraph reads at load time (see NODE_TYPES).
const TYPE_IMPLEMENT = "implement";
const TYPE_RESOLVE = "resolve";
const TYPE_AUDIT = "audit";
const TYPE_REDUCE = "reduce";
// Generalized workflow types (scheduling / runtime added in later tasks).
const TYPE_AGENT = "agent";
const TYPE_FN = "fn";
const TYPE_EXPAND = "expand";
const TYPE_SWITCH = "switch";
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes (backstop only)

// Bound on how many times structural invalidation may resurrect a FAILED task
// whose inputs keep drifting. A `done`/`auditing` task carries no such bound —
// its result is genuinely stale and MUST be redone. But a `failed` task has
// already exhausted its retry budget (settleRound bumped attempts to
// max_attempts); if an upstream task keeps churning its hash, re-running the
// failed task forever would be an unbounded loop with no new information. We
// allow up to GEN_CAP re-runs (one per generation): each invalidation that
// resets a failed task bumps `generation`; once it would exceed GEN_CAP the task
// stays `failed` and is NOT re-run. This is a deliberate, documented ceiling on
// terminally-failed work, NOT a retry counter (that is `attempts`).
const GEN_CAP = 3;
const PERL = process.env.AMPLIFY_PERL || "perl";

// Executors that contend over a host-global resource and MUST be serialized.
// This map is the single source of truth for which executors are exclusive.
const EXCLUSIVE = {
  "subagent(amplify:computer-use)": "computer-use",
  "subagent(amplify:browser-use-chrome-devtools)": "chrome-devtools",
};
function resourceOf(executor) { return EXCLUSIVE[executor] || null; }

// External-agent drivers (subagent(amplify:codex-driver|kimi-driver)) run as their
// own process with their own git behavior, which is not synchronized with this
// repository's state and cannot be bounded. They are therefore audit-only and MUST
// NOT be an implementer (an implementer writes the working tree). This is enforced
// structurally now: the `implement` node type fixes its executor to
// subagent(general-purpose) (node-types.json), so no external driver — indeed no
// non-general-purpose executor — can occupy an implement slot, while the `audit`
// type still accepts any EXECUTOR_RE-matching authored sub-agent as a read-only
// auditor.

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { verb, opts };
}

function die(message, code = 1) {
  process.stderr.write(`task: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// state directory
// ---------------------------------------------------------------------------

function stateDir() {
  const explicit = process.env.AMPLIFY_STATE_DIR;
  if (explicit && explicit.trim()) return explicit;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim()) return join(xdg, "amplify");
  return join(homedir(), ".local", "state", "amplify");
}

function statePath(graphId) {
  return join(stateDir(), `${graphId}.json`);
}

function loadState(graphId) {
  const path = statePath(graphId);
  if (!existsSync(path)) die(`no state for GRAPH_ID ${graphId} (run init first)`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(state) {
  // Stamp the live Claude Code session id on every persist so the loop-resume
  // hook can scope `active` to THIS chat window — preventing cross-talk between
  // multiple windows that share one project dir (cwd alone cannot tell them
  // apart). Only the orchestrator runs the mutating verbs that reach here, so
  // the stamp is the session that owns the run; refreshing it on every verb lets
  // it self-heal after a compaction changes the session id. Absent env (tests,
  // CI, non-Claude-Code callers) leaves any existing stamp untouched.
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (sid) state.session = sid;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  // Atomic persist: write to a same-directory temp file, then rename onto the
  // live path. POSIX rename(2) is atomic, so a crash/kill mid-write can never
  // leave a torn state file — a reader sees either the prior file or the fully
  // written new one, never a half-written one. The pid-suffixed temp also lets
  // two same-runId writers (distinct processes) stage independently without
  // clobbering each other's partial write; a lost update can still occur under
  // that race — preventing it needs a runId-scoped lock — but the on-disk file
  // is never corrupted.
  const finalPath = statePath(state.runId);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// canonicalization + hashing
// ---------------------------------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeGraphId(graph, salt) {
  const hash = createHash("sha256");
  hash.update(canonicalize(graph));
  if (salt) hash.update(` salt:${salt}`);
  return hash.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// content-addressed value store (VALUES BY REFERENCE)
// ---------------------------------------------------------------------------

// A node's typed OUTPUT is recorded BY REFERENCE: the bytes live on disk under the
// engine's state dir (per-run, so a run's values are isolated and trivially
// cleaned up), in a file NAMED by the sha256 of the value's canonical JSON — so
// equal outputs dedupe and the handle is a pure function of the bytes. The
// orchestrator's view keeps only node-id -> handle (the task record's `outputRef`,
// projected away by projectFoldedGraph so it never enters the content-hash
// identity); the bytes stay on disk until an executor fetches them via
// resolve-context. This store is DELIBERATELY separate from spec()/contentHash:
// an output is a runtime RESULT, not part of a node's identity.
function valuesDir(runId) { return join(stateDir(), "values", runId); }

// Write a value to the store, returning its content-addressed handle. The write
// is atomic (temp + rename); a racing identical write is harmless because the
// target name is the content hash, so both writers produce byte-identical files.
function storeValue(runId, value) {
  const handle = createHash("sha256").update(canonicalize(value)).digest("hex");
  const dir = valuesDir(runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${handle}.json`);
  if (!existsSync(path)) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }
  return handle;
}

// Read a value back from the store by its handle. Dies if the handle is unknown
// (a dangling reference is a hard error, never a silent empty output).
function loadValue(runId, handle) {
  const path = join(valuesDir(runId), `${handle}.json`);
  if (!existsSync(path)) die(`value handle "${handle}" not found in the store for run ${runId}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// per-task Merkle content hash
// ---------------------------------------------------------------------------

// Resolve the executor folded into a node's identity. For an `implement` node it is
// the RESOLVED implementer executor (subnodes[<id>.impl].executor, post-default), so
// an omitted impl and an explicit subagent(general-purpose) produce one identity;
// for any other subagent-dispatching kind (agent/audit/reduce) it is the executor on
// the task record (post-default). Engine-driven kinds (fn/expand/switch) have no
// executor in their template, so spec() never asks for one.
function specExecutor(task, subnodes, taskId, type) {
  if (type === TYPE_IMPLEMENT) {
    return subnodes[implId(taskId)]?.executor ?? task.executor ?? DEFAULT_IMPL_EXECUTOR;
  }
  return task.executor ?? defaultExecutorForType(type);
}

// spec(t) = the STABLE identity inputs of a node: the fields that, when changed,
// SHOULD change the node's identity (and therefore force a re-run). It reads the
// declared identity fields from the node's TYPE TEMPLATE (node-types.json), NOT a
// fixed implement-only list, so EVERY kind folds its own fields: agent prompt +
// output_schema; fn module + export + output_schema + require; expand over +
// template + gather; switch over + cases; implement name + acceptance_criteria +
// design_aspect + max_attempts + human_gate; etc. The structural id/type/deps are
// handled OUTSIDE spec — deps via the Merkle child-hash fold, the id as the map key
// — so they are skipped here. The RESOLVED executor is folded for a dispatching kind
// (see specExecutor). human_gate folds as a strict boolean; every other declared
// property is folded only when present (matching explode/projectFoldedGraph), so an
// implement node yields exactly its historical {name, acceptance_criteria,
// design_aspect, max_attempts, human_gate, executor} identity. canonicalize
// preserves array order (acceptance_criteria, expand `over`, switch case bodies),
// which is content-significant; it sorts object keys only.
function spec(task, subnodes, taskId) {
  const type = task.type || TYPE_IMPLEMENT;
  const template = NODE_TYPES[type] || NODE_TYPES[TYPE_IMPLEMENT];
  const out = {};
  for (const k of [...template.required, ...(template.optional || [])]) {
    if (k === "id" || k === "type" || k === "deps") continue; // structural, folded elsewhere
    if (k === "executor") { out.executor = specExecutor(task, subnodes, taskId, type); continue; }
    if (k === "human_gate") { out.human_gate = task.human_gate === true; continue; }
    if (k in task) out[k] = task[k];
  }
  return out;
}

// contentHash(t) = sha256( canonicalize(spec(t)) + "\n" + sorted(child hashes) ).
// A task folds in its DEPENDENCIES' hashes (a Merkle hash over the dep DAG), NOT
// its consumers', so adding a task that depends on X never changes X's hash, while
// changing X (or any upstream of X) changes X and everything downstream. Child
// hashes are sorted before folding so dep ORDER does not affect the result.
function taskContentHash(task, taskId, subnodes, childHashes) {
  const hash = createHash("sha256");
  hash.update(canonicalize(spec(task, subnodes, taskId)));
  hash.update("\n");
  hash.update([...childHashes].sort().join(","));
  return hash.digest("hex");
}

// Recompute contentHash for EVERY task in topological order (deps before
// dependents) so each task can fold in its already-computed dependency hashes.
// validateGraph (run by commit before this) guarantees the graph is acyclic, so a
// topological order always exists. This is a Kahn-style pass over tasks.deps.
function recomputeContentHashes(working) {
  const tasks = working.tasks;
  const ids = Object.keys(tasks);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of tasks[id].deps || []) {
      if (!tasks[dep]) continue; // dangling deps are rejected by validateGraph already
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dep).push(id);
    }
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    const task = tasks[id];
    const childHashes = (task.deps || [])
      .filter((dep) => tasks[dep])
      .map((dep) => tasks[dep].contentHash);
    task.contentHash = taskContentHash(task, id, working.subnodes, childHashes);
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
}

// ---------------------------------------------------------------------------
// structural invalidation (commit-time, after content hashes are recomputed)
// ---------------------------------------------------------------------------

// The set of tasks TRANSITIVELY generated by generatorId. A combinator (expand /
// switch / loop), when it expands, marks each child task it spawns with
// generatedBy=<generatorId>; a generated child may itself generate (a loop unroll or
// a nested expand), so the closure is taken transitively. The generator itself is
// NOT included. This is the flat-node analogue of "the audit round a task owns".
function generatedDescendants(tasks, generatorId) {
  const removed = new Set();
  const stack = [generatorId];
  while (stack.length) {
    const parent = stack.pop();
    for (const [id, t] of Object.entries(tasks)) {
      if (t && t.generatedBy === parent && !removed.has(id)) {
        removed.add(id);
        stack.push(id);
      }
    }
  }
  return removed;
}

// Tear down everything a combinator generated: remove its transitively-generated
// child tasks and each child's subnodes, then strip any now-dangling deps surviving
// tasks held on a removed child (a `gather` wired to the children), so the projected
// graph stays referentially valid — the combinator re-creates fresh children and
// re-wires `gather` when it re-expands. (V19) This is the flat-model generalization
// of dropping a task's .audit.<i> round; the expand/switch runtime (a later task)
// reuses it so a re-run reproduces ONE clean acyclic shape with no orphaned or
// duplicated generated nodes. Returns the set of removed task ids.
function tearDownGenerated(working, generatorId) {
  const removed = generatedDescendants(working.tasks, generatorId);
  if (removed.size === 0) return removed;
  for (const childId of removed) {
    delete working.tasks[childId];
    for (const sid of Object.keys(working.subnodes)) {
      if (working.subnodes[sid].task === childId) delete working.subnodes[sid];
    }
  }
  for (const t of Object.values(working.tasks)) {
    if (Array.isArray(t.deps) && t.deps.some((d) => removed.has(d))) {
      t.deps = t.deps.filter((d) => !removed.has(d));
    }
  }
  return removed;
}

// Reset a node's generated work to the fresh pre-run shape so a re-run reproduces a
// clean shape. (1) FLAT generalization (V19): drop any child tasks/branches this
// node generated as a combinator (expand/switch/loop), transitively. (2) IMPLEMENT
// lifecycle: reset impl/resolve back to pending and drop every .audit.<i>. Deleting
// an audit subnode (or a generated child) is NOT a running -> pending transition (it
// is a deletion), so it is allowed even mid-flight; the in-flight subagent's late
// return is tolerated as a no-op discard by the completion verbs (see
// settleSubnodeOrDiscard). Used by both the done-node reset and the atomic-round
// invalidation so they reset identically, for every node kind.
function resetTaskSubnodes(working, taskId) {
  tearDownGenerated(working, taskId);
  for (const [id] of taskAuditEntries(working, taskId)) delete working.subnodes[id];
  const impl = working.subnodes[implId(taskId)];
  const resolve = working.subnodes[resolveId(taskId)];
  if (impl) { impl.status = "pending"; delete impl.dispatchHash; }
  if (resolve) { resolve.status = "pending"; delete resolve.dispatchHash; }
}

// Does this task own a subnode that is still running? A reset must never demote a
// genuinely in-flight subnode to pending (the commit invariant), so the done-task
// reset is gated on this being false; the mvcc stale-result discard re-readies the
// running subnode later, at completion, when the run has actually returned.
function taskHasRunningSubnode(working, taskId) {
  return Object.values(working.subnodes).some(
    (s) => s.task === taskId && s.status === "running",
  );
}

// Structural invalidation, run INSIDE commit AFTER recomputeContentHashes. It
// resets work that the latest commit rendered stale, comparing each NODE's stored
// provenance hash (doneHash for a settled node — done, failed, or an already-
// expanded combinator; the impl subnode's dispatchHash for an in-progress audit
// round) against the freshly recomputed contentHash. The drift test is driven off
// node STATUS, not node TYPE: a `done` implement task, a settled `fn`/`agent`, and
// an expanded `expand`/`switch`/`loop` all re-run through the same generic branch,
// and resetTaskSubnodes tears down whatever each one generated (audit round AND/OR
// generated children). The one remaining type-specific reader is the `auditing`
// branch's impl-dispatchHash, the implement-and-audit lifecycle bridge that the
// scheduler generalization (a later task, which removes the IMPL/RESOLVE/AUDIT
// roles) will retire; its teardown already routes through the generic helper.
//
// It must NOT violate commit's running -> pending invariant: a settled node with a
// running subnode is left alone (none normally remains once settled, but we guard);
// an `auditing` round only DELETES its audit subnodes (allowed even when running)
// and resets the already-`done` impl/resolve subnodes, so no running subnode is
// ever moved to pending here.
function invalidateStale(working) {
  for (const [id, task] of Object.entries(working.tasks)) {
    // (V-SI.2) AUDITING: the round was built against the implementation that was
    // current when impl was dispatched. If contentHash has since drifted (impl's
    // dispatchHash no longer equals it), the whole round verdict would be against
    // a superseded implementation, so invalidate the round ATOMICALLY: drop every
    // auditor, reset impl/resolve, and send the task back to pending to be redone
    // from scratch. This is invalidation, NOT a retry, so it does NOT bump
    // attempts (unlike settleRound's failure path). A running auditor is simply
    // dropped; its late return is a no-op discard at the completion verb.
    if (task.status === "auditing") {
      const implDispatch = working.subnodes[implId(id)]?.dispatchHash;
      if (implDispatch !== undefined && implDispatch !== task.contentHash) {
        resetTaskSubnodes(working, id);
        task.status = "pending";
        task.lastReason = null;
        // attempts deliberately UNCHANGED — invalidation is not a failed attempt.
      }
      continue;
    }
    // (V-SI.1 / V-SI.3 / V16 / V19) SETTLED with a drifted result: doneHash records
    // the contentHash at which the node last settled (done/failed) OR last expanded
    // (a combinator). If it no longer matches, the node's inputs (its own spec or any
    // upstream's) changed, so the stored result/expansion is stale. Reuse is
    // automatic for an unchanged node (doneHash === contentHash leaves it untouched).
    // A running subnode means real in-flight work — skip the reset and let the mvcc
    // discard re-ready it at completion.
    const drifted = task.doneHash !== undefined && task.doneHash !== task.contentHash;
    if (!drifted) continue;
    if (taskHasRunningSubnode(working, id)) continue;
    if (task.status === "failed") {
      // (V-SI.3) bounded re-run: each resurrection bumps generation; past GEN_CAP
      // the terminally-failed task stays failed and is NOT re-run, so an upstream
      // that keeps churning cannot loop it forever.
      const gen = (task.generation || 0) + 1;
      if (gen > GEN_CAP) continue; // ceiling reached: keep it failed, do not re-run
      resetTaskSubnodes(working, id);
      task.status = "pending";
      task.attempts = 0;
      task.generation = gen;
      task.lastReason = null;
      delete task.doneHash;
    } else {
      // (V-SI.1 / V16 / V19) Any other settled node — a `done` task of any kind OR an
      // already-expanded combinator (its doneHash holds the expansion hash) — resets
      // and re-readies; attempts cleared (a fresh, unrelated run). resetTaskSubnodes
      // tears down BOTH the implement audit round and any generated children/branches,
      // so the re-run reproduces one clean acyclic shape.
      resetTaskSubnodes(working, id);
      task.status = "pending";
      task.attempts = 0;
      task.lastReason = null;
      delete task.doneHash;
    }
  }
}

// ---------------------------------------------------------------------------
// validation (enforces schemas/task-graph.schema.json + referential integrity)
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]+$/;
const EXECUTOR_RE = /^subagent\((general-purpose|explore|plan|amplify:codex-driver|amplify:kimi-driver|amplify:browser-use-chrome-devtools|amplify:browser-use-playwright|amplify:computer-use|amplify:computer-use-cua|amplify:audit-resolver|amplify:audit-reducer)\)$/;

// The node-type templates are the declared source of truth for which properties
// each `type` may carry and that type's executor rule. We read the system file at
// load time (a Node built-in readFileSync; the engine forbids only EXTERNAL deps),
// resolving its path from THIS script's URL, so the engine and the schema can never
// drift. The file lives one directory up, under schemas/node-types.json.
const NODE_TYPES = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/node-types.json", import.meta.url)), "utf8"),
).types;

// Resolve a node's executor for validation/explosion: a fixed-executor type whose
// `executor` is OMITTED defaults to that type's constant (matching the historical
// impl default), so the execute-plan dump need not emit it; an explicit value is
// taken verbatim (and then checked against the type rule). audit has no fixed
// executor, so it has no default — its executor must be present and authored.
function defaultExecutorForType(type) {
  const rule = NODE_TYPES[type]?.executor;
  return rule && typeof rule.const === "string" ? rule.const : undefined;
}
function resolveNodeExecutor(node) {
  if (typeof node.executor === "string") return node.executor;
  return defaultExecutorForType(node.type);
}

// Validate an output_schema value (hand-rolled; no external json-schema library).
// output_schema := { type: "boolean"|"integer"|"string"|"array"|"object", enum?: [...] }
function validateOutputSchema(schema, where, errors) {
  const VALID_TYPES = ["boolean", "integer", "string", "array", "object"];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${where} must be an object`);
    return;
  }
  const allowed = new Set(["type", "enum"]);
  for (const k of Object.keys(schema)) {
    if (!allowed.has(k)) errors.push(`${where} has unknown property "${k}"`);
  }
  if (!VALID_TYPES.includes(schema.type)) {
    errors.push(`${where}.type must be one of: ${VALID_TYPES.join(", ")}`);
  }
  if ("enum" in schema) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      errors.push(`${where}.enum must be a non-empty array when present`);
    }
  }
}

// Validate a runtime VALUE against a node's output_schema (the value-side companion
// to validateOutputSchema, which checks the SCHEMA itself). Uses the same minimal
// type system — boolean | integer | string | array | object, with an optional enum
// — so a node's recorded output is rejected when it violates the declared shape.
// Pushes any violations into `errors` (left empty when the value conforms).
const VALUE_TYPE_CHECKS = {
  boolean: (v) => typeof v === "boolean",
  integer: (v) => Number.isInteger(v),
  string: (v) => typeof v === "string",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};
function validateValueAgainstSchema(value, schema, where, errors) {
  const check = VALUE_TYPE_CHECKS[schema && schema.type];
  if (!check) {
    errors.push(`${where}: output_schema.type "${schema && schema.type}" is not a known type`);
    return;
  }
  if (!check(value)) {
    errors.push(`${where}: output ${JSON.stringify(value)} does not match output_schema.type "${schema.type}"`);
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((e) => e === value)) {
      errors.push(`${where}: output ${JSON.stringify(value)} is not one of the enum values ${JSON.stringify(schema.enum)}`);
    }
  }
}

// Per-type checks beyond "required present / no out-of-template property" that the
// generic loop applies for every type. Keyed by type name; each gets (node, where,
// errors) and pushes any violations.
const TYPE_PROPERTY_CHECKS = {
  [TYPE_IMPLEMENT](node, where, errors) {
    if (!Array.isArray(node.acceptance_criteria) || node.acceptance_criteria.length < 1) {
      errors.push(`${where}.acceptance_criteria must be a non-empty array`);
    }
    if (typeof node.design_aspect !== "string" || !node.design_aspect) {
      errors.push(`${where}.design_aspect must be a non-empty string`);
    }
    if (!Number.isInteger(node.max_attempts) || node.max_attempts < 1) {
      errors.push(`${where}.max_attempts must be an integer >= 1`);
    }
    if ("human_gate" in node && typeof node.human_gate !== "boolean") {
      errors.push(`${where}.human_gate must be a boolean`);
    }
  },
  [TYPE_AUDIT](node, where, errors) {
    if (typeof node.focus !== "string" || !node.focus) {
      errors.push(`${where}.focus must be a non-empty string`);
    }
    if (typeof node.audit_prompt !== "string" || !node.audit_prompt) {
      errors.push(`${where}.audit_prompt must be a non-empty string`);
    }
  },
  [TYPE_REDUCE](node, where, errors) {
    if (!Number.isInteger(node.counter)) {
      errors.push(`${where}.counter must be an integer`);
    }
  },
  [TYPE_AGENT](node, where, errors) {
    if (typeof node.prompt !== "string" || !node.prompt) {
      errors.push(`${where}.prompt must be a non-empty string`);
    }
    if (!("output_schema" in node)) {
      errors.push(`${where}.output_schema is required`);
    } else {
      validateOutputSchema(node.output_schema, `${where}.output_schema`, errors);
    }
    if (!Number.isInteger(node.max_attempts) || node.max_attempts < 1) {
      errors.push(`${where}.max_attempts must be an integer >= 1`);
    }
  },
  [TYPE_FN](node, where, errors) {
    if (typeof node.module !== "string" || !node.module) {
      errors.push(`${where}.module must be a non-empty string`);
    }
    if (typeof node["export"] !== "string" || !node["export"]) {
      errors.push(`${where}.export must be a non-empty string`);
    }
    if (!("output_schema" in node)) {
      errors.push(`${where}.output_schema is required`);
    } else {
      validateOutputSchema(node.output_schema, `${where}.output_schema`, errors);
    }
    if ("require" in node && !["all-done", "all-resolved"].includes(node.require)) {
      errors.push(`${where}.require must be "all-done" or "all-resolved"`);
    }
  },
  [TYPE_EXPAND](node, where, errors) {
    if (typeof node.over !== "string" || !node.over) {
      errors.push(`${where}.over must be a non-empty string`);
    }
    if (!node.template || typeof node.template !== "object" || Array.isArray(node.template)) {
      errors.push(`${where}.template must be an object`);
    }
    if (typeof node.gather !== "string" || !node.gather) {
      errors.push(`${where}.gather must be a non-empty string`);
    }
  },
  [TYPE_SWITCH](node, where, errors) {
    if (typeof node.over !== "string" || !node.over) {
      errors.push(`${where}.over must be a non-empty string`);
    }
    if (!node.cases || typeof node.cases !== "object" || Array.isArray(node.cases)) {
      errors.push(`${where}.cases must be an object`);
    }
  },
};

// Validate one node's `executor` against its type's rule. A `const` rule fixes the
// executor (the omitted-default resolved above must equal it; an external-impl
// driver is rejected for `implement`); a `matchesGrammar` rule (audit/agent) accepts
// any authored sub-agent matching EXECUTOR_RE. Types with no executor rule (fn,
// expand, switch) are engine-driven and have no executor to validate; return early.
function validateNodeExecutor(node, where, errors) {
  const rule = NODE_TYPES[node.type]?.executor;
  if (!rule) return; // no executor rule for this type (fn/expand/switch)
  const resolved = resolveNodeExecutor(node);
  if (typeof resolved !== "string" || !EXECUTOR_RE.test(resolved)) {
    errors.push(`${where}.executor must match ${EXECUTOR_RE}`);
    return;
  }
  if (rule.const !== undefined) {
    if (resolved !== rule.const) {
      errors.push(`${where}.executor for a "${node.type}" node must be "${rule.const}", got "${resolved}"`);
    }
    return;
  }
  // No fixed executor (audit, agent). The external-agent drivers are audit-only, so
  // they are valid here; they remain barred from `implement` by the const rule above.
}

function validateGraph(graph) {
  const errors = [];
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return ["graph must be a JSON object"];
  }
  if (graph.version !== 1) errors.push('"version" must be 1');
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1) {
    errors.push('"nodes" must be a non-empty array');
    return errors;
  }
  if (!("variables" in graph)) {
    errors.push('"variables" is required (a dictionary of variable name -> value; use {} when there are none)');
  } else if (typeof graph.variables !== "object" || graph.variables === null || Array.isArray(graph.variables)) {
    errors.push('"variables" must be a JSON object (a dictionary of variable name -> value)');
  }
  if (typeof graph.plan_file !== "string" || !graph.plan_file) {
    errors.push('"plan_file" is required (the absolute path to the session plan file)');
  }
  const ids = new Set();
  for (const [i, node] of graph.nodes.entries()) {
    const where = `nodes[${i}]`;
    if (!node || typeof node !== "object") {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof node.id !== "string" || !ID_RE.test(node.id)) {
      errors.push(`${where}.id must match ${ID_RE} (no dots)`);
    } else if (ids.has(node.id)) {
      errors.push(`${where}.id "${node.id}" is duplicated`);
    } else {
      ids.add(node.id);
    }
    // Cross-type fields (every node has them): a non-empty deps array.
    if (!Array.isArray(node.deps)) errors.push(`${where}.deps must be an array`);
    // Type-aware validation: read the node's required, explicit `type`, look up its
    // template, then assert (a) every required property is present, (b) no property
    // falls outside the template (required + optional), (c) per-type property checks,
    // (d) the executor obeys the type's rule. The template is the node-types.json
    // source of truth, so the engine and the schema cannot drift.
    if (typeof node.type !== "string" || !node.type) {
      errors.push(`${where}.type is required (one of: ${Object.keys(NODE_TYPES).join(", ")})`);
      continue; // without a type there is no template to validate against
    }
    const template = NODE_TYPES[node.type];
    if (!template) {
      errors.push(`${where}.type "${node.type}" is unknown (one of: ${Object.keys(NODE_TYPES).join(", ")})`);
      continue;
    }
    const allowed = new Set([...template.required, ...(template.optional || [])]);
    for (const k of template.required) {
      // `executor` may be omitted on a fixed-executor type (it defaults), so it is
      // not treated as a missing required property when a default applies.
      if (k === "executor" && defaultExecutorForType(node.type) !== undefined) continue;
      if (!(k in node)) errors.push(`${where} (type "${node.type}") is missing required property "${k}"`);
    }
    for (const k of Object.keys(node)) {
      // Skip properties with undefined values: projectFoldedGraph always emits an
      // `executor` key (possibly undefined) even for executor-less types (fn/expand/
      // switch); an undefined value is semantically absent and must not be flagged.
      if (node[k] === undefined) continue;
      if (!allowed.has(k)) errors.push(`${where} has property "${k}" outside its "${node.type}" template`);
    }
    if (typeof node.name !== "string" || !node.name) {
      if (allowed.has("name")) errors.push(`${where}.name must be a non-empty string`);
    }
    TYPE_PROPERTY_CHECKS[node.type]?.(node, where, errors);
    validateNodeExecutor(node, where, errors);
  }
  // referential integrity: deps reference existing ids
  for (const node of graph.nodes) {
    if (!Array.isArray(node.deps)) continue;
    for (const dep of node.deps) {
      if (!ids.has(dep)) errors.push(`task "${node.id}" depends on unknown task "${dep}"`);
    }
  }
  // V2: switch exhaustiveness — static set comparison, no program analysis.
  // For each switch node: look up the selector's output_schema; if it's boolean or
  // enum, the cases keys must exactly cover that domain with no missing and no extra.
  // A non-enumerable selector (no enum and not boolean) is rejected at init time.
  {
    const nodesById = new Map(graph.nodes.filter((n) => n.id).map((n) => [n.id, n]));
    for (const [i, node] of graph.nodes.entries()) {
      if (node.type !== TYPE_SWITCH) continue;
      if (typeof node.over !== "string" || !node.over) continue; // already caught above
      if (!node.cases || typeof node.cases !== "object" || Array.isArray(node.cases)) continue; // already caught
      const where = `nodes[${i}]`;
      const selectorNode = nodesById.get(node.over);
      if (!selectorNode) {
        errors.push(`${where} (switch "${node.id}"): over references unknown node "${node.over}"`);
        continue;
      }
      const schema = selectorNode.output_schema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        errors.push(`${where} (switch "${node.id}"): selector node "${node.over}" has no output_schema; switch requires an enumerable selector (boolean or enum)`);
        continue;
      }
      let domain;
      if (schema.type === "boolean") {
        domain = new Set(["false", "true"]);
      } else if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        domain = new Set(schema.enum.map(String));
      } else {
        errors.push(`${where} (switch "${node.id}"): selector node "${node.over}" output_schema is non-enumerable (type "${schema.type}" with no enum); switch requires a boolean or enum selector`);
        continue;
      }
      const caseKeys = new Set(Object.keys(node.cases));
      const missing = [...domain].filter((v) => !caseKeys.has(v));
      const extra = [...caseKeys].filter((v) => !domain.has(v));
      if (missing.length > 0 || extra.length > 0) {
        const parts = [];
        if (missing.length > 0) parts.push(`missing: ${[...missing].sort().join(", ")}`);
        if (extra.length > 0) parts.push(`extra: ${[...extra].sort().join(", ")}`);
        errors.push(`${where} (switch "${node.id}"): cases must exhaustively cover domain {${[...domain].sort().join(", ")}}; ${parts.join("; ")}`);
      }
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(graph.nodes);
    if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }
  return errors;
}

function findCycle(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n.deps || []]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...byId.keys()].map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;
  function visit(id) {
    if (cycle) return;
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id) || []) {
      if (color.get(dep) === GRAY) {
        const from = stack.indexOf(dep);
        cycle = [...stack.slice(from), dep];
        return;
      }
      if (color.get(dep) === WHITE) visit(dep);
      if (cycle) return;
    }
    stack.pop();
    color.set(id, BLACK);
  }
  for (const id of byId.keys()) {
    if (color.get(id) === WHITE) visit(id);
    if (cycle) break;
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// explosion: folded tasks -> impl/resolve subnodes (audits created at runtime)
// ---------------------------------------------------------------------------

function implId(taskId) { return `${taskId}${SEP}${IMPL}`; }
function resolveId(taskId) { return `${taskId}${SEP}${RESOLVE}`; }
function auditId(taskId, i) { return `${taskId}${SEP}${AUDIT}${SEP}${i}`; }

// explode is a CHANGE applied through commit: it writes the per-task records and
// (for an `implement` node) the impl/resolve subnodes onto the working copy (audits
// are created later, at runtime, by the resolve verb). It does NOT persist or
// validate on its own; commit() does both.
//
// Every task record stores its explicit `type` plus its type-specific property
// VALUES and the RESOLVED executor, so projectFoldedGraph can reconstruct a folded
// node that revalidates against the SAME node-types.json template. For an
// `implement` node the impl subnode also carries the resolved executor (spec()
// reads it for the contentHash; that hash path is byte-unchanged). The audit/reduce
// node types are DEFINED and validatable but nothing schedules them yet, so explode
// records them WITHOUT creating impl/resolve runtime subnodes — the lifecycle
// migration (a later task) is what will create their runtime work.
function explode(working, graph) {
  for (const node of graph.nodes) {
    const type = node.type || TYPE_IMPLEMENT;
    const executor = resolveNodeExecutor(node);
    const record = {
      type,
      deps: node.deps || [],
      executor,
      status: "pending", // pending -> impl-done -> auditing -> done | failed
      attempts: 0,
      generation: 0, // bumped only by structural invalidation of a failed task
      lastReason: null,
    };
    // Copy the type's declared property values (minus the structural id/type/deps/
    // executor handled above) verbatim onto the record, so they round-trip.
    const template = NODE_TYPES[type];
    for (const k of [...template.required, ...(template.optional || [])]) {
      if (["id", "type", "deps", "executor"].includes(k)) continue;
      if (k === "human_gate") { record.human_gate = node.human_gate === true; continue; }
      if (k in node) record[k] = node[k];
    }
    working.tasks[node.id] = record;
    if (type === TYPE_IMPLEMENT) {
      working.subnodes[implId(node.id)] = {
        task: node.id, role: IMPL, status: "pending", executor,
      };
      working.subnodes[resolveId(node.id)] = {
        task: node.id, role: RESOLVE, status: "pending",
        executor: RESOLVER_EXECUTOR,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// commit: the single validated writer of state.tasks / state.subnodes
// ---------------------------------------------------------------------------

// Reconstruct the folded-graph view {version:1, nodes, variables, plan_file} from
// live state, so the whole-graph validator (validateGraph, the same one init uses)
// can check any candidate the same way. Each node carries its explicit `type`, the
// type-specific property values stored on the task record, and the RESOLVED
// executor — for an `implement` task read from its .impl subnode (post-default), so
// the contentHash/spec path is byte-unchanged; for other types read from the task
// record. The reconstructed node carries EXACTLY its type's template properties, so
// it revalidates against node-types.json the same way init's input did.
function projectFoldedGraph(state) {
  const nodes = Object.entries(state.tasks).map(([id, t]) => {
    const type = t.type || TYPE_IMPLEMENT;
    const template = NODE_TYPES[type];
    const executor = type === TYPE_IMPLEMENT
      ? (state.subnodes[implId(id)]?.executor ?? t.executor ?? DEFAULT_IMPL_EXECUTOR)
      : (t.executor ?? defaultExecutorForType(type));
    const node = { id, type, deps: t.deps || [], executor };
    for (const k of [...template.required, ...(template.optional || [])]) {
      if (["id", "type", "deps", "executor"].includes(k)) continue;
      if (k === "human_gate") { node.human_gate = t.human_gate === true; continue; }
      if (k in t) node[k] = t[k];
    }
    return node;
  });
  return { version: 1, nodes, variables: state.variables || {}, plan_file: state.plan_file };
}

// ---------------------------------------------------------------------------
// runId-scoped single-writer COMMIT LOCK (V17)
//
// Every state mutation flows through commit() (the single validated writer of
// state.tasks / state.subnodes). fn COMPUTE runs in parallel (background
// `exec-node`, which never commits), but the COMMIT itself must be serialized
// per run so two concurrent same-GRAPH_ID writers (e.g. several `complete`
// results landing at once) can never LOSE an update. We reuse the existing
// flock(2) holder pattern — a short-lived `perl` child holding a kernel flock —
// but keyed on the RUNID (a per-run lock file), not on an exclusive resource
// class.
//
// Uncontended (single writer — the normal self-orchestrating run) the lock is
// acquired immediately, so behavior is observably UNCHANGED. Under contention,
// writers QUEUE on a BLOCKING flock and run their read-modify-write strictly one
// at a time; commit re-reads the latest committed state under the lock (see
// commit) so the second writer FOLDS IN the first writer's update rather than
// overwriting it. The lock is released when the holder child is killed (normal
// path), via a process-`exit` backstop (covers die()/process.exit, which does
// NOT run finally blocks), and finally by the holder self-exiting when orphaned
// (getppid()==1) — so a crashed writer can never deadlock the next one.
//
// SAFE DEGRADATION: if the holder cannot be acquired (no perl / spawn failure /
// timeout), the lock is skipped and commit proceeds LOCK-FREE — which is exactly
// the engine's prior behavior and therefore correct for the single writer the
// active run is. The lock never HANGS a commit; the worst case degrades to
// today's semantics.
// ---------------------------------------------------------------------------

function commitLockPath(runId) {
  return join(locksDir(), `commit-${runId}.lock`);
}

// A minimal synchronous sleep (no event-loop pumping, no dependency): block this
// thread for `ms` via Atomics.wait on a throwaway SharedArrayBuffer. Used only by
// the commit-lock acquire poll, which must stay synchronous (commit is sync).
function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback if SharedArrayBuffer is unavailable */ }
  }
}

// The commit-lock holder (perl): a BLOCKING flock (LOCK_EX, no LOCK_NB) so
// concurrent committers QUEUE rather than fail-fast, then records the caller's
// unique TOKEN into the lock file (the acquisition signal the parent polls for)
// and blocks holding the fd until killed or orphaned. Distinct from HOLDER_PL,
// whose non-blocking acquire + TTL reclaim suits long-held resource locks held
// across a subagent's lifetime; a commit critical section is brief, so it simply
// waits its turn.
const COMMIT_HOLDER_PL = [
  "use strict; use warnings;",
  "use Fcntl qw(:DEFAULT :flock);",
  "use IO::Handle;",
  "my ($lf,$token)=@ARGV;",
  "sysopen(my $fh,$lf,O_RDWR|O_CREAT,0644) or die qq(open: $!);",
  "$fh->autoflush(1); $| = 1;",
  "flock($fh,LOCK_EX) or die qq(flock: $!);",   // BLOCKING: wait until we own it
  "truncate($fh,0); seek($fh,0,0);",
  "print $fh qq(token $token\\npid $$\\n);",     // acquisition signal for the parent
  "print qq(HELD\\n);",
  "$SIG{TERM}=sub{exit 0}; $SIG{INT}=sub{exit 0};",
  "while(1){ select(undef,undef,undef,0.05); exit 0 if getppid()==1 }",
].join("\n");

function commitLockTimeoutMs() {
  const raw = Number(process.env.AMPLIFY_COMMIT_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
}

// Spawn a holder and BLOCK (synchronously) until it OWNS the flock; return the
// child. Acquisition is detected by polling the lock file for OUR unique token
// (written by the holder only AFTER its blocking flock returns), which sidesteps
// any pid reuse. Returns null on safe degradation (no perl / spawn failure /
// holder died without acquiring / timeout) so the caller can proceed lock-free.
function acquireCommitLock(runId) {
  mkdirSync(locksDir(), { recursive: true });
  const lf = commitLockPath(runId);
  const token = `${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
  let child;
  try {
    child = spawn(PERL, ["-e", COMMIT_HOLDER_PL, lf, token], { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    return null; // cannot spawn -> degrade to lock-free (single writer == today's behavior)
  }
  // Swallow the async spawn-error event so a failed spawn never throws as an
  // unhandled 'error'; we detect the failure synchronously via !child.pid below.
  child.on("error", () => {});
  if (!child.pid) return null; // spawn failed synchronously (e.g. perl missing) -> degrade
  const deadline = Date.now() + commitLockTimeoutMs();
  for (;;) {
    const meta = readLockMeta(lf);
    if (meta && meta.token === token) return child; // we own the lock
    if (!pidAlive(child.pid)) return null;          // holder died without acquiring -> degrade
    if (Date.now() > deadline) {                     // never HANG a commit -> degrade
      try { child.kill("SIGKILL"); } catch {}
      return null;
    }
    sleepSyncMs(5);
  }
}

// Per-process re-entrancy guard: a single process never nests commit() today, but
// if a future caller did, re-acquiring the SAME runId lock from within would block
// on our OWN flock forever. So a nested withCommitLock for the runId we already
// hold simply runs the body — guaranteeing a single process's own commit can NEVER
// self-deadlock.
let _commitLockRunId = null;
let _commitLockDepth = 0;

function withCommitLock(runId, fn) {
  if (_commitLockDepth > 0 && _commitLockRunId === runId) {
    return fn(); // re-entrant: this process already holds this run's commit lock
  }
  const child = acquireCommitLock(runId);
  if (!child) return fn(); // degraded (lock unavailable) -> proceed lock-free (== prior behavior)
  _commitLockRunId = runId;
  _commitLockDepth = 1;
  const kill = () => { try { child.kill("SIGTERM"); } catch {} };
  // die()/process.exit() skips finally blocks but DOES run process 'exit'
  // listeners — so register one to release the holder on an error-exit path.
  process.on("exit", kill);
  try {
    return fn();
  } finally {
    _commitLockDepth = 0;
    _commitLockRunId = null;
    kill();
    process.removeListener("exit", kill);
  }
}

// commit is the ONLY path that writes state.tasks / state.subnodes. It runs the
// change against a working copy, projects the result to a folded graph, and
// validates it with validateGraph BEFORE touching the live state — so a change
// that would produce an invalid graph is rejected atomically (no partial write,
// non-zero exit via die, mirroring init's reject path). On success it installs
// the new tasks/subnodes onto the live state and persists.
//
// INVARIANT: a commit NEVER moves a `running` subnode to `pending`. A structural
// commit that re-readied genuinely in-flight work would let the orchestrator
// dispatch it a second time while the first run is still going. The ONLY legal
// running -> pending transition is the snapshot-isolation DISCARD at completion
// (cmdComplete/cmdResolve/cmdFail), where the run has already returned and the
// subnode is no longer truly in flight; those callers pass allowDiscard:true to
// authorize exactly that demotion. Every other commit is asserted against it,
// which protects the next task (invalidate) from accidentally re-dispatching live
// work. Note: settleRound only reopens subnodes that are NOT running (a settle
// runs after a round has settled), so existing behavior passes this guard.
function commit(state, change, { allowDiscard = false } = {}) {
  // Serialize the WHOLE read-modify-write under the runId commit lock (V17). fn
  // compute stays parallel (exec-node never commits); only this critical section
  // is single-writer. Uncontended the lock is a no-op (immediate acquire); under
  // contention writers run one at a time and none loses an update.
  withCommitLock(state.runId, () => {
    // SINGLE-WRITER RE-READ (V17): now that we hold the lock, adopt the latest
    // committed state from disk before computing the change, so a concurrent
    // writer's already-persisted update is FOLDED IN rather than overwritten by
    // our (possibly stale) in-memory copy — this is what makes two concurrent
    // same-GRAPH_ID committers lose no update. Uncontended (single writer) this
    // reads back exactly what `state` already held, so behavior is byte-identical.
    // The init path (no state file yet) skips the refresh and uses the in-memory
    // seed. Object.assign mutates `state` in place so the caller's post-commit
    // emitReady(state) reflects the freshly committed result.
    if (existsSync(statePath(state.runId))) {
      Object.assign(state, loadState(state.runId));
    }
    const working = {
      tasks: structuredClone(state.tasks),
      subnodes: structuredClone(state.subnodes),
      variables: state.variables,
      plan_file: state.plan_file,
    };
    // Snapshot which subnodes were running before the change, to enforce the
    // running -> pending invariant after it.
    const wasRunning = new Set(
      Object.entries(state.subnodes).filter(([, s]) => s.status === "running").map(([id]) => id),
    );
    change(working);
    const errors = validateGraph(projectFoldedGraph(working));
    if (errors.length) {
      die(`commit rejected (would produce an invalid graph):\n  - ${errors.join("\n  - ")}`);
    }
    if (!allowDiscard) {
      for (const id of wasRunning) {
        const after = working.subnodes[id];
        if (after && after.status === "pending") {
          die(`invariant violated: commit moved running subnode "${id}" to pending`);
        }
      }
    }
    // Recompute every task's Merkle contentHash now that the graph is known acyclic,
    // so each commit leaves all contentHash values fresh (deps before dependents).
    recomputeContentHashes(working);
    // With fresh hashes, structurally invalidate any work the commit made stale: a
    // done task whose inputs drifted is reset and redispatched (unchanged tasks are
    // reused); an auditing round built against a now-superseded implementation is
    // dropped atomically; a failed task is re-run only within a generation bound.
    // invalidateStale never moves a running subnode to pending (it gates on no
    // running subnode, or only DELETES running auditors), so commit's running ->
    // pending invariant holds even though it runs after the assertion above.
    invalidateStale(working);
    state.tasks = working.tasks;
    state.subnodes = working.subnodes;
    state.commitSeq = (state.commitSeq || 0) + 1;
    saveState(state);
  });
}

// ---------------------------------------------------------------------------
// scheduling helpers
// ---------------------------------------------------------------------------

// A dependency task is satisfied when it is resolved: completed ("done") OR
// terminally failed ("failed"), so a logged failure does not halt the graph.
function taskResolved(state, taskId) {
  const t = state.tasks[taskId];
  return t && (t.status === "done" || t.status === "failed");
}

// A dependency task has SUCCEEDED when it reached "done" — a stricter bar than
// taskResolved, used by the plain (all-done) flat kinds so they never run on a
// failed/missing input.
function taskDone(state, taskId) {
  return state.tasks[taskId]?.status === "done";
}

// Type-driven readiness for the GENERALIZED flat node kinds (agent/fn/expand/
// switch) — the V3 analogue of the legacy IMPL/RESOLVE/AUDIT subnode branches, but
// keyed on a node's TYPE rather than a fixed subnode role. A flat node carries NO
// subnode (the TASK itself is the schedulable unit), so readySet reports a ready one
// by its task id. Rules (Design §SCHEDULING):
//   agent, fn (require defaults to "all-done") : ready once EVERY dep is DONE, so a
//        plain node never runs on a failed/missing input.
//   fn (require="all-resolved", a reducer/gather) : ready once every dep is RESOLVED
//        (done|failed), so it can read the per-dep failure envelopes and gather.
//   expand, switch : ready once their single upstream (the `over` node) is DONE WITH
//        an output (outputRef present) — the expansion list / branch selector is read
//        from that output, so a done-but-output-less upstream is not yet ready.
// Returns false for the legacy implement/resolve/audit/reduce task types (scheduled
// via their subnodes above, or dormant), so a node is never double-scheduled.
function flatNodeReady(state, task) {
  const deps = task.deps || [];
  switch (task.type) {
    case TYPE_AGENT:
      return deps.every((d) => taskDone(state, d));
    case TYPE_FN:
      return task.require === "all-resolved"
        ? deps.every((d) => taskResolved(state, d))
        : deps.every((d) => taskDone(state, d));
    case TYPE_EXPAND:
    case TYPE_SWITCH: {
      const up = state.tasks[task.over];
      return !!up && up.status === "done" && up.outputRef !== undefined;
    }
    default:
      return false; // implement/resolve/audit/reduce are scheduled elsewhere
  }
}

function readySet(state) {
  const ready = [];
  // LEGACY implement-and-audit lifecycle — subnode/role driven. UNCHANGED: the
  // active execute-plan run schedules its remaining implement tasks through these
  // exact branches, so they keep working verbatim.
  for (const [id, sub] of Object.entries(state.subnodes)) {
    if (sub.status !== "pending") continue;
    if (sub.role === IMPL) {
      const deps = state.tasks[sub.task].deps || [];
      if (deps.every((d) => taskResolved(state, d))) ready.push(id);
    } else if (sub.role === RESOLVE) {
      if (state.subnodes[implId(sub.task)]?.status === "done") ready.push(id);
    } else if (sub.role === AUDIT) {
      // audit subnodes exist only after `resolve`; a pending one is ready.
      ready.push(id);
    }
  }
  // GENERALIZED flat node kinds (agent/fn/expand/switch) — type driven, ADDED
  // ALONGSIDE the legacy branches above. A flat node has no subnode, so a ready one
  // is reported by its TASK id; flatNodeReady returns false for the legacy task
  // types, so the two schedulers never overlap.
  for (const [id, task] of Object.entries(state.tasks)) {
    if (task.status !== "pending") continue;
    if (flatNodeReady(state, task)) ready.push(id);
  }
  return ready.sort();
}

// The executor a ready node is dispatched with. A legacy subnode carries its own
// executor; a generalized flat node carries it on its task record (agent) or has
// none (the engine-driven fn/expand/switch). Falls back to "" so emitting a ready
// line for an engine-driven node never crashes on an absent executor.
function readyExecutor(state, id) {
  return state.subnodes[id]?.executor ?? state.tasks[id]?.executor ?? "";
}

// In-flight (running/dispatched) work units, used ONLY to bound the OPTIONAL
// concurrency window. Counts running legacy subnodes (the impl/resolve/audit work
// units the active run dispatches) plus any generalized flat-node task carrying a
// running/dispatched status. No flat-node task is marked running today, so this
// equals the running-subnode count — the same measure `active` reports as
// `running` — and the default no-window path never consults it, so it changes
// nothing there.
function inFlightCount(state) {
  let n = 0;
  for (const s of Object.values(state.subnodes)) {
    if (s.status === "running") n++;
  }
  for (const t of Object.values(state.tasks)) {
    if (t.status === "running" || t.status === "dispatched") n++;
  }
  return n;
}

// How many otherwise-ready nodes may be EMITTED this cycle under an OPTIONAL
// concurrency window. With NO window (undefined/null) the budget is Infinity, so
// the whole readySet is emitted UNCHANGED — the unbounded default the active
// self-orchestrating run depends on. With a window N the budget is
// max(0, N - in-flight), so `ready` emits at most that many and defers the rest.
function windowBudget(state, window) {
  if (window === undefined || window === null) return Infinity;
  return Math.max(0, window - inFlightCount(state));
}

// `window` is OPTIONAL. When omitted (the active run's call site), the result is
// byte-identical to before: only the four original fields. When a window is
// supplied, three ADDITIVE fields report the THIRD ready-deferred reason — work
// held back because in-flight is at the concurrency cap — alongside the existing
// dispatchable / resource-blocked classification, without altering it.
function readyDispatchability(state, window) {
  const readyIds = readySet(state);
  let dispatchableReady = 0;
  let resourceBlockedReady = 0;
  const blockedResources = new Set();
  for (const id of readyIds) {
    const resource = resourceOf(readyExecutor(state, id));
    if (!resource) {
      dispatchableReady++;
      continue;
    }
    const meta = readLockMeta(lockPath(resource));
    if (!meta || !pidAlive(meta.pid)) {
      dispatchableReady++;
    } else {
      resourceBlockedReady++;
      blockedResources.add(resource);
    }
  }
  const result = {
    ready: readyIds.length,
    dispatchableReady,
    resourceBlockedReady,
    blockedResources: [...blockedResources].sort(),
  };
  if (window !== undefined && window !== null) {
    const inFlight = inFlightCount(state);
    const budget = Math.max(0, window - inFlight);
    result.window = window;
    result.inFlight = inFlight;
    result.windowDeferred = Math.max(0, readyIds.length - budget);
  }
  return result;
}

// `window` is OPTIONAL. With no window the loop emits every ready node exactly as
// before (budget = Infinity, the break never fires). With a window N it emits at
// most max(0, N - in-flight) nodes in the same stable (sorted) readySet order and
// defers the rest (ready-deferred).
function emitReady(state, window) {
  const budget = windowBudget(state, window);
  let emitted = 0;
  for (const id of readySet(state)) {
    if (emitted >= budget) break;
    process.stdout.write(`${id}\t${readyExecutor(state, id)}\n`);
    emitted++;
  }
}

function requireSubnode(state, nodeId) {
  if (!nodeId || typeof nodeId !== "string") die("--node <subnode-id> is required");
  const sub = state.subnodes[nodeId];
  if (!sub) die(`unknown subnode "${nodeId}"`);
  return sub;
}

// Like requireSubnode, but for the SETTLING verbs (complete/resolve/fail). A
// structural commit can DELETE a subnode while its run is in flight — most often
// an .audit.<i> dropped by an atomic round invalidation. When the in-flight
// auditor later returns and calls complete/fail on that now-missing subnode, the
// engine must NOT crash: the round it belonged to is already gone, so the late
// result is meaningless. We treat it as a no-op discard (emit the current ready
// set, exit 0) rather than die, so the engine survives the in-flight auditor's
// late return. Returns null when the subnode is gone (caller should no-op).
function settleSubnodeOrDiscard(state, nodeId) {
  if (!nodeId || typeof nodeId !== "string") die("--node <subnode-id> is required");
  return state.subnodes[nodeId] || null;
}

// Snapshot isolation at completion time. A subnode was dispatched against the
// task's contentHash at that moment (its dispatchHash). If the task's contentHash
// has since changed — the graph moved out from under the in-flight work — the
// result was computed against a now-superseded version and MUST be discarded: the
// subnode is reset to "pending" (so `ready` re-offers it for a single fresh
// redispatch) and NOTHING is applied (no settle, no panel registration, no
// status=done). Returns true when the result was discarded (the caller must NOT
// apply it). When no dispatchHash is stamped (legacy/unstamped), treat as fresh.
function discardIfStale(working, nodeId) {
  const sub = working.subnodes[nodeId];
  // Under the runId commit lock, a concurrent writer may have DELETED this subnode
  // (e.g. a combinator teardown) between the caller's pre-lock read and commit's
  // re-read. A missing subnode has nothing to settle, so treat it as a discard
  // (the caller no-ops) rather than dereferencing undefined. This triggers ONLY
  // under contention; the uncontended single-writer path always finds the subnode,
  // so its behavior is unchanged.
  if (!sub) return true;
  const current = working.tasks[sub.task]?.contentHash;
  if (sub.dispatchHash === undefined || sub.dispatchHash === current) return false;
  sub.status = "pending";
  return true;
}

function taskAuditEntries(state, taskId) {
  return Object.entries(state.subnodes).filter(([, s]) => s.task === taskId && s.role === AUDIT);
}

// Decide a task's fate once every auditor in the round has reported. This is a
// CHANGE: it edits the working copy commit hands it (never the live state), so
// its writes to tasks/subnodes go through commit's validation. Its logic and
// its stderr messages are unchanged from before.
function settleRound(working, taskId) {
  const entries = taskAuditEntries(working, taskId);
  if (entries.length === 0) return; // no auditors registered yet
  const subs = entries.map(([, s]) => s);
  if (!subs.every((s) => s.status === "done" || s.status === "failed")) return; // round in progress
  const task = working.tasks[taskId];
  const failed = subs.filter((s) => s.status === "failed");
  if (failed.length === 0) {
    task.status = "done"; // every auditor passed on this implementation
    // Record the contentHash at which this task last reached "done". A settle
    // commit does not touch spec/deps/executor, so the end-of-commit recompute
    // reproduces this same value; later tasks (invalidate) compare it against a
    // freshly recomputed contentHash to decide carry-over. NOT read for any
    // decision here — only stored.
    task.doneHash = task.contentHash;
    return;
  }
  task.attempts = (task.attempts || 0) + 1;
  task.lastReason = failed.map((s) => s.lastReason).filter(Boolean).join("; ") || null;
  // Drop this round's auditors; the next round re-resolves from the new diff.
  for (const [id] of entries) delete working.subnodes[id];
  if (task.attempts < task.max_attempts) {
    working.subnodes[implId(taskId)].status = "pending";
    working.subnodes[resolveId(taskId)].status = "pending";
    task.status = "pending";
    process.stderr.write(`retry ${task.attempts}/${task.max_attempts} for task "${taskId}"; reopening ${implId(taskId)}\n`);
  } else {
    task.status = "failed"; // logged, non-halting; successors proceed
    // Stamp the contentHash this task last SETTLED at (here, terminally failed),
    // exactly as the done path does. doneHash is the "last settled hash" drift
    // reference structural invalidation reads; without it a failed task has no
    // baseline, so invalidateStale could not tell a genuine input drift from an
    // unrelated commit. The plan keys invalidation on `doneHash != contentHash`
    // for status done|failed alike, so both terminal paths must record it.
    task.doneHash = task.contentHash;
    process.stderr.write(`task "${taskId}" FAILED after ${task.attempts} attempt(s); logged, continuing\n`);
  }
}

// ---------------------------------------------------------------------------
// verbs
// ---------------------------------------------------------------------------

function cmdInit(opts) {
  if (!opts.graph || opts.graph === true) die("init requires --graph <file>");
  let graph;
  try {
    graph = JSON.parse(readFileSync(opts.graph, "utf8"));
  } catch (err) {
    die(`cannot read/parse --graph ${opts.graph}: ${err.message}`);
  }
  const errors = validateGraph(graph);
  if (errors.length) {
    die(`invalid folded graph:\n  - ${errors.join("\n  - ")}`);
  }
  const salt = typeof opts.salt === "string" ? opts.salt : "";
  const runId = computeGraphId(graph, salt);
  const path = statePath(runId);
  if (existsSync(path)) {
    process.stderr.write(`resuming existing state for GRAPH_ID ${runId}\n`);
    process.stdout.write(`${runId}\n`);
    return;
  }
  // Mode B (divide-and-conquer): a skill ships its graph.json ALONGSIDE its `fn`
  // module files. Record the graph file's own directory so a node's RELATIVE `module`
  // resolves against the SKILL/GRAPH dir (where the modules ship) rather than the cwd
  // that happened to run `init`. The stored `module` string is left verbatim (its
  // identity hash is unchanged); only the resolution BASE is recorded here and applied
  // in exec-node. An ABSOLUTE `module` is used verbatim there (lifecycle.mjs ships
  // absolute module handles), so this never disturbs the existing absolute-path path.
  const graphDir = dirname(resolvePath(opts.graph));
  const state = { runId, commitSeq: 0, salt: salt || null, cwd: process.cwd(), graphDir, plan_file: graph.plan_file, variables: graph.variables || {}, tasks: {}, subnodes: {} };
  commit(state, (working) => explode(working, graph)); // single validated writer; persists on success
  const taskCount = Object.keys(state.tasks).length;
  const subCount = Object.keys(state.subnodes).length;
  process.stderr.write(`initialized ${taskCount} tasks -> ${subCount} subnodes (all pending)\n`);
  process.stdout.write(`${runId}\n`);
}

// Parse the OPTIONAL --window flag. Absent -> undefined (UNBOUNDED, default,
// byte-identical behavior). Present -> a non-negative integer; anything else
// (a bare flag, a non-integer, a negative) is rejected before any state read.
function parseWindowOpt(opts) {
  if (!("window" in opts)) return undefined;
  const raw = opts.window;
  if (raw === true) die("--window requires a non-negative integer value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) die(`--window must be a non-negative integer, got "${raw}"`);
  return n;
}

function cmdReady(opts) {
  const w = parseWindowOpt(opts);   // validate --window BEFORE any state read
  const state = loadState(opts.id);
  emitReady(state, w);
}

// dispatch: the only pending -> running transition. Marks a ready subnode as
// in-flight so `ready` (which only offers `pending`) won't re-offer it. The
// settling verbs (complete/resolve/fail) move running -> done/failed.
function cmdDispatch(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
  if (sub.status !== "pending") {
    die(`dispatch expects a pending subnode, "${opts.node}" is "${sub.status}"`);
  }
  // Stamp the task's CURRENT contentHash as this subnode's dispatchHash at the
  // moment it goes pending -> running. This pins the graph version the work runs
  // against; onComplete compares it to the task's (possibly newer) contentHash and
  // DISCARDS a result whose graph version was superseded (snapshot isolation).
  commit(state, (working) => {
    working.subnodes[opts.node].status = "running";
    working.subnodes[opts.node].dispatchHash = working.tasks[working.subnodes[opts.node].task].contentHash;
  });
}

// Resolve the OUTPUT a completion records, from the mutually-exclusive
//   --output <json>       : the value inline as JSON
//   --output-file <path>  : the value as a JSON file
//   --output-ref <handle> : the value is ALREADY in the store (pure by-reference;
//                           the caller passes only a handle, never the bytes)
// Returns { has:false } when no output flag was passed (a completion that records
// no value, e.g. the legacy impl-lifecycle subnodes). For --output-ref the value
// is loaded back from the store so it can still be validated against the schema.
function readCompletionOutput(opts, runId) {
  const forms = ["output", "output-file", "output-ref"].filter((k) => k in opts);
  if (forms.length === 0) return { has: false };
  if (forms.length > 1) {
    die(`pass only one of --output / --output-file / --output-ref (got ${forms.join(", ")})`);
  }
  if ("output-ref" in opts) {
    const handle = opts["output-ref"];
    if (typeof handle !== "string" || !handle) die("--output-ref requires a handle");
    return { has: true, value: loadValue(runId, handle), ref: handle };
  }
  let raw;
  if ("output-file" in opts) {
    const path = opts["output-file"];
    if (typeof path !== "string" || !path) die("--output-file requires a path");
    try { raw = readFileSync(path, "utf8"); } catch (err) { die(`cannot read --output-file ${path}: ${err.message}`); }
  } else {
    raw = opts.output;
    if (typeof raw !== "string") die("--output requires a JSON value");
  }
  let value;
  try { value = JSON.parse(raw); } catch (err) { die(`--output is not valid JSON: ${err.message}`); }
  return { has: true, value };
}

function cmdComplete(opts) {
  const state = loadState(opts.id);
  const sub = settleSubnodeOrDiscard(state, opts.node);
  if (!sub) { emitReady(state); return; } // subnode deleted mid-flight: no-op discard
  if (sub.role === RESOLVE) {
    die(`use the resolve verb (with --panel) for a .resolve subnode, got "${opts.node}"`);
  }
  // BY-REFERENCE OUTPUT CHANNEL (V4): when the caller passes an output, validate it
  // against the node's output_schema and record it BY REFERENCE (a content-addressed
  // handle), never the bytes — the orchestrator's view holds only node-id -> handle.
  // A value that violates the schema is rejected here (non-zero, before any state
  // change), so the store never holds an output that contradicts its declared shape.
  const out = readCompletionOutput(opts, state.runId);
  let outputRef;
  if (out.has) {
    const schema = state.tasks[sub.task]?.output_schema;
    if (!schema) die(`task "${sub.task}" has no output_schema; --output cannot be recorded`);
    const errs = [];
    validateValueAgainstSchema(out.value, schema, `output for node "${sub.task}"`, errs);
    if (errs.length) die(`--output rejected (violates output_schema):\n  - ${errs.join("\n  - ")}`);
    // --output-ref is already stored (caller passed only the handle); --output /
    // --output-file store the parsed value, deduping on its content hash.
    outputRef = out.ref !== undefined ? out.ref : storeValue(state.runId, out.value);
  }
  commit(state, (working) => {
    if (discardIfStale(working, opts.node)) return; // graph moved; re-ready, do not apply
    if (outputRef !== undefined) working.tasks[sub.task].outputRef = outputRef;
    if (sub.role === IMPL) {
      working.subnodes[opts.node].status = "done";
      working.tasks[sub.task].status = "impl-done";
    } else if (sub.role === AUDIT) {
      working.subnodes[opts.node].status = "done";
      settleRound(working, sub.task);
    }
  }, { allowDiscard: true });
  emitReady(state);
}

function cmdResolve(opts) {
  const state = loadState(opts.id);
  const sub = settleSubnodeOrDiscard(state, opts.node);
  if (!sub) { emitReady(state); return; } // subnode deleted mid-flight: no-op discard
  if (sub.role !== RESOLVE) die(`resolve expects a .resolve subnode, got "${opts.node}"`);
  if (typeof opts.panel !== "string") die("resolve requires --panel <json>");
  let panel;
  try {
    panel = JSON.parse(opts.panel);
  } catch (err) {
    die(`--panel is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(panel) || panel.length < 1) die("--panel must be a non-empty JSON array");
  panel.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") die(`panel[${i}] must be an object`);
    if (typeof entry.focus !== "string" || !entry.focus) die(`panel[${i}].focus must be a non-empty string`);
    if (typeof entry.executor !== "string" || !EXECUTOR_RE.test(entry.executor)) {
      die(`panel[${i}].executor must match ${EXECUTOR_RE}`);
    }
  });
  const taskId = sub.task;
  commit(state, (working) => {
    if (discardIfStale(working, opts.node)) return; // graph moved; re-ready, do not register auditors
    working.subnodes[opts.node].status = "done";
    panel.forEach((entry, i) => {
      working.subnodes[auditId(taskId, i)] = {
        task: taskId, role: AUDIT, status: "pending",
        executor: entry.executor, focus: entry.focus, lastReason: null,
      };
    });
    working.tasks[taskId].status = "auditing";
  }, { allowDiscard: true });
  emitReady(state);
}

function cmdFail(opts) {
  const state = loadState(opts.id);
  const sub = settleSubnodeOrDiscard(state, opts.node);
  if (!sub) { emitReady(state); return; } // subnode deleted mid-flight: no-op discard
  if (sub.role !== AUDIT) die(`fail expects an audit subnode (<id>.audit.<i>), got "${opts.node}"`);
  commit(state, (working) => {
    if (discardIfStale(working, opts.node)) return; // graph moved; re-ready, do not settle
    const s = working.subnodes[opts.node];
    s.status = "failed";
    s.lastReason = typeof opts.reason === "string" ? opts.reason : null;
    settleRound(working, sub.task);
  }, { allowDiscard: true });
  emitReady(state);
}

// ---------------------------------------------------------------------------
// graph-mutation primitives — INTERNAL USE ONLY
//
// spawn-task / remove-task / add-dep / remove-dep are the low-level building
// blocks that expand, switch, and loop use internally to grow/prune the graph.
// Public graph growth happens ONLY through expand (fan-out) and switch (branch);
// orchestration prompts and plan files must NOT call these raw verbs directly.
//
// All four route through commit, so they inherit validateGraph + content-hash
// invalidation identically to every other mutating verb. An incomplete/invalid
// spec, a duplicate id, a dangling dep, or a cycle-creating edge is rejected
// atomically (no partial write, non-zero exit via die) — the raw verbs rely
// entirely on that shared path and do NOT re-implement validation themselves.
// ---------------------------------------------------------------------------

// Insert a brand-new task and its impl/resolve subnodes. The full spec (a folded-
// graph node minus its id) is taken verbatim and exploded into subnodes by reusing
// `explode`. We do NOT pre-validate the spec ourselves beyond requiring a JSON
// object and a task id: commit's validateGraph rejects an incomplete/invalid spec,
// a duplicate id, or a dep on a non-existent task — that reuse IS the "requires a
// complete schema-valid spec" guarantee.
function cmdSpawnTask(opts) {
  const state = loadState(opts.id);
  const taskId = typeof opts["task-id"] === "string" ? opts["task-id"] : null;
  if (!taskId) die("spawn-task requires --task-id <id>");
  if (typeof opts.spec !== "string") die("spawn-task requires --spec <json>");
  let spec;
  try {
    spec = JSON.parse(opts.spec);
  } catch (err) {
    die(`--spec is not valid JSON: ${err.message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    die("--spec must be a JSON object describing the task");
  }
  if (state.tasks[taskId]) die(`task "${taskId}" already exists`);
  // The spec is a folded-graph node body; stamp the id so explode (and validateGraph
  // via projectFoldedGraph) see one node. explode reads node.id for its subnode keys.
  const node = { ...spec, id: taskId };
  commit(state, (working) => explode(working, { nodes: [node] }));
  emitReady(state);
}

// Remove a task and ALL its subnodes (impl/resolve/audit). BEFORE deleting, collect
// every removed subnode whose executor is exclusive (resourceOf != null) and print a
// `RELEASE <runId>:<S>` line so the orchestrator can release the host-global lock —
// no silent lock leak. A RemoveTask whose target still has dependents is rejected by
// commit's dangling-dep check (validateGraph errors on the dependent's dead dep);
// we also check up-front for a clearer message and to avoid printing RELEASE lines
// for a removal that would then be rejected.
function cmdRemoveTask(opts) {
  const state = loadState(opts.id);
  const taskId = typeof opts["task-id"] === "string" ? opts["task-id"] : null;
  if (!taskId) die("remove-task requires --task-id <id>");
  if (!state.tasks[taskId]) die(`unknown task "${taskId}"`);
  // Up-front dependent check: removing a task other tasks still depend on would leave
  // a dangling dep (which commit would reject anyway); die with a clear message first.
  const dependents = Object.entries(state.tasks)
    .filter(([id, t]) => id !== taskId && (t.deps || []).includes(taskId))
    .map(([id]) => id);
  if (dependents.length) {
    die(`cannot remove task "${taskId}": still depended on by ${dependents.join(", ")}`);
  }
  // Guard in-flight work: deleting a RUNNING subnode orphans its subagent and, for an
  // exclusive executor, frees a host resource the subagent may still be using. Refuse
  // unless --force makes that destruction explicit.
  const running = Object.entries(state.subnodes)
    .filter(([, sub]) => sub.task === taskId && sub.status === "running")
    .map(([subId]) => subId);
  if (running.length && !opts.force) {
    die(`cannot remove task "${taskId}": ${running.length} running subnode(s) (${running.join(", ")}); pass --force to remove and orphan in-flight work`);
  }
  // Collect dangling exclusive-lock owners from the LIVE state (before the change). They
  // are emitted AFTER the commit succeeds (below), so a rejected removal -- e.g. removing
  // the last task, which leaves an empty graph that validateGraph rejects -- never tells
  // the orchestrator to free a lock for work that was not removed. Owner format matches
  // the "<runId>:<S>" hold/release convention.
  const owners = Object.entries(state.subnodes)
    .filter(([, sub]) => sub.task === taskId && resourceOf(sub.executor))
    .map(([subId]) => `${state.runId}:${subId}`);
  commit(state, (working) => {
    delete working.tasks[taskId];
    for (const subId of Object.keys(working.subnodes)) {
      if (working.subnodes[subId].task === taskId) delete working.subnodes[subId];
    }
  });
  // commit returned (it process-exits on rejection), so the removal is durable. Only now
  // is it safe to surface the side effects: warn about orphaned in-flight work, then RELEASE.
  if (running.length) {
    process.stderr.write(`task: warning: orphaning ${running.length} running subnode(s) of "${taskId}" (${running.join(", ")})\n`);
  }
  for (const owner of owners) process.stdout.write(`RELEASE ${owner}\n`);
  emitReady(state);
}

// AddDep(a, b): add b to a's deps. commit rejects a cycle automatically
// (validateGraph -> findCycle) and a dep on a non-existent task. Changing a's deps
// flips a's contentHash, which the end-of-commit recompute + invalidateStale handle
// (no special-casing here, by design).
function cmdAddDep(opts) {
  const state = loadState(opts.id);
  const a = typeof opts.from === "string" ? opts.from : null;
  const b = typeof opts.to === "string" ? opts.to : null;
  if (!a || !b) die("add-dep requires --from <a> and --to <b>");
  if (!state.tasks[a]) die(`unknown task "${a}"`);
  commit(state, (working) => {
    const deps = working.tasks[a].deps || (working.tasks[a].deps = []);
    if (!deps.includes(b)) deps.push(b);
  });
  emitReady(state);
}

// RemoveDep(a, b): remove b from a's deps.
function cmdRemoveDep(opts) {
  const state = loadState(opts.id);
  const a = typeof opts.from === "string" ? opts.from : null;
  const b = typeof opts.to === "string" ? opts.to : null;
  if (!a || !b) die("remove-dep requires --from <a> and --to <b>");
  if (!state.tasks[a]) die(`unknown task "${a}"`);
  commit(state, (working) => {
    working.tasks[a].deps = (working.tasks[a].deps || []).filter((d) => d !== b);
  });
  emitReady(state);
}

// ---------------------------------------------------------------------------
// host-global resource locks: a kernel flock(2) held by a live `hold` process
// (the OS releases it automatically when that process dies — normal exit,
// SIGKILL, or session shutdown), with a pid/TTL backstop for a leaked holder.
// flock(2) is reached via the bundled `perl` (no extra dependency).
// ---------------------------------------------------------------------------

const RESOURCE_RE = /^[A-Za-z0-9_.-]+$/;

function locksDir() { return join(stateDir(), "locks"); }

function lockPath(resource) {
  if (!RESOURCE_RE.test(resource)) die(`invalid --resource "${resource}"`);
  return join(locksDir(), `${resource}.lock`);
}

function readLockMeta(lf) {
  if (!existsSync(lf)) return null;
  let txt;
  try { txt = readFileSync(lf, "utf8"); } catch { return null; }
  const meta = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^(\w+)\s+(.+)$/);
    if (m) meta[m[1]] = m[2];
  }
  if (meta.pid) meta.pid = parseInt(meta.pid, 10);
  if (meta.ts) meta.ts = parseInt(meta.ts, 10);
  return Object.keys(meta).length ? meta : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

// The flock holder (perl): acquire LOCK_EX|LOCK_NB; on busy reclaim only a stale
// holder (dead pid or past TTL); on success write {owner,pid,ts}, print HELD, and
// block holding the fd until killed or its parent (the `hold` node proc) dies.
const HOLDER_PL = [
  "use strict; use warnings;",
  "use Fcntl qw(:DEFAULT :flock);",
  "use IO::Handle;",
  "use Time::HiRes qw(time);",
  "my ($lf,$owner,$ttl)=@ARGV; $ttl=($ttl||0)+0;",
  "sysopen(my $fh,$lf,O_RDWR|O_CREAT,0644) or die qq(open: $!);",
  "$fh->autoflush(1);",
  "$| = 1;",
  "my $got=flock($fh,LOCK_EX|LOCK_NB);",
  "my $o=qq();",
  "if(!$got){",
  "  my ($pid,$ts)=(0,0);",
  "  if(open(my $r,qq(<),$lf)){while(<$r>){$o=$1 if /^owner\\s+(.+)/;$pid=$1 if /^pid\\s+(\\d+)/;$ts=$1 if /^ts\\s+(\\d+)/}close $r}",
  "  my $stale=(($pid && !kill(0,$pid)) || ($ttl>0 && $ts && (int(time()*1000)-$ts)>$ttl));",
  "  if($stale){kill(qq(TERM),$pid) if $pid; select(undef,undef,undef,0.2); $got=flock($fh,LOCK_EX|LOCK_NB)}",
  "}",
  "if(!$got){print qq(BUSY owner=$o\\n); exit 9}",
  "truncate($fh,0); seek($fh,0,0);",
  "print $fh qq(owner $owner\\npid $$\\nts ).int(time()*1000).qq(\\n);",
  "print qq(HELD\\n);",
  "$SIG{TERM}=sub{exit 0}; $SIG{INT}=sub{exit 0};",
  "while(1){ select(undef,undef,undef,0.25); exit 0 if getppid()==1 }",
].join("\n");

function cmdHold(opts) {
  const resource = typeof opts.resource === "string" ? opts.resource : null;
  if (!resource) die("hold requires --resource <name>");
  const owner = typeof opts.owner === "string" ? opts.owner : "manual";
  const ttl = Number(opts.ttl ?? process.env.AMPLIFY_LOCK_TTL_MS ?? DEFAULT_LOCK_TTL_MS);
  mkdirSync(locksDir(), { recursive: true });
  const lf = lockPath(resource);
  const child = spawn(PERL, ["-e", HOLDER_PL, lf, owner, String(ttl)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (err) => die(`cannot run perl for flock: ${err.message}`));
  const forward = (sig) => { try { child.kill(sig); } catch {} };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  // Stay alive while the holder holds; exit with it (release/crash both land here).
  child.on("exit", (code) => process.exit(code == null ? 0 : code));
}

function cmdRelease(opts) {
  const resource = typeof opts.resource === "string" ? opts.resource : null;
  if (!resource) die("release requires --resource <name>");
  const owner = typeof opts.owner === "string" ? opts.owner : null;
  const meta = readLockMeta(lockPath(resource));
  if (!meta || !meta.pid) { process.stdout.write(`released ${resource} (no holder)\n`); return; }
  if (owner && meta.owner !== owner) {
    die(`refuse to release "${resource}": held by "${meta.owner}", not "${owner}"`);
  }
  try { process.kill(meta.pid, "SIGTERM"); } catch {}
  process.stdout.write(`released ${resource}\n`);
}

function cmdHolds(opts) {
  const resource = typeof opts.resource === "string" ? opts.resource : null;
  if (!resource) die("holds requires --resource <name>");
  const meta = readLockMeta(lockPath(resource));
  if (!meta) { process.stdout.write("FREE\n"); return; }
  const state = pidAlive(meta.pid) ? "HELD" : "STALE";
  process.stdout.write(`${state} owner=${meta.owner || ""} pid=${meta.pid || ""}\n`);
}

function cmdResourceOf(opts) {
  const executor = typeof opts.executor === "string" ? opts.executor : null;
  if (!executor) die("resource-of requires --executor <subagent(...)>");
  const r = resourceOf(executor);
  if (r) process.stdout.write(`${r}\n`);
}

function cmdVariables(opts) {
  if (!opts.id || opts.id === true) die("variables requires --id <GRAPH_ID>");
  const state = loadState(opts.id);
  for (const [name, value] of Object.entries(state.variables || {})) {
    process.stdout.write(`${name}\t${Array.isArray(value) ? value.join(", ") : value}\n`);
  }
}

// The per-dep INPUT ENVELOPES for a node, read from the value store: one
// {status, output?} entry per upstream dep, keyed by dep id. A dep that reached
// "done" carries its recorded output BY REFERENCE resolved to the value (present
// even when falsy: [] / false / 0); a dep that did NOT succeed carries status
// "failed" with NO `output` key, so a reader can DISTINGUISH a failure from a
// valid empty/falsy output. This is the single source of truth for the envelope
// shape, shared by `resolve-context --inputs` (an executor fetching its own
// inputs) and `exec-node` (a deterministic fn running over the same inputs).
function inputEnvelopes(state, task) {
  const envelopes = {};
  for (const dep of task.deps || []) {
    const d = state.tasks[dep];
    if (d && d.status === "done") {
      const env = { status: "done" };
      if (d.outputRef !== undefined) env.output = loadValue(state.runId, d.outputRef);
      envelopes[dep] = env;
    } else {
      envelopes[dep] = { status: "failed" };
    }
  }
  return envelopes;
}

// Dump the audit-resolver's context for one task: its goal (name), design aspect,
// plan file, acceptance criteria, and the run's variables — so execute-plan need
// not inline them into the resolver's spawn prompt.
function cmdResolveContext(opts) {
  if (!opts.id || opts.id === true) die("resolve-context requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("resolve-context requires --node <task-id>");
  const state = loadState(opts.id);
  const t = state.tasks[opts.node];
  if (!t) die(`unknown task "${opts.node}"`);
  // INPUT ENVELOPES (V11): with --inputs, return one {status, output?} ENVELOPE per
  // upstream dep, read from the value store, keyed by dep id. A dep that reached
  // "done" carries its recorded output BY REFERENCE resolved to the value — present
  // even when falsy ([] / false / 0); a dep that did NOT succeed carries status
  // "failed" with NO `output` key, so a dependent can DISTINGUISH a failure from a
  // valid empty/falsy output. This is EXECUTOR-side: the dependent node fetches its
  // own inputs here, so values enter the executor's context, never the orchestrator's
  // (which passes only node ids in and reads only handles/status out).
  if (opts.inputs) {
    process.stdout.write(JSON.stringify(inputEnvelopes(state, t)) + "\n");
    return;
  }
  const out = [
    `TASK NAME: ${t.name}`,
    `DESIGN ASPECT: ${t.design_aspect ?? ""}`,
    `PLAN FILE: ${state.plan_file ?? ""}`,
    "ACCEPTANCE CRITERIA:",
    ...(t.acceptance_criteria || []).map((c) => `- ${c}`),
    "VARIABLES:",
    ...Object.entries(state.variables || {}).map(([name, value]) =>
      `${name}\t${Array.isArray(value) ? value.join(", ") : value}`),
  ];
  process.stdout.write(out.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// deterministic fn execution (exec-node)
// ---------------------------------------------------------------------------

// Run a deterministic `fn` node and record its typed output BY REFERENCE.
//
// exec-node --id <GRAPH_ID> --node <fn-node-id>
//   1. reads the fn node's record (module, export, output_schema, deps);
//   2. builds the per-dep INPUT ENVELOPES from the value store (the SAME
//      {status, output?} shape as resolve-context --inputs, via inputEnvelopes);
//   3. dynamically imports `module` (a relative path resolves against the graph/skill
//      dir recorded at init — state.graphDir — so a Mode B skill's modules resolve next
//      to its graph.json; an absolute path is used verbatim) and calls its `export`
//      with those envelopes as a PURE function over the inputs;
//   4. validates the returned value against output_schema (validateValueAgainstSchema)
//      — a violation is rejected non-zero and NOTHING is stored;
//   5. writes the value to the content-addressed store (storeValue) and prints ONLY
//      the handle to stdout.
//
// It is READ-ONLY on engine state: it calls loadState but NEVER commit/saveState, so
// it does not advance the lifecycle. The orchestrator commits the result separately
// (`complete --output-ref <handle>`), which is why printing only the handle is the
// whole contract: no value or gather aggregate ever crosses back through stdout.
// This makes exec-node safe to invoke both inline by the orchestrator and as a
// standalone `node task.mjs exec-node` background process.
//
// PURITY CONTRACT: the module export MUST be a pure function of its input envelopes —
// same inputs => same output, no I/O, no hidden state, no wall-clock/entropy reads.
// The engine cannot fully verify purity, but it cheaply NEUTRALIZES the two most
// common nondeterminism sources by stubbing Date.now and Math.random to constants
// while the body runs (restored in a finally), so an accidental read yields a
// deterministic value rather than a run-varying one. A function may be sync or async
// (its result is awaited).
async function cmdExecNode(opts) {
  if (!opts.id || opts.id === true) die("exec-node requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("exec-node requires --node <fn-node-id>");
  const state = loadState(opts.id);
  const task = state.tasks[opts.node];
  if (!task) die(`unknown node "${opts.node}"`);
  if (task.type !== TYPE_FN) {
    die(`exec-node runs a "fn" node; node "${opts.node}" is type "${task.type ?? TYPE_IMPLEMENT}"`);
  }
  if (typeof task.module !== "string" || !task.module) die(`fn node "${opts.node}" has no module`);
  if (typeof task["export"] !== "string" || !task["export"]) die(`fn node "${opts.node}" has no export`);
  if (!task.output_schema) die(`fn node "${opts.node}" has no output_schema`);

  // Build the input envelopes (reuses the resolve-context --inputs machinery: the
  // value store + loadValue), then import the module and resolve its export.
  const inputs = inputEnvelopes(state, task);
  // Resolve a RELATIVE `module` against the graph/skill dir recorded at init (Mode B
  // ships its fn modules alongside graph.json); fall back to the run's cwd for legacy /
  // planted states with no graphDir. An ABSOLUTE module is used verbatim.
  const base = state.graphDir || state.cwd || process.cwd();
  const modulePath = isAbsolute(task.module) ? task.module : resolvePath(base, task.module);
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    die(`exec-node cannot import module "${task.module}" (resolved ${modulePath}): ${err.message}`);
  }
  const fn = mod[task["export"]];
  if (typeof fn !== "function") {
    die(`exec-node: module "${task.module}" has no exported function "${task["export"]}"`);
  }

  // Run the body deterministically: neutralize the two common nondeterminism
  // sources while it runs, then restore them no matter how the body returns.
  const realNow = Date.now;
  const realRandom = Math.random;
  let value;
  try {
    Date.now = () => 0;
    Math.random = () => 0;
    value = await fn(inputs);
  } catch (err) {
    Date.now = realNow;
    Math.random = realRandom;
    die(`exec-node: fn "${opts.node}" (${task.module}#${task["export"]}) threw: ${err.message}`);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }

  // Validate against output_schema BEFORE writing, so the store never holds a value
  // that contradicts the node's declared shape (V5: a violation is rejected non-zero).
  const errs = [];
  validateValueAgainstSchema(value, task.output_schema, `exec-node output for node "${opts.node}"`, errs);
  if (errs.length) die(`exec-node output rejected (violates output_schema):\n  - ${errs.join("\n  - ")}`);

  // Record the value BY REFERENCE and print ONLY the handle. No engine-state write.
  const handle = storeValue(state.runId, value);
  process.stdout.write(`${handle}\n`);
}

// ---------------------------------------------------------------------------
// expand (fan-out) combinator
// ---------------------------------------------------------------------------

// Fan out an `expand` node over its upstream's list output, in ONE commit (V6/V3).
//
// expand --id <GRAPH_ID> --node <expand-node-id>
//   1. reads the expand node (over, template, gather, deps);
//   2. reads the `over` upstream node's output (a LIST) BY REFERENCE from the value
//      store — the upstream must be DONE with an outputRef (exactly what flatNodeReady
//      requires before offering the expand node as ready);
//   3. for each element i, materializes element[i] as its OWN content-addressed store
//      entry (storeValue) — the BY-REFERENCE per-element binding — so dispatch carries
//      handles only, never the bytes;
//   4. inside a SINGLE commit: creates one child task from `template` (fresh id
//      `<expand-id>-item-<i>`, reusing explode so an implement child also gets its
//      impl/resolve subnodes), records the element handle on the child (inputRef),
//      tags the child generatedBy the expand node (so a later re-expand can tear it
//      down via tearDownGenerated), wires `gather` to DEPEND ON each child (a fresh
//      FORWARD edge), and settles the expand node (status done + doneHash = its
//      expansion hash, matching every other settled combinator).
//
// An empty list creates zero children; the expand node still settles, so `gather`
// (which now gains no new deps) proceeds. The whole fan-out is one commit, so the
// graph is never half-wired; commit re-validates the projected graph (validateGraph
// -> findCycle), so the only edges the expansion adds — fresh forward edges to
// `gather` — keep the graph ACYCLIC, or the entire commit is rejected atomically.
function cmdExpand(opts) {
  if (!opts.id || opts.id === true) die("expand requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("expand requires --node <expand-node-id>");
  const state = loadState(opts.id);
  const node = state.tasks[opts.node];
  if (!node) die(`unknown node "${opts.node}"`);
  if (node.type !== TYPE_EXPAND) {
    die(`expand runs an "expand" node; node "${opts.node}" is type "${node.type ?? TYPE_IMPLEMENT}"`);
  }
  // The upstream `over` node must be DONE with an output (the list to fan out over) —
  // the same readiness flatNodeReady enforces before offering this node as ready.
  const overId = node.over;
  const up = state.tasks[overId];
  if (!up || up.status !== "done" || up.outputRef === undefined) {
    die(`expand "${opts.node}": upstream "${overId}" has no output yet (must be done with an outputRef)`);
  }
  const list = loadValue(state.runId, up.outputRef);
  if (!Array.isArray(list)) {
    die(`expand "${opts.node}": upstream "${overId}" output is not a list (got ${list === null ? "null" : typeof list})`);
  }
  if (!node.gather || !state.tasks[node.gather]) {
    die(`expand "${opts.node}": gather node "${node.gather}" does not exist`);
  }
  // Validate the template as a node BODY up front (it is stored as an opaque identity
  // field, so its type was never checked as a buildable node) for a clean error before
  // any commit; the projected child is still fully re-validated by commit below.
  const template = node.template;
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    die(`expand "${opts.node}": template must be an object describing a child node`);
  }
  const childType = template.type || TYPE_IMPLEMENT;
  if (!NODE_TYPES[childType]) {
    die(`expand "${opts.node}": template.type "${childType}" is unknown (one of: ${Object.keys(NODE_TYPES).join(", ")})`);
  }

  // Materialize each element as its OWN content-addressed store entry BEFORE the
  // commit. storeValue is a pure, idempotent write to the value store (it never
  // touches engine state), so the commit body only ever wires HANDLES, never bytes —
  // the by-reference, handles-only dispatch contract.
  const children = list.map((element, i) => ({
    childId: `${opts.node}-item-${i}`,
    handle: storeValue(state.runId, element),
  }));

  commit(state, (working) => {
    const expand = working.tasks[opts.node];
    // Re-expand safe / idempotent: drop anything a prior expansion of this node
    // generated (transitively) before creating the fresh round (the V19 teardown
    // helper). On the normal first expansion this is a no-op.
    tearDownGenerated(working, opts.node);
    for (const { childId, handle } of children) {
      if (working.tasks[childId]) {
        die(`expand "${opts.node}": generated child id "${childId}" already exists`);
      }
      // Build the child from the template with a fresh id. The child's only input is
      // its element (carried BY REFERENCE on inputRef), so it has no data dependency
      // on the expand subtree; explode turns it into a task record (+ impl/resolve
      // subnodes for an implement child). template.deps, if any, are preserved.
      const childNode = {
        ...template,
        id: childId,
        deps: Array.isArray(template.deps) ? [...template.deps] : [],
      };
      explode(working, { nodes: [childNode] });
      const child = working.tasks[childId];
      child.generatedBy = opts.node; // provenance for the V19 re-expand teardown
      child.inputRef = handle;       // the element, BY REFERENCE (a handle, not bytes)
      // Wire gather to DEPEND ON this child: a fresh FORWARD edge (gather -> child).
      const gather = working.tasks[expand.gather];
      gather.deps = gather.deps || [];
      if (!gather.deps.includes(childId)) gather.deps.push(childId);
    }
    // Settle the expand node: mark it done and stamp the contentHash it expanded at,
    // so readySet stops re-offering it and invalidateStale can later detect a drift
    // and tear down + re-expand it, exactly as for any settled combinator. The
    // expand node's own spec/deps are untouched here, so the end-of-commit recompute
    // reproduces this same contentHash (matching settleRound's done path).
    expand.status = "done";
    expand.doneHash = expand.contentHash;
  });
  emitReady(state);
}

// ---------------------------------------------------------------------------
// shared case-instantiation helpers (switch + loop)
// ---------------------------------------------------------------------------

// Build ONE case body as a fresh task on the working copy: copy the case template,
// stamp a fresh id and its deps, reuse `explode` (so an implement body still gets its
// impl/resolve subnodes), tag it generatedBy its parent combinator (provenance for the
// V19 teardown), and bind it to a value BY REFERENCE (a store handle, never bytes).
// This is the single instantiation primitive the `switch` combinator and the budgeted
// `loop` unroll share, so both grow the graph identically (only the id/deps/bound
// handle differ). Returns the created task record.
function instantiateCaseBranch(working, { parentId, body, branchId, boundHandle, deps }) {
  if (working.tasks[branchId]) {
    die(`combinator "${parentId}": generated branch id "${branchId}" already exists`);
  }
  const branchNode = {
    ...body,
    id: branchId,
    deps: Array.isArray(deps) ? [...deps] : (Array.isArray(body.deps) ? [...body.deps] : []),
  };
  explode(working, { nodes: [branchNode] });
  const branch = working.tasks[branchId];
  branch.generatedBy = parentId; // provenance for the V19 re-fire/re-run teardown
  if (boundHandle !== undefined) branch.inputRef = boundHandle; // bound BY REFERENCE
  return branch;
}

// Wire every node that DEPENDS ON `fromId` to ALSO depend on `branchId` (a fresh
// FORWARD edge), so downstream wiring is stable regardless of which case fired — a
// consumer always lists the combinator id and the engine routes it onto the actual
// branch. With no such consumer the branch is itself the terminal exit (no edge added).
function wireConsumersToBranch(working, fromId, branchId) {
  for (const [tid, t] of Object.entries(working.tasks)) {
    if (tid === branchId) continue;
    if (Array.isArray(t.deps) && t.deps.includes(fromId) && !t.deps.includes(branchId)) {
      t.deps.push(branchId);
    }
  }
}

// ---------------------------------------------------------------------------
// switch (branch) combinator
// ---------------------------------------------------------------------------

// Branch a `switch` node onto the single matching case, in ONE commit (V7/V3).
//
// switch --id <GRAPH_ID> --node <switch-node-id>
//   1. reads the switch node (over, cases, deps);
//   2. reads the `over` SELECTOR node's output (an enumerable VALUE) BY REFERENCE
//      from the value store — the selector must be DONE with an outputRef (exactly
//      what flatNodeReady requires before offering the switch node as ready);
//   3. matches the selector value to a case KEY by its STRINGIFIED form (boolean ->
//      "true"/"false"; enum -> the value as a string), the same domain validateGraph
//      built from the selector's output_schema. Exhaustiveness is enforced statically
//      at init (the registry-and-validation task) AND the recorded value was validated
//      against that output_schema, so a matching key always exists; a miss is still a
//      hard error (never a silent no-op);
//   4. inside a SINGLE commit: instantiates ONLY the matching case's branch (a fresh
//      id `<switch-id>-case-<key>`, dots in the key sanitized away, reusing explode so
//      an implement branch also gets its impl/resolve subnodes), binds it to the
//      selector value BY REFERENCE (inputRef), tags it generatedBy the switch (so a
//      later re-fire can tear it down via tearDownGenerated), wires the switch's stable
//      exit/merge — every node that DEPENDS ON the switch is wired to ALSO depend on
//      the instantiated branch (a fresh FORWARD edge), so downstream wiring is stable
//      regardless of which case fired; with no such consumer the branch is itself the
//      terminal exit — and settles the switch (status done + doneHash = its selection
//      hash, matching every other settled combinator).
//
// The non-matching cases are NEVER created. The whole branch is one commit, so the
// graph is never half-wired; commit re-validates the projected graph (validateGraph
// -> findCycle), so the only edges added — fresh forward edges to the branch — keep
// the graph ACYCLIC, or the entire commit is rejected atomically. Re-firing is
// idempotent: tearDownGenerated drops any prior branch (and its generated
// descendants) first, so a re-run reproduces ONE clean acyclic shape.
function cmdSwitch(opts) {
  if (!opts.id || opts.id === true) die("switch requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("switch requires --node <switch-node-id>");
  const state = loadState(opts.id);
  const node = state.tasks[opts.node];
  if (!node) die(`unknown node "${opts.node}"`);
  if (node.type !== TYPE_SWITCH) {
    die(`switch runs a "switch" node; node "${opts.node}" is type "${node.type ?? TYPE_IMPLEMENT}"`);
  }
  // The selector `over` node must be DONE with an output (the value to branch on) —
  // the same readiness flatNodeReady enforces before offering this node as ready.
  const overId = node.over;
  const up = state.tasks[overId];
  if (!up || up.status !== "done" || up.outputRef === undefined) {
    die(`switch "${opts.node}": selector "${overId}" has no output yet (must be done with an outputRef)`);
  }
  const selector = loadValue(state.runId, up.outputRef);
  const cases = node.cases;
  if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
    die(`switch "${opts.node}": cases must be an object`);
  }
  // The case KEY is the STRINGIFIED selector value: boolean -> "true"/"false";
  // enum (string/integer) -> the value as a string. This matches the domain
  // validateGraph built from the selector's output_schema (boolean -> {"true",
  // "false"}; enum -> enum.map(String)), so exhaustiveness guarantees a match.
  const key = String(selector);
  if (!Object.prototype.hasOwnProperty.call(cases, key)) {
    die(`switch "${opts.node}": selector value ${JSON.stringify(selector)} (key "${key}") has no matching case (have: ${Object.keys(cases).join(", ")})`);
  }
  // Validate the matching case body as a node BODY up front (it is stored as an opaque
  // identity field, so its type was never checked as a buildable node) for a clean
  // error before any commit; the projected branch is still fully re-validated by commit.
  const body = cases[key];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    die(`switch "${opts.node}": case "${key}" must be an object describing a branch node`);
  }
  const branchType = body.type || TYPE_IMPLEMENT;
  if (!NODE_TYPES[branchType]) {
    die(`switch "${opts.node}": case "${key}".type "${branchType}" is unknown (one of: ${Object.keys(NODE_TYPES).join(", ")})`);
  }
  // The branch id: a fresh, DOT-FREE id derived from the switch id and the case key.
  // Sanitize any character outside the id grammar (e.g. a dotted enum value) to "_"
  // so the generated id always matches ID_RE; only one branch is created per fire, so
  // sanitization can never collide two live branches.
  const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_");
  const branchId = `${opts.node}-case-${safeKey}`;
  // Materialize the selector value as its OWN content-addressed store entry BEFORE the
  // commit. storeValue is a pure, idempotent write to the value store (it never touches
  // engine state), so the commit body only ever wires a HANDLE, never bytes — the
  // by-reference binding, mirroring expand's per-element materialization.
  const handle = storeValue(state.runId, selector);

  commit(state, (working) => {
    const sw = working.tasks[opts.node];
    // Re-fire safe / idempotent: drop anything a prior selection of this switch
    // generated (transitively) before creating the fresh branch (the V19 teardown
    // helper). On the normal first selection this is a no-op. tearDownGenerated also
    // strips a now-dangling dep a consumer held on a removed prior branch, so the
    // re-wire below re-points each consumer at the NEW branch cleanly.
    tearDownGenerated(working, opts.node);
    // Build the branch from the matching case body with a fresh id, bound to the
    // selector value BY REFERENCE (the non-matching cases are never instantiated), then
    // wire the stable exit/merge — both via the shared case-instantiation helpers the
    // budgeted `loop` unroll also uses.
    instantiateCaseBranch(working, { parentId: opts.node, body, branchId, boundHandle: handle });
    wireConsumersToBranch(working, opts.node, branchId);
    // Settle the switch node: mark it done and stamp the contentHash it selected at, so
    // readySet stops re-offering it and invalidateStale can later detect a drift and
    // tear down + re-fire it, exactly as for any settled combinator. The switch node's
    // own spec/deps are untouched here, so the end-of-commit recompute reproduces this
    // same contentHash (matching settleRound's done path and cmdExpand).
    sw.status = "done";
    sw.doneHash = sw.contentHash;
  });
  emitReady(state);
}

// ---------------------------------------------------------------------------
// loop (budgeted forward unroll, built ON the switch combinator)
// ---------------------------------------------------------------------------

// Realize a LOOP as a budgeted FORWARD UNROLL on the existing `switch` combinator —
// NO new primitive and NO back-edge (a DAG cannot hold a cycle). The loop's tail is a
// `switch` node whose two cases are the loop's routes: `continue` (the next iteration
// body) and `stop` (the exit). One loop STEP spawns a single FRESH FORWARD node:
//
//   loop --id <GRAPH_ID> --node <loop-switch-id> --state <handle>
//     1. require the node to be a `switch` declaring a "continue" and a "stop" case,
//        and its `over` selector DONE with output (the same readiness `switch`
//        enforces) — the selector carries an optional STOP CONDITION;
//     2. load the carried loop STATE {budget, accumulator} from --state (the seed for
//        iteration 0, or the prior step's threaded next-state). GUARD (the termination
//        invariant): `budget` MUST be a NON-NEGATIVE INTEGER;
//     3. ROUTE: continue iff the stop condition does NOT hold AND budget > 0; else stop.
//        The budget>0 guard FORCES "stop" once the budget bottoms out, so the unroll
//        PROVABLY TERMINATES regardless of the selector — at most `budget` iterations;
//     4. in ONE commit, reusing the shared case-instantiation helper (the switch's tail
//        machinery):
//        - continue: instantiate cases.continue as a FRESH forward iteration node
//          `<loop-id>-iter-<k>` (k = the next iteration index), depending on the PRIOR
//          iteration (a fresh FORWARD edge, NEVER a back-edge to a prior iteration),
//          bound BY REFERENCE to the state it processes (--state), tagged generatedBy
//          the loop node. The next state is THREADED forward — budget STRICTLY
//          decremented (budget-1) and the accumulator FOLDED (accumulator+budget) — and
//          its handle is printed so the next step carries it. Prior iterations are NOT
//          torn down (each persists; the unroll is the chain of fresh nodes);
//        - stop: instantiate cases.stop as `<loop-id>-exit` bound to the FINAL state,
//          wiring every consumer of the loop node onto the exit (the stable exit/merge),
//          and SETTLE the loop node (done + doneHash) so invalidateStale can later
//          detect an upstream drift and tear down + bounded re-run — REUSING GEN_CAP and
//          tearDownGenerated exactly as for any settled combinator (the iteration nodes
//          carry generatedBy=<loop-id>, so a re-run drops them and re-unrolls, with a
//          terminally-failed iteration bounded by the GEN_CAP ceiling like any node).
//
// Like exec-node, it prints ONLY a handle (the threaded next-state for a continue, the
// final state for a stop), so no value ever crosses back through the orchestrator.
function cmdLoop(opts) {
  if (!opts.id || opts.id === true) die("loop requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("loop requires --node <loop-switch-id>");
  if (!opts.state || opts.state === true) die("loop requires --state <handle> (the carried {budget, accumulator})");
  const state = loadState(opts.id);
  const node = state.tasks[opts.node];
  if (!node) die(`unknown node "${opts.node}"`);
  if (node.type !== TYPE_SWITCH) {
    die(`loop runs on a "switch" node (the loop's tail); node "${opts.node}" is type "${node.type ?? TYPE_IMPLEMENT}"`);
  }
  const cases = node.cases;
  if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
    die(`loop "${opts.node}": cases must be an object`);
  }
  if (!cases.continue || !cases.stop) {
    die(`loop "${opts.node}": a loop switch must declare a "continue" case (the next iteration body) and a "stop" case (the exit)`);
  }
  // The selector `over` must be DONE with output (the same readiness `switch` enforces),
  // so the loop can read its STOP CONDITION alongside the budget guard.
  const overId = node.over;
  const up = state.tasks[overId];
  if (!up || up.status !== "done" || up.outputRef === undefined) {
    die(`loop "${opts.node}": selector "${overId}" has no output yet (must be done with an outputRef)`);
  }
  const selector = String(loadValue(state.runId, up.outputRef));

  // Carried loop STATE {budget, accumulator}. GUARD (termination invariant): the budget
  // MUST be a NON-NEGATIVE INTEGER; the accumulator defaults to 0 and is folded forward.
  const carried = loadValue(state.runId, opts.state);
  if (!carried || typeof carried !== "object" || Array.isArray(carried)) {
    die(`loop "${opts.node}": --state must reference an object {budget, accumulator}`);
  }
  const budget = carried.budget;
  if (!Number.isInteger(budget) || budget < 0) {
    die(`loop "${opts.node}": carried budget must be a non-negative integer (got ${JSON.stringify(budget)})`);
  }
  const accumulator = Number.isInteger(carried.accumulator) ? carried.accumulator : 0;

  // ROUTE: continue iff the stop condition does NOT hold AND the budget is not yet
  // exhausted. The budget>0 guard FORCES "stop" once the budget bottoms out — the
  // unroll terminates after at most `budget` iterations, NEVER forming a cycle.
  const doContinue = selector !== "stop" && budget > 0;

  // The next iteration index + the prior iteration node (the fresh FORWARD edge target).
  const iterPrefix = `${opts.node}-iter-`;
  const k = Object.keys(state.tasks).filter((tid) => tid.startsWith(iterPrefix)).length;
  const prevIterId = k > 0 ? `${iterPrefix}${k - 1}` : null;
  const deps = prevIterId ? [prevIterId] : [];

  let resultHandle;
  if (doContinue) {
    // Thread the loop state forward: budget STRICTLY decremented, accumulator FOLDED.
    const nextState = { budget: budget - 1, accumulator: accumulator + budget };
    resultHandle = storeValue(state.runId, nextState);
    const branchId = `${iterPrefix}${k}`;
    commit(state, (working) => {
      // Forward progress: do NOT tear down prior iterations (each persists; the unroll
      // IS the chain of fresh nodes). The iteration is bound BY REFERENCE to the state
      // it processes; its only edge is a fresh FORWARD one to the prior iteration.
      instantiateCaseBranch(working, {
        parentId: opts.node, body: cases.continue, branchId, boundHandle: opts.state, deps,
      });
    });
  } else {
    // STOP: instantiate the exit bound to the FINAL state, wire every consumer of the
    // loop node onto it (the stable exit/merge), and settle the loop node so a later
    // upstream drift tears it down + re-unrolls under the GEN_CAP bound.
    resultHandle = storeValue(state.runId, { budget, accumulator });
    const exitId = `${opts.node}-exit`;
    commit(state, (working) => {
      if (!working.tasks[exitId]) {
        instantiateCaseBranch(working, {
          parentId: opts.node, body: cases.stop, branchId: exitId, boundHandle: opts.state, deps,
        });
        wireConsumersToBranch(working, opts.node, exitId);
      }
      const sw = working.tasks[opts.node];
      sw.status = "done";
      sw.doneHash = sw.contentHash;
    });
  }
  process.stdout.write(`${resultHandle}\n`);
}

// Block until any of the given resources frees, polling `holds` on an escalating
// cadence (no deadline) and emitting heartbeats meanwhile — the Monitor command
// execute-plan arms when it would otherwise idle on a busy (possibly external) lock.
function cmdWaitForFree(opts) {
  const raw = typeof opts.resource === "string" ? opts.resource : null;
  if (!raw) die("wait-for-free requires --resource <name[,name...]>");
  const resources = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!resources.length) die("wait-for-free requires at least one resource");
  for (const r of resources) if (!RESOURCE_RE.test(r)) die(`invalid resource "${r}"`);
  const step = Math.max(1, Number(opts.interval ?? 5)) * 1000;
  const MAX = 60 * 1000;
  let cadence = step;
  const freeNow = () => resources.filter((r) => {
    const meta = readLockMeta(lockPath(r));
    return !meta || !pidAlive(meta.pid); // FREE (no holder) or STALE (dead holder)
  });
  const tick = () => {
    const freed = freeNow();
    if (freed.length) { process.stdout.write(`RELEASED ${freed.join(",")}\n`); process.exit(0); }
    const held = resources.map((r) => {
      const m = readLockMeta(lockPath(r));
      return `${r}(${m && m.owner ? m.owner : "?"})`;
    }).join(" ");
    process.stdout.write(`[hb] waiting on ${held}\n`);
    cadence = Math.min(MAX, cadence + step);
    setTimeout(tick, cadence);
  };
  tick();
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function taskVerdict(state, taskId) {
  const s = state.tasks[taskId].status;
  if (s === "done") return "PASS";
  if (s === "failed") return "FAILED";
  return "INCOMPLETE";
}

function cmdReport(opts) {
  const state = loadState(opts.id);
  const rows = Object.keys(state.tasks).map((taskId) => {
    const t = state.tasks[taskId];
    return {
      task: taskId,
      // Engine-driven kinds (fn/expand/switch) carry no `name` in their template;
      // fall back to the id so the table stays consistent across all node kinds.
      name: t.name ?? taskId,
      verdict: taskVerdict(state, taskId),
      attempts: t.attempts || 0,
      reason: t.lastReason || "",
    };
  });
  process.stdout.write("## Audit Table\n\n");
  process.stdout.write("| Task | Name | Verdict | Retries | Last reason |\n");
  process.stdout.write("|------|------|---------|----------|-------------|\n");
  for (const r of rows) {
    process.stdout.write(`| ${r.task} | ${r.name} | ${r.verdict} | ${r.attempts} | ${r.reason} |\n`);
  }
  const failed = rows.filter((r) => r.verdict === "FAILED").length;
  const incomplete = rows.filter((r) => r.verdict === "INCOMPLETE").length;
  process.stdout.write(`\n${rows.length} task(s): ${rows.length - failed - incomplete} passed, ${failed} failed, ${incomplete} incomplete.\n`);
}

function cmdStatus(opts) {
  const state = loadState(opts.id);
  process.stdout.write("| Subnode | Task | Role | Status | Focus | Executor |\n");
  process.stdout.write("|---------|------|------|--------|-------|----------|\n");
  for (const [id, sub] of Object.entries(state.subnodes)) {
    process.stdout.write(`| ${id} | ${sub.task} | ${sub.role} | ${sub.status} | ${sub.focus || ""} | ${sub.executor} |\n`);
  }
}

// Global: scan stateDir for graph state files and report the ones still active
// (>=1 INCOMPLETE task, using the SAME verdict as `report`), with per-graph
// ready/running counts, optionally filtered to the id/cwd/session stamped at
// init. Lets a hook detect an active execute-plan run and whether ready work is
// actually dispatchable now or waiting behind a held exclusive resource.
function cmdActive(opts) {
  const dir = stateDir();
  const filterId = typeof opts.id === "string" ? opts.id : null;
  const filterCwd = typeof opts.cwd === "string" ? opts.cwd : null;
  const filterSession = typeof opts.session === "string" ? opts.session : null;
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    files = []; // no stateDir yet -> nothing active
  }
  const out = [];
  for (const file of files) {
    let state;
    try {
      state = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue; // skip malformed/unreadable state files
    }
    if (!state || typeof state !== "object" || !state.tasks || !state.subnodes) continue;
    const graphId = state.runId ?? state.graphId ?? file.replace(/\.json$/, "");
    if (filterId !== null && graphId !== filterId) continue;
    // A graph without a stored cwd cannot match a --cwd filter (treat as non-matching).
    if (filterCwd !== null && state.cwd !== filterCwd) continue;
    // Same for --session: scope to the chat window that owns the run. A graph
    // with no stored session (legacy/non-Claude-Code) cannot match a session
    // filter, so it is excluded — the hook never blocks on it (safe by default).
    if (filterSession !== null && state.session !== filterSession) continue;
    const incomplete = Object.keys(state.tasks)
      .filter((taskId) => taskVerdict(state, taskId) === "INCOMPLETE").length;
    if (incomplete < 1) continue; // not active
    const ready = readyDispatchability(state);
    const running = Object.values(state.subnodes)
      .filter((s) => s.status === "running").length;
    // Wire-stable: emit `graphId` key (loop-resume.mjs:36,38 reads g.graphId).
    // Internally state stores `runId`; fall back to `graphId` for legacy state
    // files written before this rename (same sha256 value, different key name).
    out.push({ graphId, incomplete, ...ready, running });
  }
  out.sort((a, b) => (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : 0));
  if (opts.json) {
    process.stdout.write(JSON.stringify(out) + "\n");
    return;
  }
  for (const g of out) {
    process.stdout.write(`${g.graphId} incomplete=${g.incomplete} ready=${g.ready} running=${g.running}\n`);
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function main() {
  const { verb, opts } = parseArgs(process.argv.slice(2));
  switch (verb) {
    case "init": return cmdInit(opts);
    case "ready": return cmdReady(opts);
    case "dispatch": return cmdDispatch(opts);
    case "active": return cmdActive(opts);
    case "complete": return cmdComplete(opts);
    case "resolve": return cmdResolve(opts);
    case "fail": return cmdFail(opts);
    case "spawn-task": return cmdSpawnTask(opts);
    case "remove-task": return cmdRemoveTask(opts);
    case "add-dep": return cmdAddDep(opts);
    case "remove-dep": return cmdRemoveDep(opts);
    case "hold": return cmdHold(opts);
    case "release": return cmdRelease(opts);
    case "holds": return cmdHolds(opts);
    case "wait-for-free": return cmdWaitForFree(opts);
    case "resource-of": return cmdResourceOf(opts);
    case "variables": return cmdVariables(opts);
    case "resolve-context": return cmdResolveContext(opts);
    case "exec-node": return cmdExecNode(opts);
    case "expand": return cmdExpand(opts);
    case "switch": return cmdSwitch(opts);
    case "loop": return cmdLoop(opts);
    case "report": return cmdReport(opts);
    case "status": return cmdStatus(opts);
    default:
      die(`unknown verb "${verb || ""}". Use: init | ready | dispatch | active | complete | resolve | fail | hold | release | holds | wait-for-free | resource-of | variables | resolve-context | exec-node | expand | switch | loop | report | status`);
  }
}

// exec-node is async (it awaits a dynamic import + the fn body); every other verb is
// synchronous and returns undefined. Surface a late rejection as a non-zero exit so
// an unexpected async failure can never pass silently.
const result = main();
if (result && typeof result.then === "function") {
  result.catch((err) => die(`exec-node failed: ${err && err.message ? err.message : err}`));
}
