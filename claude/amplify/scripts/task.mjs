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
//   ready    --id <GRAPH_ID>                            -> prints ready subnodes
//   dispatch --id <GRAPH_ID> --node <subnode-id>        -> marks a pending subnode running
//   active   [--cwd <dir>] [--session <id>] [--json]    -> lists still-active graphs (global);
//                                                          --cwd/--session scope to a project/chat window
//   complete --id <GRAPH_ID> --node <subnode-id>        -> prints newly-ready subnodes
//   resolve  --id <GRAPH_ID> --node <T>.resolve --panel <json>
//                                                       -> registers auditors, prints ready
//   fail     --id <GRAPH_ID> --node <T>.audit.<i> [--reason <text>]
//   hold     --resource <name> --owner <id> [--ttl <ms>] -> kernel-flock holder; prints HELD then
//                                                           blocks holding the lock | BUSY (exit 9)
//   release  --resource <name> [--owner <id>]            -> kill the holder, freeing the flock
//   holds    --resource <name>                           -> HELD <owner> | STALE | FREE
//   wait-free --resource <name[,name…]> [--interval <s>] -> block until any frees (prints RELEASED)
//   resource-of --executor <subagent(...)>               -> prints the exclusive resource class, if any
//   variables --id <GRAPH_ID>                        -> prints each injected variable as "<name>\t<value>"
//   resolve-context --id <GRAPH_ID> --node <task-id> -> dumps the audit-resolver's context for one task
//   report   --id <GRAPH_ID>                            -> final task table
//   status   --id <GRAPH_ID>                            -> full subnode state table
//
// Task-level graph-mutation commands (CAPABILITY ONLY — no automatic caller):
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
import { join } from "node:path";

const IMPL = "impl";
const RESOLVE = "resolve";
const AUDIT = "audit";
const SEP = ".";
const DEFAULT_IMPL_EXECUTOR = "subagent(general-purpose)";
const RESOLVER_EXECUTOR = "subagent(amplify:audit-resolver)";
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

// External-agent drivers run as their own process with their own git behavior,
// which is not synchronized with this repository's state and cannot be bounded.
// They are therefore audit-only and MUST NOT be an implementer (an implementer
// writes the working tree). This set is the single source of truth for that
// restriction; it gates the impl slot only -- the audit panel (cmdResolve) still
// accepts these executors as read-only auditors.
const EXTERNAL_IMPL = {
  "subagent(amplify:codex-driver)": true,
  "subagent(amplify:kimi-driver)": true,
};
function isExternalImpl(executor) { return Boolean(EXTERNAL_IMPL[executor]); }

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
// per-task Merkle content hash
// ---------------------------------------------------------------------------

// spec(t) = the STABLE identity inputs of a task: the fields that, when changed,
// SHOULD change the task's identity (and therefore force a re-run). It reads the
// RESOLVED implementer executor (subnodes[<id>.impl].executor, post-default), so
// an omitted impl and an explicit subagent(general-purpose) produce one identity.
// acceptance_criteria order is content-significant; canonicalize preserves array
// order (it sorts object keys only), which is what we want here.
function spec(task, subnodes, taskId) {
  return {
    name: task.name,
    acceptance_criteria: task.acceptance_criteria,
    design_aspect: task.design_aspect,
    max_attempts: task.max_attempts,
    human_gate: task.human_gate === true,
    executor: subnodes[implId(taskId)]?.executor ?? DEFAULT_IMPL_EXECUTOR,
  };
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

// Reset a task's subnodes to the fresh pre-impl shape: impl/resolve back to
// pending and every .audit.<i> dropped. Deleting an audit subnode is NOT a
// running -> pending transition (it is a deletion), so it is allowed even mid-
// flight; the in-flight auditor's late return is tolerated as a no-op discard by
// the completion verbs (see settleSubnodeOrDiscard). Used by both the done-task
// reset and the atomic-round invalidation so they reset identically.
function resetTaskSubnodes(working, taskId) {
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
// resets work that the latest commit rendered stale, comparing each task's stored
// provenance hash (doneHash for a completed task; the impl subnode's dispatchHash
// for an in-progress audit round) against the freshly recomputed contentHash.
//
// It must NOT violate commit's running -> pending invariant: a `done` task with a
// running subnode is left alone (none normally remains once done, but we guard);
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
    // (V-SI.1 / V-SI.3) DONE or FAILED with a drifted result: doneHash records the
    // contentHash at which the task last settled. If it no longer matches, the
    // task's inputs (its own spec or any upstream's) changed, so the stored result
    // is stale. Reuse is automatic for an unchanged task (doneHash === contentHash
    // leaves it untouched). A running subnode means real in-flight work — skip the
    // reset and let the mvcc discard re-ready it at completion.
    const drifted = task.doneHash !== undefined && task.doneHash !== task.contentHash;
    if (!drifted) continue;
    if (taskHasRunningSubnode(working, id)) continue;
    if (task.status === "done") {
      // (V-SI.1) reset and redispatch; attempts cleared (a fresh, unrelated run).
      resetTaskSubnodes(working, id);
      task.status = "pending";
      task.attempts = 0;
      task.lastReason = null;
      delete task.doneHash;
    } else if (task.status === "failed") {
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
    }
  }
}

