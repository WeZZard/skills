// Black-box tests for the amplify task engine.
//
// Run: node --test claude/amplify/scripts/*.test.mjs
// (a bare directory argument is not portable across Node versions; pass the
//  test file glob explicitly)
//
// Each test spawns the real CLI (node task.mjs <verb>) with its own
// temporary AMPLIFY_STATE_DIR, so nothing is written under the Claude config
// directory or the repo. No external dependency is used.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = fileURLToPath(new URL("./task.mjs", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../schemas/task-graph.schema.json", import.meta.url));

let ROOT;
before(() => { ROOT = mkdtempSync(join(tmpdir(), "amplify-task-test-")); });
after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

let counter = 0;
// Creates an isolated workspace: a private state dir + graph-file directory.
function ws() {
  const dir = join(ROOT, `case-${counter++}`);
  const stateDir = join(dir, "state");
  return { dir, stateDir };
}

function run(stateDir, args) {
  const res = spawnSync("node", [ENGINE, ...args], {
    encoding: "utf8",
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function lines(s) {
  return s.split("\n").map((x) => x.trim()).filter(Boolean);
}

// ready/complete/resolve/fail emit "<subnode-id>\t<executor>" per line; this
// extracts just the id column so id-only assertions stay readable.
function ids(s) {
  return lines(s).map((x) => x.split("\t")[0]);
}

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

// A task no longer declares auditors -- they are resolved at runtime.
function task(id, deps = [], over = {}) {
  return {
    id, name: `Task ${id}`, deps,
    acceptance_criteria: ["does the thing"], design_aspect: "Architecture", max_attempts: 2,
    ...over,
  };
}

function init(stateDir, dir, graph, extra = []) {
  ensureDir(dir); ensureDir(stateDir);
  // `variables` and `plan_file` are required top-level fields; default them for
  // fixtures that don't exercise them.
  const g = { ...graph };
  if (!("variables" in g)) g.variables = {};
  if (!("plan_file" in g)) g.plan_file = "/tmp/plan.md";
  const p = join(dir, `graph-${counter++}.json`);
  writeFileSync(p, JSON.stringify(g));
  return run(stateDir, ["init", "--graph", p, ...extra]);
}

// A one-entry panel JSON for the resolve verb.
function panel(entries) { return JSON.stringify(entries); }
const ONE_AUDIT = panel([{ focus: "technical execution", executor: "subagent(general-purpose)" }]);

const HEX16 = /^[0-9a-f]{16}$/;

test("init: valid graph succeeds, prints GRAPH_ID, explodes to impl+resolve per task", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.match(id, HEX16);
  const statePath = join(stateDir, `${id}.json`);
  assert.ok(existsSync(statePath), "state file should exist");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(
    Object.keys(state.subnodes).sort(),
    ["A.impl", "A.resolve", "B.impl", "B.resolve"],
  );
  assert.equal(Object.keys(state.tasks).length, 2);
});

test("init: state is written under AMPLIFY_STATE_DIR, not elsewhere", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [task("A")] });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{16}\.json$/);
});

const invalidCases = {
  "missing required field (acceptance_criteria)": { version: 1, nodes: [{ id: "A", name: "A", deps: [], max_attempts: 1 }] },
  "impl.executor with invalid grammar": { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(bogus)" } })] },
  "external driver (codex) as implementer": { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(amplify:codex-driver)" } })] },
  "external driver (kimi) as implementer": { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(amplify:kimi-driver)" } })] },
  "stale audit field rejected": { version: 1, nodes: [task("A", [], { audit: { executor: "subagent(general-purpose)" } })] },
  "duplicate id": { version: 1, nodes: [task("A"), task("A")] },
  "unknown dependency": { version: 1, nodes: [task("A", ["ghost"])] },
  "dependency cycle": { version: 1, nodes: [task("A", ["B"]), task("B", ["A"])] },
  "id containing a dot": { version: 1, nodes: [task("A.x")] },
  "version not 1": { version: 2, nodes: [task("A")] },
  "empty nodes": { version: 1, nodes: [] },
};

for (const [label, graph] of Object.entries(invalidCases)) {
  test(`init: rejects invalid graph — ${label}`, () => {
    const { dir, stateDir } = ws();
    const r = init(stateDir, dir, graph);
    assert.notEqual(r.status, 0, `expected non-zero exit for: ${label}`);
    assert.match(r.stderr, /task: /);
  });
}

test("init: external-agent driver as implementer is rejected with an audit-only error and writes no state", () => {
  const { dir, stateDir } = ws();
  const bad = init(stateDir, dir, { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(amplify:codex-driver)" } })] });
  assert.notEqual(bad.status, 0, "external driver as implementer must be rejected");
  assert.match(bad.stderr, /audit-only|implementer/i);
  assert.equal(
    readdirSync(stateDir).filter((f) => f.endsWith(".json")).length, 0,
    "no state file is written on a rejected graph",
  );
});

test("resolve: an external-agent driver is still accepted as an auditor (audit-only, not impl)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const ok = run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "semantic", executor: "subagent(amplify:kimi-driver)" }])]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ids(ok.stdout), ["A.audit.0"]);
});

test("scheduling: ready returns only dependency-free .impl", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"]), task("C", ["A"])] }).stdout.trim();
  const ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.deepEqual(ready, ["A.impl"]);
});

test("dispatch: pending -> running; ready then omits it; complete settles the running subnode", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B")] }).stdout.trim();
  // both impls are ready
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout).sort(), ["A.impl", "B.impl"]);

  const d = run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.equal(d.status, 0, d.stderr);
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.subnodes["A.impl"].status, "running", "dispatch moves pending -> running");

  // ready no longer offers the running subnode
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["B.impl"]);

  // complete settles the running subnode (no need for it to be pending)
  const after = ids(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.ok(after.includes("A.resolve"), "completing a running .impl readies .resolve");
});

test("dispatch: errors on a non-pending subnode", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]); // -> running
  const again = run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.notEqual(again.status, 0, "re-dispatching a running subnode must error");
  assert.match(again.stderr, /pending/);
  // a not-yet-ready subnode (still pending but used to confirm running rejection) :
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]); // A.impl now done
  const onDone = run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.notEqual(onDone.status, 0, "dispatching a done subnode must error");
});

test("dispatch: a running audit subnode settles via fail", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { max_attempts: 1 })] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  run(stateDir, ["dispatch", "--id", id, "--node", "A.audit.0"]); // -> running
  const r = run(stateDir, ["fail", "--id", id, "--node", "A.audit.0", "--reason", "nope"]);
  assert.equal(r.status, 0, r.stderr);
  const report = run(stateDir, ["report", "--id", id]).stdout;
  assert.match(report, /\|\s*A\s*\|.*\|\s*FAILED\s*\|/, "running audit settles to failed at max_attempts");
});

