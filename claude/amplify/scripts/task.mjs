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
//   report   --id <GRAPH_ID>                            -> final task table
//   status   --id <GRAPH_ID>                            -> full subnode state table
//
// Subnode/executor lines are tab-separated: "<subnode-id>\t<executor>".
// No external dependencies (Node built-ins only).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
const PERL = process.env.AMPLIFY_PERL || "perl";

// Executors that contend over a host-global resource and MUST be serialized.
// This map is the single source of truth for which executors are exclusive.
const EXCLUSIVE = {
  "subagent(amplify:computer-use)": "computer-use",
  "subagent(amplify:browser-use-chrome-devtools)": "chrome-devtools",
};
function resourceOf(executor) { return EXCLUSIVE[executor] || null; }

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
const EXECUTOR_RE = /^subagent\((general-purpose|explore|plan|amplify:codex-driver|amplify:kimi-driver|amplify:browser-use-chrome-devtools|amplify:browser-use-playwright|amplify:computer-use|amplify:audit-resolver)\)$/;
const ALLOWED_TASK_KEYS = new Set(["id", "name", "deps", "acceptance_criteria", "impl", "max_attempts", "human_gate"]);

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
      status: "pending", // pending -> impl-done -> auditing -> done | failed
      attempts: 0,
      lastReason: null,
    };
    subnodes[implId(node.id)] = {
      task: node.id, role: IMPL, status: "pending",
      executor: node.impl?.executor ?? DEFAULT_IMPL_EXECUTOR,
    };
    subnodes[resolveId(node.id)] = {
      task: node.id, role: RESOLVE, status: "pending",
      executor: RESOLVER_EXECUTOR,
    };
  }
  return { tasks, subnodes };
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

function taskAuditEntries(state, taskId) {
  return Object.entries(state.subnodes).filter(([, s]) => s.task === taskId && s.role === AUDIT);
}

// Decide a task's fate once every auditor in the round has reported.
function settleRound(state, taskId) {
  const entries = taskAuditEntries(state, taskId);
  if (entries.length === 0) return; // no auditors registered yet
  const subs = entries.map(([, s]) => s);
  if (!subs.every((s) => s.status === "done" || s.status === "failed")) return; // round in progress
  const task = state.tasks[taskId];
  const failed = subs.filter((s) => s.status === "failed");
  if (failed.length === 0) {
    task.status = "done"; // every auditor passed on this implementation
    return;
  }
  task.attempts = (task.attempts || 0) + 1;
  task.lastReason = failed.map((s) => s.lastReason).filter(Boolean).join("; ") || null;
  // Drop this round's auditors; the next round re-resolves from the new diff.
  for (const [id] of entries) delete state.subnodes[id];
  if (task.attempts < task.max_attempts) {
    state.subnodes[implId(taskId)].status = "pending";
    state.subnodes[resolveId(taskId)].status = "pending";
    task.status = "pending";
    process.stderr.write(`retry ${task.attempts}/${task.max_attempts} for task "${taskId}"; reopening ${implId(taskId)}\n`);
  } else {
    task.status = "failed"; // logged, non-halting; successors proceed
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
  const graphId = computeGraphId(graph, salt);
  const path = statePath(graphId);
  if (existsSync(path)) {
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
  emitReady(state);
}

function cmdComplete(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
  if (sub.role === RESOLVE) {
    die(`use the resolve verb (with --panel) for a .resolve subnode, got "${opts.node}"`);
  }
  if (sub.role === IMPL) {
    sub.status = "done";
    state.tasks[sub.task].status = "impl-done";
  } else if (sub.role === AUDIT) {
    sub.status = "done";
    settleRound(state, sub.task);
  }
  saveState(state);
  emitReady(state);
}

function cmdResolve(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
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
  sub.status = "done";
  panel.forEach((entry, i) => {
    state.subnodes[auditId(taskId, i)] = {
      task: taskId, role: AUDIT, status: "pending",
      executor: entry.executor, focus: entry.focus, lastReason: null,
    };
  });
  state.tasks[taskId].status = "auditing";
  saveState(state);
  emitReady(state);
}

function cmdFail(opts) {
  const state = loadState(opts.id);
  const sub = requireSubnode(state, opts.node);
  if (sub.role !== AUDIT) die(`fail expects an audit subnode (<id>.audit.<i>), got "${opts.node}"`);
  sub.status = "failed";
  sub.lastReason = typeof opts.reason === "string" ? opts.reason : null;
  settleRound(state, sub.task);
  saveState(state);
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
  process.stdout.write("| Subnode | Task | Role | Status | Focus | Executor |\n");
  process.stdout.write("|---------|------|------|--------|-------|----------|\n");
  for (const [id, sub] of Object.entries(state.subnodes)) {
    process.stdout.write(`| ${id} | ${sub.task} | ${sub.role} | ${sub.status} | ${sub.focus || ""} | ${sub.executor} |\n`);
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
    case "resolve": return cmdResolve(opts);
    case "fail": return cmdFail(opts);
    case "hold": return cmdHold(opts);
    case "release": return cmdRelease(opts);
    case "holds": return cmdHolds(opts);
    case "wait-free": return cmdWaitFree(opts);
    case "resource-of": return cmdResourceOf(opts);
    case "report": return cmdReport(opts);
    case "status": return cmdStatus(opts);
    default:
      die(`unknown verb "${verb || ""}". Use: init | ready | complete | resolve | fail | hold | release | holds | wait-free | resource-of | report | status`);
  }
}

main();