// ---------------------------------------------------------------------------
// validation (enforces schemas/task-graph.schema.json + referential integrity)
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]+$/;
const EXECUTOR_RE = /^subagent\((general-purpose|explore|plan|amplify:codex-driver|amplify:kimi-driver|amplify:browser-use-chrome-devtools|amplify:browser-use-playwright|amplify:computer-use|amplify:computer-use-cua|amplify:audit-resolver)\)$/;
const ALLOWED_TASK_KEYS = new Set(["id", "name", "deps", "acceptance_criteria", "design_aspect", "impl", "max_attempts", "human_gate"]);

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
    if (typeof node.name !== "string" || !node.name) errors.push(`${where}.name must be a non-empty string`);
    if (!Array.isArray(node.deps)) errors.push(`${where}.deps must be an array`);
    if (!Array.isArray(node.acceptance_criteria) || node.acceptance_criteria.length < 1) {
      errors.push(`${where}.acceptance_criteria must be a non-empty array`);
    }
    if (typeof node.design_aspect !== "string" || !node.design_aspect) {
      errors.push(`${where}.design_aspect must be a non-empty string`);
    }
    if ("impl" in node) {
      if (!node.impl || typeof node.impl !== "object" || Array.isArray(node.impl)) {
        errors.push(`${where}.impl must be an object`);
      } else if ("executor" in node.impl) {
        const ex = node.impl.executor;
        if (typeof ex !== "string" || !EXECUTOR_RE.test(ex)) {
          errors.push(`${where}.impl.executor must match ${EXECUTOR_RE}`);
        } else if (isExternalImpl(ex)) {
          errors.push(`${where}.impl.executor "${ex}" is an external-agent driver, which is audit-only and cannot be an implementer`);
        }
      }
    }
    if (!Number.isInteger(node.max_attempts) || node.max_attempts < 1) {
      errors.push(`${where}.max_attempts must be an integer >= 1`);
    }
    if ("human_gate" in node && typeof node.human_gate !== "boolean") {
      errors.push(`${where}.human_gate must be a boolean`);
    }
    // additionalProperties: false parity -- reject unknown fields (e.g. a stale `audit`).
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        if (!ALLOWED_TASK_KEYS.has(k)) errors.push(`${where} has unknown field "${k}"`);
      }
    }
  }
  // referential integrity: deps reference existing ids
  for (const node of graph.nodes) {
    if (!Array.isArray(node.deps)) continue;
    for (const dep of node.deps) {
      if (!ids.has(dep)) errors.push(`task "${node.id}" depends on unknown task "${dep}"`);
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

// explode is now a CHANGE applied through commit: it writes the per-task records
// and the impl/resolve subnodes onto the working copy (audits are created later,
// at runtime, by the resolve verb). It does NOT persist or validate on its own;
// commit() does both. The exact records produced here are unchanged from before.
function explode(working, graph) {
  for (const node of graph.nodes) {
    working.tasks[node.id] = {
      name: node.name,
      deps: node.deps || [],
      acceptance_criteria: node.acceptance_criteria,
      design_aspect: node.design_aspect,
      human_gate: node.human_gate === true,
      max_attempts: node.max_attempts,
      status: "pending", // pending -> impl-done -> auditing -> done | failed
      attempts: 0,
      generation: 0, // bumped only by structural invalidation of a failed task
      lastReason: null,
    };
    working.subnodes[implId(node.id)] = {
      task: node.id, role: IMPL, status: "pending",
      executor: node.impl?.executor ?? DEFAULT_IMPL_EXECUTOR,
    };
    working.subnodes[resolveId(node.id)] = {
      task: node.id, role: RESOLVE, status: "pending",
      executor: RESOLVER_EXECUTOR,
    };
  }
}

// ---------------------------------------------------------------------------
// commit: the single validated writer of state.tasks / state.subnodes
// ---------------------------------------------------------------------------

// Reconstruct the folded-graph view {version:1, nodes, variables, plan_file}
// from live state, so the whole-graph validator (validateGraph, the same one
// init uses) can check any candidate the same way. Each node carries the spec
// fields stored on the task record plus the RESOLVED implementer executor read
// from the task's .impl subnode (post-default), and nothing else — so the shape
// matches what a valid folded graph looks like (ALLOWED_TASK_KEYS parity).
function projectFoldedGraph(state) {
  const nodes = Object.entries(state.tasks).map(([id, t]) => ({
    id,
    name: t.name,
    deps: t.deps || [],
    acceptance_criteria: t.acceptance_criteria,
    design_aspect: t.design_aspect,
    human_gate: t.human_gate === true,
    max_attempts: t.max_attempts,
    impl: { executor: state.subnodes[implId(id)]?.executor ?? DEFAULT_IMPL_EXECUTOR },
  }));
  return { version: 1, nodes, variables: state.variables || {}, plan_file: state.plan_file };
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

function readySet(state) {
  const ready = [];
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
  return ready.sort();
}

function emitReady(state) {
  for (const id of readySet(state)) {
    process.stdout.write(`${id}\t${state.subnodes[id].executor}\n`);
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
  const state = { runId, commitSeq: 0, salt: salt || null, cwd: process.cwd(), plan_file: graph.plan_file, variables: graph.variables || {}, tasks: {}, subnodes: {} };
  commit(state, (working) => explode(working, graph)); // single validated writer; persists on success
  const taskCount = Object.keys(state.tasks).length;
  const subCount = Object.keys(state.subnodes).length;
  process.stderr.write(`initialized ${taskCount} tasks -> ${subCount} subnodes (all pending)\n`);
  process.stdout.write(`${runId}\n`);
}

function cmdReady(opts) {
  const state = loadState(opts.id);
  emitReady(state);
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

function cmdComplete(opts) {
  const state = loadState(opts.id);
  const sub = settleSubnodeOrDiscard(state, opts.node);
  if (!sub) { emitReady(state); return; } // subnode deleted mid-flight: no-op discard
  if (sub.role === RESOLVE) {
    die(`use the resolve verb (with --panel) for a .resolve subnode, got "${opts.node}"`);
  }
  commit(state, (working) => {
    if (discardIfStale(working, opts.node)) return; // graph moved; re-ready, do not apply
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
// task-level graph-mutation commands (CAPABILITY ONLY)
//
// SpawnTask / RemoveTask / AddDep / RemoveDep each build a change(working)
// callback and route it through commit, so they inherit the whole-graph
// validation (validateGraph(projectFoldedGraph(...)) — unique ids, dangling-dep
// and cycle checks, executor grammar, required fields) and the content-hash
// invalidation that every other mutating verb already gets. They DO NOT
// re-implement validation: an incomplete/invalid spec, a duplicate id, a dep on a
// non-existent task, or a cycle-creating edge is rejected by commit atomically
// (no partial write, non-zero exit via die). There is NO automatic trigger that
// calls these — they are a manually-invokable capability only.
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

// Dump the audit-resolver's context for one task: its goal (name), design aspect,
// plan file, acceptance criteria, and the run's variables — so execute-plan need
// not inline them into the resolver's spawn prompt.
function cmdResolveContext(opts) {
  if (!opts.id || opts.id === true) die("resolve-context requires --id <GRAPH_ID>");
  if (!opts.node || opts.node === true) die("resolve-context requires --node <task-id>");
  const state = loadState(opts.id);
  const t = state.tasks[opts.node];
  if (!t) die(`unknown task "${opts.node}"`);
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

// Block until any of the given resources frees, polling `holds` on an escalating
// cadence (no deadline) and emitting heartbeats meanwhile — the Monitor command
// execute-plan arms when it would otherwise idle on a busy (possibly external) lock.
function cmdWaitFree(opts) {
  const raw = typeof opts.resource === "string" ? opts.resource : null;
  if (!raw) die("wait-free requires --resource <name[,name...]>");
  const resources = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!resources.length) die("wait-free requires at least one resource");
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
      name: t.name,
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
// ready/running counts, optionally filtered to the cwd stamped at init. Lets a
// hook detect an active execute-plan run (and a true stall: running == 0).
function cmdActive(opts) {
  const dir = stateDir();
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
    // A graph without a stored cwd cannot match a --cwd filter (treat as non-matching).
    if (filterCwd !== null && state.cwd !== filterCwd) continue;
    // Same for --session: scope to the chat window that owns the run. A graph
    // with no stored session (legacy/non-Claude-Code) cannot match a session
    // filter, so it is excluded — the hook never blocks on it (safe by default).
    if (filterSession !== null && state.session !== filterSession) continue;
    const incomplete = Object.keys(state.tasks)
      .filter((taskId) => taskVerdict(state, taskId) === "INCOMPLETE").length;
    if (incomplete < 1) continue; // not active
    const ready = readySet(state).length;
    const running = Object.values(state.subnodes)
      .filter((s) => s.status === "running").length;
    // Wire-stable: emit `graphId` key (loop-resume.mjs:36,38 reads g.graphId).
    // Internally state stores `runId`; fall back to `graphId` for legacy state
    // files written before this rename (same sha256 value, different key name).
    out.push({ graphId: state.runId ?? state.graphId, incomplete, ready, running });
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
    case "wait-free": return cmdWaitFree(opts);
    case "resource-of": return cmdResourceOf(opts);
    case "variables": return cmdVariables(opts);
    case "resolve-context": return cmdResolveContext(opts);
    case "report": return cmdReport(opts);
    case "status": return cmdStatus(opts);
    default:
      die(`unknown verb "${verb || ""}". Use: init | ready | dispatch | active | complete | resolve | fail | spawn-task | remove-task | add-dep | remove-dep | hold | release | holds | wait-free | resource-of | variables | resolve-context | report | status`);
  }
}

main();