test("init: stamps cwd into the state object", () => {
  const { dir, stateDir } = ws();
  ensureDir(dir); ensureDir(stateDir);
  const g = { version: 1, variables: {}, plan_file: "/tmp/plan.md", nodes: [task("A")] };
  const p = join(dir, "g.json");
  writeFileSync(p, JSON.stringify(g));
  const res = spawnSync("node", [ENGINE, "init", "--graph", p], {
    encoding: "utf8", cwd: dir,
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.trim();
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  // process.cwd() returns the realpath; on macOS /var is a symlink to /private/var.
  assert.equal(state.cwd, realpathSync(dir), "init records process.cwd() as state.cwd");
});

test("active: lists graphs with an INCOMPLETE task and correct ready/running counts; cwd-scoped", () => {
  const { dir, stateDir } = ws();
  ensureDir(dir); ensureDir(stateDir);
  const g = { version: 1, variables: {}, plan_file: "/tmp/plan.md", nodes: [task("A"), task("B")] };
  const p = join(dir, "g.json");
  writeFileSync(p, JSON.stringify(g));
  // init under a known cwd so we can scope by it (use realpath: macOS /var symlink)
  const res = spawnSync("node", [ENGINE, "init", "--graph", p], {
    encoding: "utf8", cwd: dir,
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  const id = res.stdout.trim();
  const cwd = realpathSync(dir);

  // fresh: two ready impls, none running, both tasks INCOMPLETE
  const j1 = JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--json"]).stdout);
  assert.deepEqual(j1, [{ graphId: id, incomplete: 2, ready: 2, running: 0 }]);

  // dispatch one -> ready drops to 1, running rises to 1
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  const j2 = JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--json"]).stdout);
  assert.deepEqual(j2, [{ graphId: id, incomplete: 2, ready: 1, running: 1 }]);

  // text form: one line per active graph
  const text = run(stateDir, ["active", "--cwd", cwd]).stdout.trim();
  assert.equal(text, `${id} incomplete=2 ready=1 running=1`);

  // a non-matching cwd filter yields the empty array / nothing
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--cwd", "/no/such/dir", "--json"]).stdout), []);
  assert.equal(run(stateDir, ["active", "--cwd", "/no/such/dir"]).stdout, "");
});

test("active: a fully-settled graph is not listed", () => {
  const { dir, stateDir } = ws();
  ensureDir(dir); ensureDir(stateDir);
  const g = { version: 1, variables: {}, plan_file: "/tmp/plan.md", nodes: [task("A", [], { max_attempts: 1 })] };
  const p = join(dir, "g.json");
  writeFileSync(p, JSON.stringify(g));
  const res = spawnSync("node", [ENGINE, "init", "--graph", p], {
    encoding: "utf8", cwd: dir,
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  const id = res.stdout.trim();
  // drive the single task to done
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]);
  // task A is done -> no INCOMPLETE task -> not active
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--json"]).stdout), []);
});

test("active: skips malformed state files and graphs without a cwd under a --cwd filter", () => {
  const { dir, stateDir } = ws();
  ensureDir(stateDir);
  // a malformed json file in the state dir must be skipped, not crash
  writeFileSync(join(stateDir, "garbage.json"), "{ not valid json");
  // a graph state without a cwd field
  writeFileSync(join(stateDir, "0000000000000000.json"), JSON.stringify({
    graphId: "0000000000000000",
    tasks: { A: { name: "A", status: "pending", deps: [] } },
    subnodes: { "A.impl": { task: "A", role: "impl", status: "pending", executor: "subagent(general-purpose)" } },
  }));
  // no filter -> the cwd-less graph is included
  const noFilter = JSON.parse(run(stateDir, ["active", "--json"]).stdout);
  assert.deepEqual(noFilter, [{ graphId: "0000000000000000", incomplete: 1, ready: 1, running: 0 }]);
  // with a --cwd filter -> the cwd-less graph is excluded
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--cwd", dir, "--json"]).stdout), []);
});

// Like run(), but pins (or clears, when session === null) CLAUDE_CODE_SESSION_ID
// so the session stamp saveState writes is deterministic in a test.
function runAs(stateDir, session, args, cwd) {
  const env = { ...process.env, AMPLIFY_STATE_DIR: stateDir };
  if (session === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = session;
  const res = spawnSync("node", [ENGINE, ...args], {
    encoding: "utf8", env, ...(cwd ? { cwd } : {}),
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function initAs(stateDir, dir, session, graph) {
  ensureDir(dir); ensureDir(stateDir);
  const g = { variables: {}, plan_file: "/tmp/plan.md", ...graph };
  const p = join(dir, `graph-${counter++}.json`);
  writeFileSync(p, JSON.stringify(g));
  return runAs(stateDir, session, ["init", "--graph", p], dir);
}

test("session: saveState stamps CLAUDE_CODE_SESSION_ID and refreshes it on later verbs", () => {
  const { dir, stateDir } = ws();
  const r = initAs(stateDir, dir, "sess-1", { version: 1, nodes: [task("A")] });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const statePath = join(stateDir, `${id}.json`);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).session, "sess-1");
  // a later mutating verb run under a DIFFERENT session (as after a compaction
  // changes the live id) refreshes the stamp, so the hook keeps matching.
  runAs(stateDir, "sess-2", ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).session, "sess-2");
});

test("active --session: two graphs sharing one cwd are scoped to their owning session", () => {
  const { dir, stateDir } = ws();
  const a = initAs(stateDir, dir, "sess-A", { version: 1, nodes: [task("A")] });
  const b = initAs(stateDir, dir, "sess-B", { version: 1, nodes: [task("X")] });
  const idA = a.stdout.trim(), idB = b.stdout.trim();
  assert.notEqual(idA, idB);
  const cwd = realpathSync(dir);
  // both live in the same project dir; --session is what tells the windows apart
  const onlyA = JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--session", "sess-A", "--json"]).stdout);
  assert.deepEqual(onlyA.map((g) => g.graphId), [idA]);
  const onlyB = JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--session", "sess-B", "--json"]).stdout);
  assert.deepEqual(onlyB.map((g) => g.graphId), [idB]);
  // no session matches the third one -> nothing (the safe, no-block default)
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--session", "sess-C", "--json"]).stdout), []);
});

test("active --session: a graph with no stored session is excluded under a --session filter", () => {
  const { dir, stateDir } = ws();
  const r = initAs(stateDir, dir, null, { version: 1, nodes: [task("A")] });
  const id = r.stdout.trim();
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.session, undefined, "no session is stamped when the env var is absent");
  // excluded under a --session filter ...
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--session", "sess-X", "--json"]).stdout), []);
  // ... but still listed with no filter (back-compat)
  assert.deepEqual(
    JSON.parse(run(stateDir, ["active", "--json"]).stdout).map((g) => g.graphId),
    [id],
  );
});

test("flow: complete .impl readies .resolve; resolve registers audits; audits done readies successor SET", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"]), task("C", ["A"])] }).stdout.trim();

  const afterImpl = ids(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(afterImpl, ["A.resolve"]);

  const afterResolve = ids(run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "technical execution", executor: "subagent(general-purpose)" },
            { focus: "semantic", executor: "subagent(general-purpose)" }])]).stdout);
  assert.deepEqual(afterResolve.sort(), ["A.audit.0", "A.audit.1"]);

  const afterFirstAudit = ids(run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]).stdout);
  assert.deepEqual(afterFirstAudit, ["A.audit.1"]); // round still in progress

  const afterRound = ids(run(stateDir, ["complete", "--id", id, "--node", "A.audit.1"]).stdout);
  assert.deepEqual(afterRound.sort(), ["B.impl", "C.impl"]); // task A done -> successors
});

test("flow: ready/complete/resolve emit '<id>\\t<executor>', carrying each subnode's executor", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("A"), task("B", ["A"], { impl: { executor: "subagent(explore)" } })],
  }).stdout.trim();

  const readyLines = lines(run(stateDir, ["ready", "--id", id]).stdout);
  assert.deepEqual(readyLines, ["A.impl\tsubagent(general-purpose)"]);

  const afterImpl = lines(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(afterImpl, ["A.resolve\tsubagent(amplify:audit-resolver)"]);

  const afterResolve = lines(run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "semantic", executor: "subagent(amplify:codex-driver)" }])]).stdout);
  assert.deepEqual(afterResolve, ["A.audit.0\tsubagent(amplify:codex-driver)"]);

  // single auditor passes -> task A done -> B.impl ready with B's explicit executor
  const afterAudit = lines(run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]).stdout);
  assert.deepEqual(afterAudit, ["B.impl\tsubagent(explore)"]);
});

