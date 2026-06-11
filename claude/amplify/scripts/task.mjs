#!/usr/bin/env node
// Amplify task engine (structured concurrency).
//
// Ingests a FOLDED task graph (one node per implement-and-audit task, per
// schemas/task-graph.schema.json), EXPLODES it into <id>.impl and <id>.audit
// subnodes, and tracks subnode state so that execute-plan can schedule work.
//
// State is keyed by a content hash of the folded graph (GRAPH_ID), so distinct
// plans never collide even when they share the same session plan-file path, and
// re-running an identical graph resumes cleanly. State lives in an amplify-owned
// directory, never under Claude Code's relocatable config directory.
//
// Verbs:
//   init     --graph <file> [--salt <text>]      -> prints GRAPH_ID
//   ready    --id <GRAPH_ID>                      -> prints ready subnode ids
//   complete --id <GRAPH_ID> --node <subnode-id>  -> prints newly-ready subnode ids
//   fail     --id <GRAPH_ID> --node <subnode-id> [--reason <text>]
//   report   --id <GRAPH_ID>                      -> final audit table
//   status   --id <GRAPH_ID>                      -> full subnode state table
//
// No external dependencies (Node built-ins only).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const IMPL = "impl";
const AUDIT = "audit";
const SEP = ".";

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
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(state.graphId), JSON.stringify(state, null, 2));
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
// validation (enforces schemas/task-graph.schema.json + referential integrity)
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]+$/;
const EXECUTOR_RE = /^subagent\((general-purpose|explore|plan|amplify:codex-driver|amplify:kimi-driver|amplify:chrome-devtools-driver|amplify:playwright-driver|amplify:computer-use)\)$/;

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
    if (!node.audit || typeof node.audit !== "object" || Array.isArray(node.audit)) {
      errors.push(`${where}.audit must be an object`);
    } else if (typeof node.audit.executor !== "string" || !EXECUTOR_RE.test(node.audit.executor)) {
      errors.push(`${where}.audit.executor must match ${EXECUTOR_RE}`);
    }
    if ("impl" in node) {
      if (!node.impl || typeof node.impl !== "object" || Array.isArray(node.impl)) {
        errors.push(`${where}.impl must be an object`);
      } else if ("executor" in node.impl && (typeof node.impl.executor !== "string" || !EXECUTOR_RE.test(node.impl.executor))) {
        errors.push(`${where}.impl.executor must match ${EXECUTOR_RE}`);
      }
    }
    if (!Number.isInteger(node.max_attempts) || node.max_attempts < 1) {
      errors.push(`${where}.max_attempts must be an integer >= 1`);
    }
    if ("human_gate" in node && typeof node.human_gate !== "boolean") {
      errors.push(`${where}.human_gate must be a boolean`);
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
// explosion: folded tasks -> impl/audit subnodes
// ---------------------------------------------------------------------------

function implId(taskId) { return `${taskId}${SEP}${IMPL}`; }
function auditId(taskId) { return `${taskId}${SEP}${AUDIT}`; }

function explode(graph) {
  const tasks = {};
  const subnodes = {};
  for (const node of graph.nodes) {
    tasks[node.id] = {
      name: node.name,
      deps: node.deps || [],
      acceptance_criteria: node.acceptance_criteria,
      human_gate: node.human_gate === true,
      max_attempts: node.max_attempts,
    };
    // a task's implementer waits on every dependency task's AUDIT subnode
    const implDeps = (node.deps || []).map(auditId);
    subnodes[implId(node.id)] = {
      task: node.id, role: IMPL, deps: implDeps, status: "pending",
      executor: node.impl?.executor ?? "subagent(general-purpose)",
    };
    subnodes[auditId(node.id)] = {
      task: node.id, role: AUDIT, deps: [implId(node.id)], status: "pending",
      attempts: 0, lastReason: null,
      executor: node.audit.executor,
    };
  }
  return { tasks, subnodes };
}

// ---------------------------------------------------------------------------
// scheduling helpers
// ---------------------------------------------------------------------------

// A dependency is satisfied when the upstream subnode is resolved: a passing
// audit ("done") OR a terminally-failed audit ("failed"), so a logged failure
// does not halt the rest of the graph.
function depSatisfied(state, subnodeId) {
  const s = state.subnodes[subnodeId];
  return s && (s.status === "done" || s.status === "failed");
}

function readySet(state) {
  const ready = [];
  for (const [id, sub] of Object.entries(state.subnodes)) {
    if (sub.status !== "pending") continue;
    if (sub.deps.every((d) => depSatisfied(state, d))) ready.push(id);
  }
  return ready.sort();
}

function requireSubnode(state, nodeId) {
  if (!nodeId || typeof nodeId !== "string") die("--node <subnode-id> is required");
  const sub = state.subnodes[nodeId];
  if (!sub) die(`unknown subnode "${nodeId}"`);
  return sub;
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
  const graphId = computeGraphId(graph, salt);
  const path = statePath(graphId);
  if (existsSync(path)) {
    // idempotent resume: keep existing runtime state
    process.stderr.write(`resuming existing state for GRAPH_ID ${graphId}\n`);
    process.stdout.write(`${graphId}\n`);
    return;
  }
  const { tasks, subnodes } = explode(graph);
  const state = { graphId, salt: salt || null, tasks, subnodes };
  saveState(state);
  const taskCount = Object.keys(tasks).length;
  const subCount = Object.keys(subnodes).length;
  process.stderr.write(`initialized ${taskCount} tasks -> ${subCount} subnodes (all pending)\n`);
  process.stdout.write(`${graphId}\n`);
}

function cmdReady(opts) {
  const state = loadState(opts.id);
  for (const id of readySet(state)) process.stdout.write(`${id}\t${state.subnodes[id].executor}\n`);
}

function cmdComplete(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
  sub.status = "done";
  saveState(state);
  for (const id of readySet(state)) process.stdout.write(`${id}\t${state.subnodes[id].executor}\n`);
}

function cmdFail(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
  if (sub.role !== AUDIT) die(`fail expects an audit subnode (<id>.audit), got "${opts.node}"`);
  const task = state.tasks[sub.task];
  const reason = typeof opts.reason === "string" ? opts.reason : null;
  sub.attempts = (sub.attempts || 0) + 1;
  sub.lastReason = reason;
  if (sub.attempts < task.max_attempts) {
    // reopen the implementer for another attempt
    sub.status = "pending";
    state.subnodes[implId(sub.task)].status = "pending";
    saveState(state);
    process.stderr.write(`retry ${sub.attempts}/${task.max_attempts} for task "${sub.task}"; reopening ${implId(sub.task)}\n`);
    for (const id of readySet(state)) process.stdout.write(`${id}\t${state.subnodes[id].executor}\n`);
  } else {
    // exhausted: mark failed (logged, non-halting); successors may proceed
    sub.status = "failed";
    state.subnodes[implId(sub.task)].status = "done";
    saveState(state);
    process.stderr.write(`task "${sub.task}" FAILED after ${sub.attempts} attempt(s); logged, continuing\n`);
    for (const id of readySet(state)) process.stdout.write(`${id}\t${state.subnodes[id].executor}\n`);
  }
}

function taskVerdict(state, taskId) {
  const audit = state.subnodes[auditId(taskId)];
  if (audit.status === "done") return "PASS";
  if (audit.status === "failed") return "FAILED";
  return "INCOMPLETE";
}

function cmdReport(opts) {
  const state = loadState(opts.id);
  const rows = Object.keys(state.tasks).map((taskId) => {
    const audit = state.subnodes[auditId(taskId)];
    return {
      task: taskId,
      name: state.tasks[taskId].name,
      verdict: taskVerdict(state, taskId),
      attempts: audit.attempts || 0,
      reason: audit.lastReason || "",
    };
  });
  process.stdout.write("## Audit Table\n\n");
  process.stdout.write("| Task | Name | Verdict | Attempts | Last reason |\n");
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
  process.stdout.write("| Subnode | Task | Role | Status | Attempts | Deps |\n");
  process.stdout.write("|---------|------|------|--------|----------|------|\n");
  for (const [id, sub] of Object.entries(state.subnodes)) {
    process.stdout.write(`| ${id} | ${sub.task} | ${sub.role} | ${sub.status} | ${sub.attempts ?? ""} | ${sub.deps.join(", ")} |\n`);
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
    case "complete": return cmdComplete(opts);
    case "fail": return cmdFail(opts);
    case "report": return cmdReport(opts);
    case "status": return cmdStatus(opts);
    default:
      die(`unknown verb "${verb || ""}". Use: init | ready | complete | fail | report | status`);
  }
}

main();