test("resolve: rejects a bad panel executor and a non-resolve subnode", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const bad = run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "x", executor: "subagent(bogus)" }])]);
  assert.notEqual(bad.status, 0);
  const wrongNode = run(stateDir, ["resolve", "--id", id, "--node", "A.impl", "--panel", ONE_AUDIT]);
  assert.notEqual(wrongNode.status, 0);
});

test("complete: rejects a .resolve subnode (must use the resolve verb)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const r = run(stateDir, ["complete", "--id", id, "--node", "A.resolve"]);
  assert.notEqual(r.status, 0);
});

test("failure: fail under max reopens impl (resets resolve, drops audits); at max marks failed, non-halting", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { max_attempts: 2 }), task("B", ["A"])] }).stdout.trim();

  // round 1
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  const retry = ids(run(stateDir, ["fail", "--id", id, "--node", "A.audit.0", "--reason", "nope"]).stdout);
  assert.ok(retry.includes("A.impl"), "A.impl should reopen for retry");
  // audits dropped: A.audit.0 should be gone from state
  const state1 = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.ok(!("A.audit.0" in state1.subnodes), "the round's audit subnode should be dropped on retry");
  assert.equal(state1.subnodes["A.resolve"].status, "pending", "resolve should reset for re-resolution");

  // round 2 -> exhausted
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  const exhausted = ids(run(stateDir, ["fail", "--id", id, "--node", "A.audit.0", "--reason", "still nope"]).stdout);
  assert.ok(exhausted.includes("B.impl"), "successor must proceed after a logged failure");

  const report = run(stateDir, ["report", "--id", id]).stdout;
  assert.match(report, /\|\s*A\s*\|.*\|\s*FAILED\s*\|/);
});

test("fail: rejects a non-audit subnode", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  assert.notEqual(run(stateDir, ["fail", "--id", id, "--node", "A.impl"]).status, 0);
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  assert.notEqual(run(stateDir, ["fail", "--id", id, "--node", "A.resolve"]).status, 0);
});

test("identity: same graph + same salt => same GRAPH_ID (resume preserves state)", () => {
  const { dir, stateDir } = ws();
  const graph = { version: 1, nodes: [task("A"), task("B", ["A"])] };
  const id1 = init(stateDir, dir, graph, ["--salt", "p"]).stdout.trim();
  run(stateDir, ["complete", "--id", id1, "--node", "A.impl"]);
  const id2 = init(stateDir, dir, graph, ["--salt", "p"]).stdout.trim();
  assert.equal(id1, id2);
  // state preserved: A.impl done, so ready should be A.resolve (not A.impl)
  const ready = ids(run(stateDir, ["ready", "--id", id2]).stdout);
  assert.deepEqual(ready, ["A.resolve"]);
});

// --- commit applier + folded-graph projection --------------------------------
// These prove the structural mutators (init/explode, resolve, complete/settle,
// fail/settle) all route through the single validated commit: a mid-flight state
// carrying every spec feature (human_gate, an explicit non-default executor,
// deps) survives the full lifecycle, because commit re-projects and re-validates
// the folded graph at each step.

test("commit: a mid-flight state with human_gate + explicit executor + deps survives every verb", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      task("A", [], { human_gate: true, impl: { executor: "subagent(explore)" } }),
      task("B", ["A"], { max_attempts: 2 }),
    ],
  }).stdout.trim();
  assert.match(id, HEX16, "init through commit prints a GRAPH_ID");

  // drive A to done through complete/resolve/complete (each a committed mutation)
  assert.deepEqual(ids(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout), ["A.resolve"]);
  assert.deepEqual(ids(run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]).stdout), ["A.audit.0"]);
  assert.deepEqual(ids(run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]).stdout), ["B.impl"]);

  // fail B once (committed retry) then exhaust (committed failure); successors/report unaffected
  run(stateDir, ["complete", "--id", id, "--node", "B.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "B.resolve", "--panel", ONE_AUDIT]);
  const retry = ids(run(stateDir, ["fail", "--id", id, "--node", "B.audit.0", "--reason", "x"]).stdout);
  assert.ok(retry.includes("B.impl"), "fail-under-max reopens B.impl through commit");
  // the human_gate boolean and explicit executor are intact after several commits
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.tasks.A.human_gate, true);
  assert.equal(state.subnodes["A.impl"].executor, "subagent(explore)");
});

test("commit: init rejects an invalid graph atomically — no state file written", () => {
  const { dir, stateDir } = ws();
  // an external-agent driver as implementer is invalid; init must reject before any write
  const bad = init(stateDir, dir, {
    version: 1, nodes: [task("A", [], { impl: { executor: "subagent(amplify:codex-driver)" } })],
  });
  assert.notEqual(bad.status, 0, "invalid graph must be rejected");
  assert.equal(
    readdirSync(stateDir).filter((f) => f.endsWith(".json")).length, 0,
    "a rejected commit writes no state file (atomic)",
  );
});

test("identity: different content or salt => different GRAPH_ID", () => {
  const { dir, stateDir } = ws();
  const g1 = { version: 1, nodes: [task("A")] };
  const g2 = { version: 1, nodes: [task("Z")] };
  const idA = init(stateDir, dir, g1, ["--salt", "p"]).stdout.trim();
  const idB = init(stateDir, dir, g2, ["--salt", "p"]).stdout.trim();
  const idC = init(stateDir, dir, g1, ["--salt", "q"]).stdout.trim();
  assert.notEqual(idA, idB, "different content => different id");
  assert.notEqual(idA, idC, "different salt => different id");
});

test("field parity: a graph built from the schema's required keys is accepted", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const required = schema.$defs.task.required;
  assert.deepEqual(
    [...required].sort(),
    ["acceptance_criteria", "deps", "design_aspect", "id", "max_attempts", "name"],
    "schema required keys are the snake_case contract (no audit)",
  );
  const node = { id: "A", name: "A", deps: [], acceptance_criteria: ["x"], design_aspect: "Architecture", max_attempts: 1 };
  for (const k of required) assert.ok(k in node, `missing required key ${k}`);
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [node] });
  assert.equal(r.status, 0, r.stderr);
});

test("schema: external-agent drivers are excluded from the impl executor pattern", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const pattern = schema.$defs.executor.pattern;
  assert.doesNotMatch(pattern, /codex-driver/, "codex-driver must not be a valid implementer");
  assert.doesNotMatch(pattern, /kimi-driver/, "kimi-driver must not be a valid implementer");
  // ordinary implementers stay valid
  assert.match(pattern, /general-purpose/);
});

// --- runId rename + commitSeq + wire stability (V-ID.1) ---------------------

test("identity: state stores runId (not graphId) and its value equals the printed id", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.runId, id, "state.runId must match the printed id");
  assert.equal(state.graphId, undefined, "state.graphId must not exist (renamed to runId)");
});

test("persist: saveState is atomic (temp+rename) — no torn/.tmp file survives a save", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  // Each mutating verb persists via saveState; drive a few.
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const entries = readdirSync(stateDir);
  // The write-temp-then-rename path must leave no temp file behind on success.
  assert.deepEqual(
    entries.filter((f) => f.endsWith(".tmp")),
    [],
    "no .tmp file should survive a successful save (atomic rename cleans up)",
  );
  // The live file exists and is fully-written valid JSON (never half-written).
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.runId, id);
});

test("identity: runId is stable across commits — same value before and after dispatch", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const before = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8")).runId;
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  const after = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8")).runId;
  assert.equal(before, id, "runId matches id before dispatch");
  assert.equal(after, id, "runId is stable after a commit (dispatch)");
});

test("commitSeq: starts at 0 before first commit, increments once per commit", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B")] }).stdout.trim();
  // init runs one commit (the explode change); commitSeq should be 1
  const s0 = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(typeof s0.commitSeq, "number", "commitSeq must be a number");
  assert.equal(s0.commitSeq, 1, "commitSeq is 1 after init's single commit");
  // each mutating verb runs one commit
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  const s1 = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(s1.commitSeq, 2, "dispatch increments commitSeq to 2");
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const s2 = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(s2.commitSeq, 3, "complete increments commitSeq to 3");
});

test("commitSeq: is not named version and does not appear in projectFoldedGraph output", () => {
  const { dir, stateDir } = ws();
  // This is verified structurally: validateGraph checks version===1 and rejects
  // unknown fields. Because commit() calls validateGraph(projectFoldedGraph(...))
  // and succeeds, the projected view cannot include commitSeq (which has no
  // fixed value of 1) or any field unknown to the schema.
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.ok("commitSeq" in state, "commitSeq is a state field");
  assert.equal(state.version, undefined, "state has no top-level version key (it lives in the folded view only)");
});

test("wire: active --json still emits graphId key (not runId) for loop-resume.mjs compatibility", () => {
  const { dir, stateDir } = ws();
  ensureDir(dir); ensureDir(stateDir);
  const g = { version: 1, variables: {}, plan_file: "/tmp/plan.md", nodes: [task("A")] };
  const p = join(dir, "g.json");
  writeFileSync(p, JSON.stringify(g));
  const res = spawnSync("node", [ENGINE, "init", "--graph", p], {
    encoding: "utf8", cwd: dir,
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  const id = res.stdout.trim();
  const out = JSON.parse(run(stateDir, ["active", "--json"]).stdout);
  assert.ok(out.length === 1, "one active graph");
  assert.ok("graphId" in out[0], "active --json emits graphId key (wire-stable)");
  assert.ok(!("runId" in out[0]), "active --json does not emit runId (not a wire name)");
  assert.equal(out[0].graphId, id, "graphId value matches the printed id from init");
});

test("wire: --id flag accepts the runId value and resolves state correctly", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  // --id is the same flag as before; the value it receives is the runId (same hash)
  const r = run(stateDir, ["ready", "--id", id]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), ["A.impl"]);
});

// --- per-task Merkle contentHash + doneHash (V-CH) --------------------------
// contentHash is COMPUTED and STORED on every commit but reads no scheduling
// decision yet (that is later tasks). These assert the hash is folded from the
// resolved spec + sorted dependency hashes. The black-box probe reads the hash
// straight off the persisted state file.

// Read every task's stored contentHash from the state file as { id: hash }.
function contentHashes(stateDir, id) {
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  return Object.fromEntries(Object.entries(state.tasks).map(([k, t]) => [k, t.contentHash]));
}

test("V-CH.1 contentHash: identical spec and deps => identical hash; every task has a sha256 hex", () => {
  const graph = { version: 1, nodes: [task("A"), task("B", ["A"])] };
  const a = ws();
  const idA = init(a.stateDir, a.dir, graph).stdout.trim();
  const b = ws();
  const idB = init(b.stateDir, b.dir, graph).stdout.trim();
  const ha = contentHashes(a.stateDir, idA);
  const hb = contentHashes(b.stateDir, idB);
  assert.match(ha.A, /^[0-9a-f]{64}$/, "contentHash is a full sha256 hex");
  assert.equal(ha.A, hb.A, "same spec => same hash for A");
  assert.equal(ha.B, hb.B, "same spec + same deps => same hash for B");
});

test("V-CH.2 contentHash: changing acceptance_criteria, design_aspect, max_attempts, or a dep changes the hash", () => {
  const base = ws();
  const idBase = init(base.stateDir, base.dir, { version: 1, nodes: [task("A"), task("B", ["A"])] }).stdout.trim();
  const hBase = contentHashes(base.stateDir, idBase);

  // change A's acceptance_criteria -> A's hash changes, and B (downstream) too
  const ac = ws();
  const idAc = init(ac.stateDir, ac.dir, { version: 1, nodes: [task("A", [], { acceptance_criteria: ["different"] }), task("B", ["A"])] }).stdout.trim();
  const hAc = contentHashes(ac.stateDir, idAc);
  assert.notEqual(hAc.A, hBase.A, "changing acceptance_criteria changes A's hash");
  assert.notEqual(hAc.B, hBase.B, "the change propagates downstream to B's hash");

  // change A's design_aspect
  const da = ws();
  const idDa = init(da.stateDir, da.dir, { version: 1, nodes: [task("A", [], { design_aspect: "Data Structure" }), task("B", ["A"])] }).stdout.trim();
  assert.notEqual(contentHashes(da.stateDir, idDa).A, hBase.A, "changing design_aspect changes the hash");

  // change A's max_attempts
  const ma = ws();
  const idMa = init(ma.stateDir, ma.dir, { version: 1, nodes: [task("A", [], { max_attempts: 5 }), task("B", ["A"])] }).stdout.trim();
  assert.notEqual(contentHashes(ma.stateDir, idMa).A, hBase.A, "changing max_attempts changes the hash");

  // change B's deps (drop the dep on A) -> B's hash changes; A unchanged
  const dep = ws();
  const idDep = init(dep.stateDir, dep.dir, { version: 1, nodes: [task("A"), task("B")] }).stdout.trim();
  const hDep = contentHashes(dep.stateDir, idDep);
  assert.equal(hDep.A, hBase.A, "A is unchanged when only B's deps change");
  assert.notEqual(hDep.B, hBase.B, "dropping a dependency changes the dependent's hash");
});

test("V-CH.3 contentHash: omitted impl and explicit subagent(general-purpose) hash equal (resolved executor)", () => {
  const omit = ws();
  const idOmit = init(omit.stateDir, omit.dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const expl = ws();
  const idExpl = init(expl.stateDir, expl.dir, { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(general-purpose)" } })] }).stdout.trim();
  assert.equal(
    contentHashes(omit.stateDir, idOmit).A,
    contentHashes(expl.stateDir, idExpl).A,
    "the resolved executor is hashed, so default == explicit general-purpose",
  );
  // and a DIFFERENT explicit executor does change the hash
  const other = ws();
  const idOther = init(other.stateDir, other.dir, { version: 1, nodes: [task("A", [], { impl: { executor: "subagent(explore)" } })] }).stdout.trim();
  assert.notEqual(
    contentHashes(omit.stateDir, idOmit).A,
    contentHashes(other.stateDir, idOther).A,
    "a different executor changes the hash",
  );
});

test("V-CH.4 contentHash: adding a task that depends on X leaves X's hash unchanged", () => {
  const lone = ws();
  const idLone = init(lone.stateDir, lone.dir, { version: 1, nodes: [task("X")] }).stdout.trim();
  const withConsumer = ws();
  const idWith = init(withConsumer.stateDir, withConsumer.dir, { version: 1, nodes: [task("X"), task("Y", ["X"])] }).stdout.trim();
  assert.equal(
    contentHashes(lone.stateDir, idLone).X,
    contentHashes(withConsumer.stateDir, idWith).X,
    "a task hashes its deps, not its consumers, so adding a consumer does not touch X",
  );
});

test("doneHash: unset until a task reaches done, then equals the task's contentHash", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  // before done: no doneHash
  let state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.tasks.A.doneHash, undefined, "doneHash is unset before the task reaches done");
  // drive A to done
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]);
  state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.tasks.A.status, "done", "A reached done");
  assert.equal(state.tasks.A.doneHash, state.tasks.A.contentHash, "doneHash equals the task's contentHash at done");
});

// --- snapshot isolation for in-flight subnodes (V-SR.1) --------------------
// dispatch stamps subnode.dispatchHash = task.contentHash; at completion, if the
// task's contentHash has since moved, the result is DISCARDED and the subnode is
// re-readied (reset to pending) instead of applied — and it is redispatched
// exactly once, never twice. No automatic trigger changes a running task's
// contentHash yet, so the drift is constructed by editing the persisted state
// JSON the tests already read/write (a black-box-legal mechanism).

// Read the whole state object straight off disk.
function readState(stateDir, id) {
  return JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
}
function writeState(stateDir, id, state) {
  writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(state, null, 2));
}

test("mvcc: dispatch stamps dispatchHash = task.contentHash", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  const state = readState(stateDir, id);
  assert.equal(
    state.subnodes["A.impl"].dispatchHash,
    state.tasks.A.contentHash,
    "dispatch stamps the task's current contentHash onto the subnode",
  );
});

test("V-SR.1 mvcc: a commit changing a running task's contentHash discards its completion and re-readies the subnode, dispatched exactly once", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] }).stdout.trim();

  // dispatch A.impl -> running, stamping its dispatchHash to A's contentHash
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  let state = readState(stateDir, id);
  assert.equal(state.subnodes["A.impl"].status, "running");
  const stamped = state.subnodes["A.impl"].dispatchHash;
  assert.equal(stamped, state.tasks.A.contentHash, "stamped at the current hash");

  // construct the drift: the graph moved under the running work (simulate a
  // commit that changed A's contentHash). Editing the persisted state JSON is the
  // black-box-legal mechanism the task guidance names.
  state.tasks.A.contentHash = "deadbeef".repeat(8); // 64-hex, != stamped
  writeState(stateDir, id, state);

  // completing the stale run must DISCARD: no result applied (task NOT impl-done),
  // subnode reset to pending and re-offered by ready.
  const out = run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  assert.equal(out.status, 0, out.stderr);
  state = readState(stateDir, id);
  assert.equal(state.subnodes["A.impl"].status, "pending", "stale completion re-readies the subnode");
  assert.notEqual(state.tasks.A.status, "impl-done", "the stale impl result is NOT applied");
  assert.equal(state.subnodes["A.resolve"].status, "pending", "no downstream (resolve) was readied by the discarded result");

  // ready re-offers exactly A.impl (B still gated on A)
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["A.impl"], "the discarded subnode is re-offered, once");

  // it redispatches exactly once: the first dispatch succeeds; a second is refused
  // because the subnode is now running again (no double-dispatch).
  const d1 = run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.equal(d1.status, 0, "fresh redispatch succeeds");
  const d2 = run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  assert.notEqual(d2.status, 0, "a second concurrent dispatch is refused — never double-dispatched");
  // the fresh dispatch re-stamps dispatchHash to the now-current contentHash
  state = readState(stateDir, id);
  assert.equal(
    state.subnodes["A.impl"].dispatchHash,
    state.tasks.A.contentHash,
    "the redispatch re-stamps to the current contentHash, so it will not be discarded again",
  );
});

test("mvcc: a completion whose dispatchHash still matches is applied normally (no false discard)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  // no drift: complete should APPLY (task -> impl-done, A.resolve readied)
  const after = ids(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(after, ["A.resolve"], "a fresh (matching) completion is applied");
  const state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "impl-done", "the impl result is applied when hashes match");
});

// --- structural invalidation (V-SI) ----------------------------------------
// On every commit, AFTER content hashes are recomputed, invalidateStale resets
// work the commit made stale. Drift is constructed by editing the persisted
// state JSON (the same black-box-legal mechanism the mvcc V-SR test uses), since
// task-level mutation verbs do not exist yet. The drift is planted on the fields
// invalidation READS and recompute does NOT overwrite — a task's doneHash (its
// last-settled hash) or an impl subnode's dispatchHash — so the freshly
// recomputed contentHash diverges from the planted baseline exactly as a genuine
// upstream/spec change would make it diverge.

// Drive a single-task graph's task A to "done" (impl -> resolve -> one audit).
function driveToDone(stateDir, id, t = "A") {
  run(stateDir, ["complete", "--id", id, "--node", `${t}.impl`]);
  run(stateDir, ["resolve", "--id", id, "--node", `${t}.resolve`, "--panel", ONE_AUDIT]);
  run(stateDir, ["complete", "--id", id, "--node", `${t}.audit.0`]);
}

test("V-SI.1 invalidate: a done task whose hash drifted resets and redispatches; an unchanged sibling is reused", () => {
  const { dir, stateDir } = ws();
  // up, keep: two independent done tasks; trigger depends on both so trigger.impl
  // stays pending and gives us a commit to ride (dispatching it fires invalidateStale).
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("up"), task("keep"), task("trigger", ["up", "keep"])],
  }).stdout.trim();
  driveToDone(stateDir, id, "up");
  driveToDone(stateDir, id, "keep");
  // both done; trigger.impl is now ready (pending)
  let state = readState(stateDir, id);
  assert.equal(state.tasks.up.status, "done");
  assert.equal(state.tasks.keep.status, "done");
  const keepDoneHash = state.tasks.keep.doneHash;
  assert.equal(keepDoneHash, state.tasks.keep.contentHash, "keep settled at its contentHash");

  // plant drift on `up` only: a doneHash that no longer matches what recompute
  // will reproduce for up's (unchanged) spec -> up looks stale, keep does not.
  state.tasks.up.doneHash = "feedface".repeat(8); // 64-hex, != recomputed contentHash
  writeState(stateDir, id, state);

  // ride any commit (dispatch the unrelated trigger.impl) -> invalidateStale runs
  const d = run(stateDir, ["dispatch", "--id", id, "--node", "trigger.impl"]);
  assert.equal(d.status, 0, d.stderr);

  state = readState(stateDir, id);
  // up was reset: back to pending, attempts cleared, doneHash dropped, subnodes reset
  assert.equal(state.tasks.up.status, "pending", "drifted done task resets to pending");
  assert.equal(state.tasks.up.attempts, 0, "attempts cleared on a done-reset");
  assert.equal(state.tasks.up.doneHash, undefined, "doneHash cleared on reset");
  assert.equal(state.subnodes["up.impl"].status, "pending", "up.impl reset to pending");
  assert.equal(state.subnodes["up.resolve"].status, "pending", "up.resolve reset to pending");
  assert.ok(!("up.audit.0" in state.subnodes), "up's audit subnodes are dropped");
  // keep was REUSED: untouched, still done, doneHash intact (== its contentHash)
  assert.equal(state.tasks.keep.status, "done", "unchanged sibling stays done (reused)");
  assert.equal(state.tasks.keep.doneHash, keepDoneHash, "keep's doneHash is untouched");
  assert.equal(state.tasks.keep.doneHash, state.tasks.keep.contentHash, "keep is not stale");
  // and the reset task is redispatched: ready re-offers up.impl
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("up.impl"),
    "the reset done task is redispatched (ready re-offers up.impl)");
});

test("V-SI.2 invalidate: an auditing task whose impl hash drifted drops the whole round atomically and does NOT bump attempts", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  // dispatch A.impl (stamps A.impl.dispatchHash) then complete it, then resolve a
  // TWO-auditor round so we can prove ALL audits are dropped together.
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "technical execution", executor: "subagent(general-purpose)" },
            { focus: "semantic", executor: "subagent(general-purpose)" }])]);
  let state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "auditing", "task is mid-round");
  assert.equal(state.tasks.A.attempts, 0, "no attempts yet");
  assert.ok("A.audit.0" in state.subnodes && "A.audit.1" in state.subnodes, "two auditors registered");

  // plant drift: the impl's dispatchHash no longer equals A's (recomputed) contentHash,
  // i.e. the round was built against a now-superseded implementation.
  state.subnodes["A.impl"].dispatchHash = "0badf00d".repeat(8); // 64-hex, != contentHash
  // also mark one auditor running, to prove dropping a RUNNING auditor is allowed
  state.subnodes["A.audit.0"].status = "running";
  writeState(stateDir, id, state);

  // ride a commit (dispatch the other auditor) -> invalidateStale tears down the round
  const d = run(stateDir, ["dispatch", "--id", id, "--node", "A.audit.1"]);
  assert.equal(d.status, 0, d.stderr);

  state = readState(stateDir, id);
  // the WHOLE round is gone, atomically
  assert.ok(!("A.audit.0" in state.subnodes), "audit.0 dropped");
  assert.ok(!("A.audit.1" in state.subnodes), "audit.1 dropped (whole round, atomically)");
  assert.equal(state.subnodes["A.resolve"].status, "pending", "resolve reset to pending");
  assert.equal(state.tasks.A.status, "pending", "task reset to a pre-audit state");
  // crucially, this is INVALIDATION, not a failed retry: attempts is NOT bumped
  assert.equal(state.tasks.A.attempts, 0, "attempts NOT incremented by invalidation");

  // the in-flight auditor's LATE return must not crash the engine: completing a
  // now-deleted audit subnode is a no-op discard (exit 0), not a die.
  const late = run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]);
  assert.equal(late.status, 0, "a late completion on a deleted audit subnode is a no-op, not a crash");
  const lateFail = run(stateDir, ["fail", "--id", id, "--node", "A.audit.1", "--reason", "x"]);
  assert.equal(lateFail.status, 0, "a late fail on a deleted audit subnode is a no-op, not a crash");
});

test("V-SI.3 invalidate: a failed task under a drift BELOW the generation cap resets and bumps generation", () => {
  const { dir, stateDir } = ws();
  // A fails (max_attempts 1); B is an independent pending task we dispatch to ride a commit.
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { max_attempts: 1 }), task("B")] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  run(stateDir, ["fail", "--id", id, "--node", "A.audit.0", "--reason", "nope"]);
  let state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "failed", "A is failed");
  assert.equal(state.tasks.A.generation, 0, "generation starts at 0");
  assert.equal(state.tasks.A.doneHash, state.tasks.A.contentHash, "failed task records its settled hash");

  // plant a drift on the failed task (generation still below the cap)
  state.tasks.A.doneHash = "deadbeef".repeat(8); // != recomputed contentHash
  writeState(stateDir, id, state);
  run(stateDir, ["dispatch", "--id", id, "--node", "B.impl"]); // ride a commit

  state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "pending", "a below-cap failed task is re-run (reset to pending)");
  assert.equal(state.tasks.A.attempts, 0, "attempts cleared on the re-run");
  assert.equal(state.tasks.A.generation, 1, "generation bumped to 1");
  assert.equal(state.tasks.A.doneHash, undefined, "doneHash cleared on reset");
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("A.impl"), "re-run task is redispatched");
});

test("V-SI.3 invalidate: a failed task AT the generation cap stays failed and is NOT re-run (bounded)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { max_attempts: 1 }), task("B")] }).stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", ONE_AUDIT]);
  run(stateDir, ["fail", "--id", id, "--node", "A.audit.0", "--reason", "nope"]);
  let state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "failed");

  // push generation to the cap and plant a fresh drift: the NEXT reset would be
  // generation 4 (> GEN_CAP 3), so it must be refused — the task stays failed.
  state.tasks.A.generation = 3; // GEN_CAP
  state.tasks.A.doneHash = "deadbeef".repeat(8); // drift present
  writeState(stateDir, id, state);
  run(stateDir, ["dispatch", "--id", id, "--node", "B.impl"]); // ride a commit

  state = readState(stateDir, id);
  assert.equal(state.tasks.A.status, "failed", "an at-cap failed task is NOT re-run, stays failed");
  assert.equal(state.tasks.A.generation, 3, "generation is not advanced past the cap");
  assert.ok(!ids(run(stateDir, ["ready", "--id", id]).stdout).includes("A.impl"),
    "the capped task is not redispatched");
});

// --- task-level graph-mutation commands (V-TC) -----------------------------
// SpawnTask / RemoveTask / AddDep / RemoveDep are a CAPABILITY routed through the
// single validated commit. These prove they insert/remove tasks and edges, that
// the three rejection cases (incomplete spec, cycle-creating add-dep, remove with
// dependents) leave state byte-unchanged and exit non-zero, and that removing a
// leaf whose executor is exclusive prints the dangling RELEASE owner line. No
// automatic caller exists — every command here is invoked manually by the test.

// A complete folded-graph node body (everything but the id), suitable as --spec.
function specBody(over = {}) {
  return {
    name: "Spawned",
    deps: [],
    acceptance_criteria: ["does the new thing"],
    design_aspect: "Architecture",
    max_attempts: 2,
    ...over,
  };
}

test("V-TC.1 spawn-task: a complete spec inserts the task with impl/resolve subnodes and a contentHash", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const before = readState(stateDir, id);
  assert.ok(!("N" in before.tasks), "the new task does not exist yet");

  const r = run(stateDir, ["spawn-task", "--id", id, "--task-id", "N",
    "--spec", JSON.stringify(specBody({ deps: ["A"] }))]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  assert.ok("N" in state.tasks, "the spawned task appears in tasks");
  assert.equal(state.tasks.N.status, "pending", "a fresh spawned task is pending");
  assert.deepEqual(state.tasks.N.deps, ["A"], "the spawned task carries its declared deps");
  assert.ok("N.impl" in state.subnodes, "spawn explodes an impl subnode");
  assert.ok("N.resolve" in state.subnodes, "spawn explodes a resolve subnode");
  assert.equal(state.subnodes["N.resolve"].executor, "subagent(amplify:audit-resolver)");
  assert.match(state.tasks.N.contentHash, /^[0-9a-f]{64}$/, "the spawned task gets a recomputed contentHash");
});

test("V-TC.1 add-dep / remove-dep: edges update and recompute the dependent's contentHash", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B")] }).stdout.trim();
  const h0 = contentHashes(stateDir, id);

  // add-dep B -> A: B now depends on A; B's hash folds in A's hash and changes; A's does not.
  const add = run(stateDir, ["add-dep", "--id", id, "--from", "B", "--to", "A"]);
  assert.equal(add.status, 0, add.stderr);
  let state = readState(stateDir, id);
  assert.deepEqual(state.tasks.B.deps, ["A"], "add-dep records the edge");
  const h1 = contentHashes(stateDir, id);
  assert.equal(h1.A, h0.A, "adding a consumer leaves the upstream hash unchanged");
  assert.notEqual(h1.B, h0.B, "the dependent's hash is recomputed after add-dep");
  // B.impl is now gated on A (no longer ready alongside A.impl)
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["A.impl"], "B is now gated on A");

  // remove-dep B -> A: edge gone; B's hash returns to its dep-free value
  const rm = run(stateDir, ["remove-dep", "--id", id, "--from", "B", "--to", "A"]);
  assert.equal(rm.status, 0, rm.stderr);
  state = readState(stateDir, id);
  assert.deepEqual(state.tasks.B.deps, [], "remove-dep drops the edge");
  const h2 = contentHashes(stateDir, id);
  assert.equal(h2.B, h0.B, "removing the dep restores B's original hash");
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout).sort(), ["A.impl", "B.impl"],
    "B is ungated again");
});

test("V-TC.2 reject: spawn-task with an incomplete spec is rejected and leaves state byte-unchanged", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");

  // missing acceptance_criteria / design_aspect / max_attempts -> validateGraph rejects
  const r = run(stateDir, ["spawn-task", "--id", id, "--task-id", "BAD",
    "--spec", JSON.stringify({ name: "incomplete", deps: [] })]);
  assert.notEqual(r.status, 0, "an incomplete spec must be rejected");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a rejected spawn writes no state (byte-for-byte unchanged)");
});

test("V-TC.2 reject: a cycle-creating add-dep is rejected and leaves state byte-unchanged", () => {
  const { dir, stateDir } = ws();
  // B depends on A; adding A -> B would close a cycle A<->B.
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] }).stdout.trim();
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");

  const r = run(stateDir, ["add-dep", "--id", id, "--from", "A", "--to", "B"]);
  assert.notEqual(r.status, 0, "a cycle-creating add-dep must be rejected");
  assert.match(r.stderr, /cycle/i, "the rejection names the cycle");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a rejected add-dep writes no state (byte-for-byte unchanged)");
});

test("V-TC.2 reject: remove-task with dependents is rejected and leaves state byte-unchanged", () => {
  const { dir, stateDir } = ws();
  // B depends on A; removing A would leave B with a dangling dep.
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] }).stdout.trim();
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");

  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A"]);
  assert.notEqual(r.status, 0, "removing a task with dependents must be rejected");
  assert.match(r.stderr, /B/, "the rejection names the dependent");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a rejected remove-task writes no state (byte-for-byte unchanged)");
});

test("V-TC.1 remove-task: a leaf with no dependents is removed with all its subnodes", () => {
  const { dir, stateDir } = ws();
  // A is independent; B depends on A. Remove B (a leaf with no dependents).
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] }).stdout.trim();
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "B"]);
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, id);
  assert.ok(!("B" in state.tasks), "the removed task is gone from tasks");
  assert.ok(!("B.impl" in state.subnodes), "B.impl is gone");
  assert.ok(!("B.resolve" in state.subnodes), "B.resolve is gone");
  assert.ok("A" in state.tasks, "the surviving task is untouched");
});

test("V-TC.3 remove-task: a leaf whose executor is exclusive prints the dangling RELEASE owner line", () => {
  const { dir, stateDir } = ws();
  // X is a leaf whose impl executor is exclusive (computer-use -> a host-global lock);
  // keep is an independent task so the graph stays non-empty after X is removed.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      task("X", [], { impl: { executor: "subagent(amplify:computer-use)" } }),
      task("keep"),
    ],
  }).stdout.trim();
  // confirm the impl subnode carries the exclusive executor
  let state = readState(stateDir, id);
  assert.equal(state.subnodes["X.impl"].executor, "subagent(amplify:computer-use)");
  const runId = state.runId;

  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "X"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^RELEASE ${runId}:X\\.impl$`, "m"),
    "remove-task reports the dangling exclusive-lock owner as RELEASE <runId>:<subnode>");
  state = readState(stateDir, id);
  assert.ok(!("X" in state.tasks), "the exclusive leaf is removed");
  assert.ok(!("X.impl" in state.subnodes), "its exclusive impl subnode is gone");
  assert.ok("keep" in state.tasks, "the surviving task is untouched");
});

test("V-TC.3 remove-task: a leaf whose executor is NOT exclusive prints no RELEASE line", () => {
  const { dir, stateDir } = ws();
  // keep stays so the graph remains non-empty (validateGraph rejects empty nodes).
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("keep")] }).stdout.trim();
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /RELEASE/, "a non-exclusive removal leaks no RELEASE line");
});

test("V-RT.1 remove-task: a rejected removal (last task, exclusive) emits no RELEASE and writes no state", () => {
  const { dir, stateDir } = ws();
  // Single task whose impl is exclusive; removing it empties the graph -> validateGraph rejects.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("only", [], { impl: { executor: "subagent(amplify:computer-use)" } })],
  }).stdout.trim();
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "only"]);
  assert.notEqual(r.status, 0, "removing the last task must be rejected (empty graph)");
  assert.doesNotMatch(r.stdout, /RELEASE/,
    "a rejected removal emits NO RELEASE — it is printed only after commit succeeds");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a rejected remove-task writes no state (byte-for-byte unchanged)");
});

test("V-RT.2 remove-task: refuses a task with a running subnode without --force", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("A", [], { impl: { executor: "subagent(amplify:computer-use)" } }), task("keep")],
  }).stdout.trim();
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]); // A.impl -> running (exclusive)
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A"]);
  assert.notEqual(r.status, 0, "removing a task with a running subnode must be refused without --force");
  assert.match(r.stderr, /running/, "the refusal explains the running subnode");
  assert.match(r.stderr, /A\.impl/, "the refusal names the running subnode");
  assert.doesNotMatch(r.stdout, /RELEASE/, "a refused removal emits no RELEASE");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a refused remove-task writes no state (byte-for-byte unchanged)");
});

test("V-RT.3 remove-task: --force removes a running task, warns on stderr, and RELEASEs after commit", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("A", [], { impl: { executor: "subagent(amplify:computer-use)" } }), task("keep")],
  }).stdout.trim();
  const runId = readState(stateDir, id).runId;
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]); // A.impl -> running (exclusive)
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^RELEASE ${runId}:A\\.impl$`, "m"),
    "RELEASE is emitted (after commit) for the exclusive running subnode");
  assert.match(r.stderr, /orphaning/, "a stderr warning flags the orphaned in-flight work");
  assert.match(r.stderr, /A\.impl/, "the warning names the orphaned subnode");
  const state = readState(stateDir, id);
  assert.ok(!("A" in state.tasks), "the force-removed task is gone");
  assert.ok(!("A.impl" in state.subnodes), "its running subnode is gone");
  assert.ok("keep" in state.tasks, "the surviving task is untouched");
});

// --- flock holder verbs (hold / release / holds) ---------------------------
// These exercise the kernel flock(2) reached via the bundled `perl`. If perl is
// unavailable the flock tests skip (the engine guards on it the same way).

const PERL_OK = spawnSync("perl", ["-e", "1"], { encoding: "utf8" }).status === 0;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Every background holder we start, so a global hook can reap them even if a test
// throws before its own cleanup (otherwise a live child keeps the runner alive).
const HOLDERS = [];
after(() => { for (const h of HOLDERS) killHold(h); });

// Kill the holder's whole process group (node + its perl child) -> the kernel
// frees the flock immediately, as a session killing its process tree would.
function killHold(h) {
  try { process.kill(-h.child.pid, "SIGKILL"); }
  catch { try { h.child.kill("SIGKILL"); } catch {} }
}

// Start a background `hold` (detached, in its own group); resolve with its first
// stdout line (HELD | BUSY | EXIT).
function startHold(stateDir, resource, owner, extra = []) {
  const child = spawn("node", [ENGINE, "hold", "--resource", resource, "--owner", owner, ...extra], {
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
    detached: true,
  });
  child.unref();
  let out = "";
  const first = new Promise((resolve) => {
    const settle = () => { const line = out.split("\n").find(Boolean); if (line) resolve(line); };
    child.stdout.on("data", (d) => { out += d.toString(); settle(); });
    child.on("exit", () => resolve(out.split("\n").find(Boolean) || "EXIT"));
  });
  const h = { child, first };
  HOLDERS.push(h);
  return h;
}

// Start a background `wait-free`; resolve `released` when it prints RELEASED (or exits).
function startWaitFree(stateDir, resources, extra = ["--interval", "1"]) {
  const child = spawn("node", [ENGINE, "wait-free", "--resource", resources, ...extra], {
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
    detached: true,
  });
  child.unref();
  let out = "";
  const released = new Promise((resolve) => {
    child.stdout.on("data", (d) => { out += d.toString(); if (/RELEASED/.test(out)) resolve("RELEASED"); });
    child.on("exit", () => resolve(/RELEASED/.test(out) ? "RELEASED" : "EXIT"));
  });
  const h = { child, released };
  HOLDERS.push(h);
  return h;
}

test("flock: mutual exclusion + auto-release when the holder dies", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "gidA:X.audit.0");
  assert.equal(await a.first, "HELD");
  assert.match(run(stateDir, ["holds", "--resource", "computer-use"]).stdout, /^HELD owner=gidA:X\.audit\.0/);
  // a second holder is refused while A lives
  const b = startHold(stateDir, "computer-use", "gidB:Y");
  assert.match(await b.first, /^BUSY\b/);
  // kill A (simulate session shutdown) -> the kernel frees the flock, no TTL wait
  killHold(a);
  await delay(400);
  const c = startHold(stateDir, "computer-use", "gidC:Z");
  assert.equal(await c.first, "HELD");
  killHold(c);
});

test("flock: release by the owner frees the lock; a wrong owner is refused", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "owner-1");
  assert.equal(await a.first, "HELD");
  assert.notEqual(run(stateDir, ["release", "--resource", "computer-use", "--owner", "someone-else"]).status, 0);
  assert.equal(run(stateDir, ["release", "--resource", "computer-use", "--owner", "owner-1"]).status, 0);
  await delay(300);
  const c = startHold(stateDir, "computer-use", "owner-2");
  assert.equal(await c.first, "HELD");
  killHold(c);
});

test("flock: independent resources do not block each other", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "A");
  const b = startHold(stateDir, "chrome-devtools", "B");
  assert.equal(await a.first, "HELD");
  assert.equal(await b.first, "HELD");
  killHold(a); killHold(b);
});

test("flock: a past-TTL holder is reclaimed (backstop)", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "stale-holder");
  assert.equal(await a.first, "HELD");
  await delay(20);
  // a new holder with a 1ms TTL treats the older lock as stale, kills it, acquires
  const b = startHold(stateDir, "computer-use", "fresh-holder", ["--ttl", "1"]);
  assert.equal(await b.first, "HELD");
  killHold(a); killHold(b);
});

test("resource-of: maps exclusive executors, empty otherwise", () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  assert.equal(run(stateDir, ["resource-of", "--executor", "subagent(amplify:computer-use)"]).stdout.trim(), "computer-use");
  assert.equal(run(stateDir, ["resource-of", "--executor", "subagent(amplify:browser-use-chrome-devtools)"]).stdout.trim(), "chrome-devtools");
  assert.equal(run(stateDir, ["resource-of", "--executor", "subagent(amplify:browser-use-playwright)"]).stdout.trim(), "");
  assert.equal(run(stateDir, ["resource-of", "--executor", "subagent(general-purpose)"]).stdout.trim(), "");
});

test("wait-free: returns immediately when the resource is free", () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const r = run(stateDir, ["wait-free", "--resource", "computer-use", "--interval", "1"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^RELEASED computer-use/m);
});

test("wait-free: blocks while held, returns RELEASED when the holder dies", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "sessX:T");   // simulate an external holder
  assert.equal(await a.first, "HELD");
  const wf = startWaitFree(stateDir, "computer-use");
  // still waiting while held
  assert.equal(await Promise.race([wf.released.then(() => "R"), delay(800).then(() => "W")]), "W");
  killHold(a);                                                // external release
  assert.equal(await wf.released, "RELEASED");
});

test("wait-free: comma-separated returns when ANY listed resource frees", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "X");
  const b = startHold(stateDir, "chrome-devtools", "Y");
  assert.equal(await a.first, "HELD");
  assert.equal(await b.first, "HELD");
  const wf = startWaitFree(stateDir, "computer-use,chrome-devtools");
  assert.equal(await Promise.race([wf.released.then(() => "R"), delay(800).then(() => "W")]), "W");
  killHold(a);                                                // free one of the two
  assert.equal(await wf.released, "RELEASED");
  killHold(b);
});

test("hold: busy output names the current owner", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "sessX:T.audit.0");
  assert.equal(await a.first, "HELD");
  const b = startHold(stateDir, "computer-use", "sessY:U");
  assert.equal(await b.first, "BUSY owner=sessX:T.audit.0");
  killHold(a);
});

test("unknown verb exits non-zero", () => {
  const { stateDir } = ws();
  ensureDir(stateDir);
  const r = run(stateDir, ["frobnicate"]);
  assert.notEqual(r.status, 0);
});

test("variables: graph WITH a variable dictionary persists it and verb prints name<TAB>value", () => {
  const { dir, stateDir } = ws();
  const graph = { version: 1, nodes: [task("A")], variables: { "$AMPLIFY_CODEX_AVAILABLE": true, "$AMPLIFY_USE_CODEX_APPROVED": false } };
  const r = init(stateDir, dir, graph);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const caps = run(stateDir, ["variables", "--id", id]);
  assert.equal(caps.status, 0, caps.stderr);
  assert.deepEqual(lines(caps.stdout), ["$AMPLIFY_CODEX_AVAILABLE\ttrue", "$AMPLIFY_USE_CODEX_APPROVED\tfalse"]);
});

test("variables: graph WITHOUT variable field prints nothing and exits 0", () => {
  const { dir, stateDir } = ws();
  const graph = { version: 1, nodes: [task("A")] };
  const r = init(stateDir, dir, graph);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const caps = run(stateDir, ["variables", "--id", id]);
  assert.equal(caps.status, 0, caps.stderr);
  assert.equal(caps.stdout, "");
});

test("variables: init rejects a non-object variable (e.g. an array)", () => {
  const { dir, stateDir } = ws();
  const graph = { version: 1, nodes: [task("A")], variables: ["x"] };
  const r = init(stateDir, dir, graph);
  assert.notEqual(r.status, 0, "expected non-zero exit when variable is not a dictionary");
  assert.match(r.stderr, /task: /);
  assert.match(r.stderr, /dictionary/);
});

test("resolve-context: dumps task name, design aspect, plan file, acceptance criteria, variables", () => {
  const { dir, stateDir } = ws();
  const graph = {
    version: 1,
    plan_file: "/tmp/the-plan.md",
    variables: { "$AMPLIFY_CODEX_AVAILABLE": true },
    nodes: [task("A", [], { acceptance_criteria: ["c1", "c2"], design_aspect: "Data Structure" })],
  };
  const id = init(stateDir, dir, graph).stdout.trim();
  const r = run(stateDir, ["resolve-context", "--id", id, "--node", "A"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    "TASK NAME: Task A",
    "DESIGN ASPECT: Data Structure",
    "PLAN FILE: /tmp/the-plan.md",
    "ACCEPTANCE CRITERIA:",
    "- c1",
    "- c2",
    "VARIABLES:",
    "$AMPLIFY_CODEX_AVAILABLE\ttrue",
  ]);
});

test("resolve-context: errors on unknown --node", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const r = run(stateDir, ["resolve-context", "--id", id, "--node", "ghost"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ghost/);
});

test("init rejects a graph missing plan_file", () => {
  const { dir, stateDir } = ws();
  ensureDir(dir); ensureDir(stateDir);
  const p = join(dir, "no-plan.json");
  writeFileSync(p, JSON.stringify({ version: 1, variables: {}, nodes: [task("A")] }));
  const r = run(stateDir, ["init", "--graph", p]);
  assert.notEqual(r.status, 0, "expected non-zero exit for missing plan_file");
  assert.match(r.stderr, /plan_file/);
});

test("init rejects a node missing design_aspect", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [{ id: "A", name: "A", deps: [], acceptance_criteria: ["x"], max_attempts: 1 }] });
  assert.notEqual(r.status, 0, "expected non-zero exit for missing design_aspect");
  assert.match(r.stderr, /design_aspect/);
});
