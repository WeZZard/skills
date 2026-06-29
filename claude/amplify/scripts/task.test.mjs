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
// The producer helper under test (V10/V12): an absolute path so a generated `fn`
// node's `module` resolves regardless of cwd, plus the helper imported directly.
const LIFECYCLE = fileURLToPath(new URL("./lifecycle.mjs", import.meta.url));
import { verifiedTaskNodes } from "./lifecycle.mjs";

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

// A task no longer declares auditors -- they are resolved at runtime. Every node
// now carries an explicit `type`; the helper authors `implement` nodes (the type
// the execute-plan dump emits), so most existing graphs are unchanged save the
// added `type`.
function task(id, deps = [], over = {}) {
  return {
    id, type: "implement", name: `Task ${id}`, deps,
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
  "missing required field (acceptance_criteria)": { version: 1, nodes: [{ id: "A", type: "implement", name: "A", deps: [], max_attempts: 1 }] },
  "missing type": { version: 1, nodes: [{ id: "A", name: "A", deps: [], acceptance_criteria: ["x"], design_aspect: "Architecture", max_attempts: 1 }] },
  "executor with invalid grammar": { version: 1, nodes: [task("A", [], { executor: "subagent(bogus)" })] },
  "external driver (codex) as implementer": { version: 1, nodes: [task("A", [], { executor: "subagent(amplify:codex-driver)" })] },
  "external driver (kimi) as implementer": { version: 1, nodes: [task("A", [], { executor: "subagent(amplify:kimi-driver)" })] },
  "implement executor not general-purpose": { version: 1, nodes: [task("A", [], { executor: "subagent(explore)" })] },
  "stale audit field rejected (outside template)": { version: 1, nodes: [task("A", [], { audit: { executor: "subagent(general-purpose)" } })] },
  "duplicate id": { version: 1, nodes: [task("A"), task("A")] },
  "unknown dependency": { version: 1, nodes: [task("A", ["ghost"])] },
  "dependency cycle": { version: 1, nodes: [task("A", ["B"]), task("B", ["A"])] },
  "id containing a dot": { version: 1, nodes: [task("A.x")] },
  "version not 1": { version: 2, nodes: [task("A")] },
  "empty nodes": { version: 1, nodes: [] },
  "unknown type": { version: 1, nodes: [{ id: "A", type: "frobnicate", deps: [], executor: "subagent(general-purpose)" }] },
};

for (const [label, graph] of Object.entries(invalidCases)) {
  test(`init: rejects invalid graph — ${label}`, () => {
    const { dir, stateDir } = ws();
    const r = init(stateDir, dir, graph);
    assert.notEqual(r.status, 0, `expected non-zero exit for: ${label}`);
    assert.match(r.stderr, /task: /);
  });
}

test("init: a non-general-purpose implementer executor is rejected and writes no state", () => {
  const { dir, stateDir } = ws();
  // implement nodes are general-purpose-only; an external driver (or any other
  // executor) in the implement slot is rejected by the type's executor const rule.
  const bad = init(stateDir, dir, { version: 1, nodes: [task("A", [], { executor: "subagent(amplify:codex-driver)" })] });
  assert.notEqual(bad.status, 0, "a non-general-purpose implementer must be rejected");
  assert.match(bad.stderr, /general-purpose/i, "the rejection names the required executor");
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
  assert.deepEqual(j1, [{
    graphId: id,
    incomplete: 2,
    ready: 2,
    dispatchableReady: 2,
    resourceBlockedReady: 0,
    blockedResources: [],
    running: 0,
  }]);

  // dispatch one -> ready drops to 1, running rises to 1
  run(stateDir, ["dispatch", "--id", id, "--node", "A.impl"]);
  const j2 = JSON.parse(run(stateDir, ["active", "--cwd", cwd, "--json"]).stdout);
  assert.deepEqual(j2, [{
    graphId: id,
    incomplete: 2,
    ready: 1,
    dispatchableReady: 1,
    resourceBlockedReady: 0,
    blockedResources: [],
    running: 1,
  }]);

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
  assert.deepEqual(noFilter, [{
    graphId: "0000000000000000",
    incomplete: 1,
    ready: 1,
    dispatchableReady: 1,
    resourceBlockedReady: 0,
    blockedResources: [],
    running: 0,
  }]);
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

test("active --id: filters to one graph and composes with cwd/session filters", () => {
  const { dir, stateDir } = ws();
  const a = initAs(stateDir, dir, "sess-A", { version: 1, nodes: [task("A")] });
  const b = initAs(stateDir, dir, "sess-B", { version: 1, nodes: [task("X")] });
  const idA = a.stdout.trim(), idB = b.stdout.trim();
  const cwd = realpathSync(dir);
  assert.notEqual(idA, idB);

  const onlyA = JSON.parse(run(stateDir, ["active", "--id", idA, "--json"]).stdout);
  assert.deepEqual(onlyA.map((g) => g.graphId), [idA]);

  const matchingSession = JSON.parse(run(stateDir, ["active", "--id", idA, "--cwd", cwd, "--session", "sess-A", "--json"]).stdout);
  assert.deepEqual(matchingSession.map((g) => g.graphId), [idA]);

  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--id", idA, "--session", "sess-B", "--json"]).stdout), []);
  assert.deepEqual(JSON.parse(run(stateDir, ["active", "--id", idB, "--cwd", "/no/such/dir", "--json"]).stdout), []);
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
    nodes: [task("A"), task("B", ["A"])],
  }).stdout.trim();

  const readyLines = lines(run(stateDir, ["ready", "--id", id]).stdout);
  assert.deepEqual(readyLines, ["A.impl\tsubagent(general-purpose)"]);

  const afterImpl = lines(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(afterImpl, ["A.resolve\tsubagent(amplify:audit-resolver)"]);

  // the audit panel carries a custom (non-general-purpose) executor onto the audit
  // subnode — that is where specialized executors live now, not on the implementer.
  const afterResolve = lines(run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel",
    panel([{ focus: "semantic", executor: "subagent(amplify:codex-driver)" }])]).stdout);
  assert.deepEqual(afterResolve, ["A.audit.0\tsubagent(amplify:codex-driver)"]);

  // single auditor passes -> task A done -> B.impl ready with the general-purpose executor
  const afterAudit = lines(run(stateDir, ["complete", "--id", id, "--node", "A.audit.0"]).stdout);
  assert.deepEqual(afterAudit, ["B.impl\tsubagent(general-purpose)"]);
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

test("commit: a mid-flight state with human_gate + deps survives every verb", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      task("A", [], { human_gate: true }),
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
  // the human_gate boolean and the (general-purpose) executor are intact after several commits
  const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
  assert.equal(state.tasks.A.human_gate, true);
  assert.equal(state.subnodes["A.impl"].executor, "subagent(general-purpose)");
});

test("commit: init rejects an invalid graph atomically — no state file written", () => {
  const { dir, stateDir } = ws();
  // a non-general-purpose implementer executor is invalid; init must reject before any write
  const bad = init(stateDir, dir, {
    version: 1, nodes: [task("A", [], { executor: "subagent(amplify:codex-driver)" })],
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

test("field parity: a graph built from the implement type's required keys is accepted", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const required = schema.$defs.implement.required;
  assert.deepEqual(
    [...required].sort(),
    ["acceptance_criteria", "deps", "design_aspect", "id", "max_attempts", "name", "type"],
    "the implement type's required keys are the snake_case contract plus the explicit type (no audit)",
  );
  const node = { id: "A", type: "implement", name: "A", deps: [], acceptance_criteria: ["x"], design_aspect: "Architecture", max_attempts: 1 };
  for (const k of required) assert.ok(k in node, `missing required key ${k}`);
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [node] });
  assert.equal(r.status, 0, r.stderr);
});

test("schema: the implement type fixes its executor to general-purpose; the audit executor grammar admits the external drivers", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  // implement is general-purpose-only: no external driver (or any other executor)
  // can occupy an implement slot.
  assert.equal(schema.$defs.implement.properties.executor.const, "subagent(general-purpose)",
    "the implement type fixes its executor to subagent(general-purpose)");
  // the audit executor grammar admits the audit-only external-agent drivers as
  // read-only auditors (they are barred from implement by the const above).
  const pattern = schema.$defs.executor.pattern;
  assert.match(pattern, /codex-driver/, "codex-driver is a valid AUDIT executor (audit-only)");
  assert.match(pattern, /kimi-driver/, "kimi-driver is a valid AUDIT executor (audit-only)");
  assert.match(pattern, /general-purpose/);
});

// --- typed nodes + system property templates (V-NT) ------------------------
// Every node carries a required, explicit `type`; the system file node-types.json
// declares each type's property template, and validateGraph (read at load time)
// validates every node against its type's template: required present, no property
// outside the template, per-type property + executor checks. The execute-plan dump
// authors `implement` nodes; `audit`/`reduce` are DEFINED + validatable here.

const NODE_TYPES_FILE = fileURLToPath(new URL("../schemas/node-types.json", import.meta.url));

test("V-NT.1 typed implement: every existing test graph is a typed implement node (suite-green proxy)", () => {
  // The task() helper now stamps type:"implement" on every node, so a representative
  // graph with deps validates and runs exactly as before — this is the regression
  // anchor for "all existing graphs are typed implement nodes and still pass."
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"])] });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  const state = readState(stateDir, id);
  assert.equal(state.tasks.A.type, "implement", "the explicit type persists on the task record");
  assert.equal(state.tasks.B.type, "implement");
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["A.impl"], "typed implement schedules as before");
});

test("V-NT.1 node-types.json is the source of truth validateGraph reads (declares all types; executor required only when type dispatches a subagent)", () => {
  const nt = JSON.parse(readFileSync(NODE_TYPES_FILE, "utf8"));
  assert.deepEqual(Object.keys(nt.types).sort(),
    ["agent", "audit", "expand", "fn", "implement", "reduce", "resolve", "switch"],
    "node-types.json declares all eight node types (legacy + generalized)");
  for (const [name, tmpl] of Object.entries(nt.types)) {
    // executor is required only on types that dispatch a subagent (implement, resolve, audit, reduce, agent)
    if (tmpl.executor) {
      assert.ok(tmpl.required.includes("executor"), `${name} requires executor (dispatches a subagent)`);
    } else {
      assert.ok(!tmpl.required.includes("executor"), `${name} must NOT require executor (engine-driven: fn/expand/switch)`);
    }
    assert.ok(tmpl.required.includes("deps"), `${name} requires deps`);
    assert.ok(tmpl.required.includes("type"), `${name} requires the explicit type`);
  }
  // Legacy types: fixed executors
  assert.equal(nt.types.implement.executor.const, "subagent(general-purpose)");
  assert.equal(nt.types.resolve.executor.const, "subagent(amplify:audit-resolver)");
  assert.equal(nt.types.reduce.executor.const, "subagent(amplify:audit-reducer)");
  assert.ok(nt.types.audit.executor.matchesGrammar, "audit's executor is the open grammar (authored sub-agent)");
  // Generalized types with executor: agent uses open grammar; fn/expand/switch have no executor rule.
  assert.ok(nt.types.agent.executor.matchesGrammar, "agent's executor is the open grammar");
  assert.equal(nt.types.fn.executor, undefined, "fn has no executor rule (engine-driven)");
  assert.equal(nt.types.expand.executor, undefined, "expand has no executor rule (engine-driven)");
  assert.equal(nt.types.switch.executor, undefined, "switch has no executor rule (engine-driven)");
});

test("V-NT.5 consistency: node-types.json and task-graph.schema.json agree on every type's executor rule, property set, and required set", () => {
  // node-types.json is what the engine reads at load time; the schema $defs serve
  // only the dump's offline JSON-Schema validation. Nothing else asserts the two
  // hand-maintained declarations agree, so this guards against silent drift: an
  // edit to one file that isn't mirrored in the other fails here.
  // fn/expand/switch have no executor rule (engine-driven); the consistency check
  // handles them by skipping the executor-rule assertions for those types.
  const nt = JSON.parse(readFileSync(NODE_TYPES_FILE, "utf8")).types;
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  for (const type of Object.keys(nt)) {
    const tmpl = nt[type];
    const def = schema.$defs[type];
    assert.ok(def, `schema declares $defs.${type}`);

    // 1. Property set: node-types' required ∪ optional == schema's declared properties.
    assert.deepEqual(
      [...new Set([...tmpl.required, ...(tmpl.optional || [])])].sort(),
      Object.keys(def.properties).sort(),
      `${type}: property sets must match across the two files`,
    );

    // 2. Executor rule: a fixed (const) executor mirrors the schema const; the
    //    open-grammar (audit/agent) executor mirrors the schema $ref to #/$defs/executor.
    //    Types with no executor rule (fn/expand/switch) have no executor in their schema
    //    properties either — skip the executor-rule assertions for those.
    if (tmpl.executor) {
      if ("const" in tmpl.executor) {
        assert.equal(def.properties.executor.const, tmpl.executor.const,
          `${type}: executor const must match`);
      } else {
        assert.ok(tmpl.executor.matchesGrammar, `${type}: executor is the open grammar`);
        assert.equal(def.properties.executor.$ref, "#/$defs/executor",
          `${type}: open-grammar executor must $ref the shared executor grammar`);
      }
    } else {
      // engine-driven type: schema must not have a fixed-const executor property
      assert.ok(
        !def.properties.executor || !("const" in def.properties.executor),
        `${type}: engine-driven type must not have a fixed-const executor in schema`,
      );
    }

    // 3. Required set: identical, except a fixed (const, hence defaultable) executor
    //    is omitted from the schema's `required` (a missing executor defaults to the
    //    const), while the open-grammar executor stays required in both.
    //    For types with no executor rule, executor is simply absent from both.
    const defaultable = tmpl.executor && "const" in tmpl.executor;
    const expectedRequired = tmpl.required.filter((p) => !(p === "executor" && defaultable));
    assert.deepEqual(def.required.slice().sort(), expectedRequired.sort(),
      `${type}: required sets must match (executor defaultable iff its executor is fixed)`);
  }
});

test("V-NT.2 happy: an audit node {focus, audit_prompt, executor, deps} and a reduce node {counter, executor, deps} validate via init", () => {
  // An audit node carrying an authored (specialized) executor validates.
  const a = ws();
  const auditNode = { id: "AUD", type: "audit", deps: [], focus: "gui",
    audit_prompt: "verify the on-screen behavior", executor: "subagent(amplify:computer-use)" };
  const ra = init(a.stateDir, a.dir, { version: 1, nodes: [auditNode] });
  assert.equal(ra.status, 0, ra.stderr);
  assert.equal(readState(a.stateDir, ra.stdout.trim()).tasks.AUD.type, "audit", "the audit type persists");

  // A reduce node with a counter validates; its executor defaults to the reducer.
  const b = ws();
  const reduceNode = { id: "RED", type: "reduce", deps: [], counter: 0 };
  const rb = init(b.stateDir, b.dir, { version: 1, nodes: [reduceNode] });
  assert.equal(rb.status, 0, rb.stderr);
  const stateB = readState(b.stateDir, rb.stdout.trim());
  assert.equal(stateB.tasks.RED.type, "reduce", "the reduce type persists");
  assert.equal(stateB.tasks.RED.executor, "subagent(amplify:audit-reducer)",
    "reduce's executor defaults to the named reducer");
});

// A small per-case rejection harness: each fixture must be rejected by init.
const ntRejectCases = {
  "missing type": { version: 1, nodes: [{ id: "A", name: "A", deps: [], acceptance_criteria: ["x"], design_aspect: "Architecture", max_attempts: 1 }] },
  "implement with a non-general-purpose executor": { version: 1, nodes: [task("A", [], { executor: "subagent(explore)" })] },
  "audit missing focus": { version: 1, nodes: [{ id: "A", type: "audit", deps: [], audit_prompt: "p", executor: "subagent(general-purpose)" }] },
  "audit missing audit_prompt": { version: 1, nodes: [{ id: "A", type: "audit", deps: [], focus: "f", executor: "subagent(general-purpose)" }] },
  "reduce missing counter": { version: 1, nodes: [{ id: "A", type: "reduce", deps: [], executor: "subagent(amplify:audit-reducer)" }] },
  "implement missing acceptance_criteria": { version: 1, nodes: [{ id: "A", type: "implement", name: "A", deps: [], design_aspect: "Architecture", max_attempts: 1 }] },
  "implement missing design_aspect": { version: 1, nodes: [{ id: "A", type: "implement", name: "A", deps: [], acceptance_criteria: ["x"], max_attempts: 1 }] },
  "implement missing max_attempts": { version: 1, nodes: [{ id: "A", type: "implement", name: "A", deps: [], acceptance_criteria: ["x"], design_aspect: "Architecture" }] },
  "unknown type": { version: 1, nodes: [{ id: "A", type: "frobnicate", deps: [], executor: "subagent(general-purpose)" }] },
  "property outside the type template": { version: 1, nodes: [task("A", [], { audit_prompt: "not allowed on implement" })] },
};

for (const [label, graph] of Object.entries(ntRejectCases)) {
  test(`V-NT.3/4 reject: ${label}`, () => {
    const { dir, stateDir } = ws();
    const r = init(stateDir, dir, graph);
    assert.notEqual(r.status, 0, `expected non-zero exit for: ${label}`);
    assert.match(r.stderr, /task: /);
    assert.equal(
      readdirSync(stateDir).filter((f) => f.endsWith(".json")).length, 0,
      "a rejected graph writes no state",
    );
  });
}

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

test("V-CH.3 contentHash: an omitted executor and an explicit subagent(general-purpose) hash equal (resolved executor)", () => {
  const omit = ws();
  const idOmit = init(omit.stateDir, omit.dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const expl = ws();
  const idExpl = init(expl.stateDir, expl.dir, { version: 1, nodes: [task("A", [], { executor: "subagent(general-purpose)" })] }).stdout.trim();
  assert.equal(
    contentHashes(omit.stateDir, idOmit).A,
    contentHashes(expl.stateDir, idExpl).A,
    "the resolved executor is hashed, so an omitted executor == an explicit general-purpose one",
  );
  // implement nodes are general-purpose-only now, so the executor is no longer a
  // hash-varying dimension for them — a non-general-purpose executor would be
  // rejected by validateGraph, not produce a different hash.
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

// --- generalized content identity for every node kind (V16) ----------------
// spec()/the content hash folds EACH node type's declared identity fields read
// from its node-types.json template, NOT a fixed implement-only field list. So
// editing a non-implement node's identity field changes its contentHash (and any
// dependent's), and a settled non-implement node whose hash drifts is re-run by
// invalidateStale — exactly as an implement task is.

test("V16 contentHash: editing a non-implement node's identity field changes its contentHash (folded from the type template)", () => {
  // init a one- or two-node graph and return { id: contentHash } for every task.
  const hashesFor = (nodes) => {
    const w = ws();
    const r = init(w.stateDir, w.dir, { version: 1, nodes });
    assert.equal(r.status, 0, r.stderr);
    return contentHashes(w.stateDir, r.stdout.trim());
  };

  // agent: prompt + output_schema are identity fields
  const agent = (extra = {}) => ({
    id: "N", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do the thing", output_schema: { type: "string" }, max_attempts: 1, ...extra,
  });
  const baseAgent = hashesFor([agent()]).N;
  assert.notEqual(hashesFor([agent({ prompt: "do it another way" })]).N, baseAgent, "agent.prompt is an identity field");
  assert.notEqual(hashesFor([agent({ output_schema: { type: "integer" } })]).N, baseAgent, "agent.output_schema is an identity field");

  // fn: module + export + output_schema + require are identity fields
  const fn = (extra = {}) => ({
    id: "N", type: "fn", deps: [], module: "./reduce.mjs", export: "run",
    output_schema: { type: "object" }, ...extra,
  });
  const baseFn = hashesFor([fn()]).N;
  assert.notEqual(hashesFor([fn({ module: "./other.mjs" })]).N, baseFn, "fn.module is an identity field");
  assert.notEqual(hashesFor([fn({ export: "main" })]).N, baseFn, "fn.export is an identity field");
  assert.notEqual(hashesFor([fn({ output_schema: { type: "array" } })]).N, baseFn, "fn.output_schema is an identity field");
  assert.notEqual(hashesFor([fn({ require: "all-resolved" })]).N, baseFn, "fn.require is an identity field");

  // expand: over + template + gather are identity fields
  const expand = (extra = {}) => ({
    id: "N", type: "expand", deps: [], over: "src", template: { type: "string" }, gather: "G", ...extra,
  });
  const baseExpand = hashesFor([expand()]).N;
  assert.notEqual(hashesFor([expand({ over: "other-src" })]).N, baseExpand, "expand.over is an identity field");
  assert.notEqual(hashesFor([expand({ template: { type: "integer" } })]).N, baseExpand, "expand.template is an identity field");
  assert.notEqual(hashesFor([expand({ gather: "H" })]).N, baseExpand, "expand.gather is an identity field");

  // switch: cases is an identity field (a boolean selector keeps exhaustiveness as
  // we change only the case BODIES, not the keys, so the graph stays valid)
  const sw = (cases) => ([
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "pick", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "N", type: "switch", deps: ["SEL"], over: "SEL", cases },
  ]);
  const baseSwitch = hashesFor(sw({ "true": { go: 1 }, "false": { go: 0 } })).N;
  assert.notEqual(
    hashesFor(sw({ "true": { go: 2 }, "false": { go: 0 } })).N,
    baseSwitch,
    "switch.cases is an identity field",
  );

  // propagation: a dependent of an edited node also changes (Merkle fold). A plain
  // implement consumer of the agent picks up the agent's hash change.
  const consumer = (agentNode) => ([
    agentNode,
    { id: "C", type: "implement", name: "C", deps: ["N"], acceptance_criteria: ["x"], design_aspect: "Architecture", max_attempts: 1 },
  ]);
  const baseProp = hashesFor(consumer(agent()));
  const editedProp = hashesFor(consumer(agent({ prompt: "changed" })));
  assert.notEqual(editedProp.N, baseProp.N, "the edited agent's hash changes");
  assert.notEqual(editedProp.C, baseProp.C, "the change propagates downstream to the dependent's hash");
});

test("V16 invalidate: a settled non-implement node whose identity drifted resets to pending and re-runs", () => {
  const { dir, stateDir } = ws();
  // an fn node + an independent implement `trigger` we dispatch to ride a commit.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      { id: "F", type: "fn", deps: [], module: "./reduce.mjs", export: "run", output_schema: { type: "object" } },
      task("trigger"),
    ],
  }).stdout.trim();

  // mark F settled (done) and plant a drift on the field invalidation reads
  // (doneHash), the same black-box mechanism the V-SI tests use. recompute will
  // reproduce F's real contentHash, which then diverges from the planted doneHash.
  let state = readState(stateDir, id);
  state.tasks.F.status = "done";
  state.tasks.F.doneHash = "feedface".repeat(8); // 64-hex, != recomputed contentHash
  writeState(stateDir, id, state);

  const d = run(stateDir, ["dispatch", "--id", id, "--node", "trigger.impl"]); // ride a commit
  assert.equal(d.status, 0, d.stderr);

  state = readState(stateDir, id);
  assert.equal(state.tasks.F.status, "pending", "a drifted settled fn resets to pending (re-run), driven off status not type");
  assert.equal(state.tasks.F.doneHash, undefined, "doneHash cleared on reset");
});

// --- combinator re-expand teardown (V19) ------------------------------------
// When invalidateStale re-readies an already-expanded combinator (expand/switch/
// loop), it FIRST removes that node's previously generated children/branches and
// their generated descendants, so the re-run reproduces one clean acyclic shape
// with no orphaned or duplicated generated nodes. The expand/switch runtime is a
// later task, so the generated children are planted directly into state (the
// black-box mechanism the other invalidation tests use), tagged generatedBy.

test("V19 invalidate: re-readying an already-expanded combinator tears down its generated children and their descendants", () => {
  const { dir, stateDir } = ws();
  // E is an expand node (authored); trigger is an independent implement we dispatch
  // to ride a commit that runs invalidateStale.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      { id: "E", type: "expand", deps: [], over: "src", template: { type: "string" }, gather: "G" },
      task("trigger"),
    ],
  }).stdout.trim();

  // Plant E as already-expanded (status done, doneHash recorded at its expansion)
  // with a drift, plus two generated descendants: a child E__0 (implement, with an
  // impl subnode to prove SUBNODE teardown) tagged generatedBy E, and a grandchild
  // E__0__0 (fn) tagged generatedBy E__0 to prove TRANSITIVE task teardown.
  let state = readState(stateDir, id);
  state.tasks.E.status = "done";
  state.tasks.E.doneHash = "0badf00d".repeat(8); // 64-hex, != recomputed contentHash -> stale
  state.tasks.E__0 = {
    type: "implement", deps: ["E"], executor: "subagent(general-purpose)",
    status: "done", attempts: 0, generation: 0, lastReason: null, generatedBy: "E",
    name: "child 0", acceptance_criteria: ["does element 0"], design_aspect: "Architecture", max_attempts: 1, human_gate: false,
  };
  state.subnodes["E__0.impl"] = { task: "E__0", role: "impl", status: "done", executor: "subagent(general-purpose)" };
  state.tasks.E__0__0 = {
    type: "fn", deps: ["E__0"], status: "pending", attempts: 0, generation: 0, lastReason: null, generatedBy: "E__0",
    module: "./m.mjs", export: "run", output_schema: { type: "object" },
  };
  writeState(stateDir, id, state);

  const d = run(stateDir, ["dispatch", "--id", id, "--node", "trigger.impl"]); // ride a commit
  assert.equal(d.status, 0, d.stderr);

  state = readState(stateDir, id);
  // the whole generated subtree is gone (transitively), with no orphans
  assert.ok(!("E__0" in state.tasks), "the generated child task is removed");
  assert.ok(!("E__0__0" in state.tasks), "the generated grandchild is removed (transitive teardown)");
  assert.ok(!("E__0.impl" in state.subnodes), "the generated child's subnode is removed");
  // the combinator is reset to re-expand cleanly
  assert.equal(state.tasks.E.status, "pending", "the re-readied combinator resets to pending");
  assert.equal(state.tasks.E.doneHash, undefined, "the combinator's expansion hash is cleared on teardown");
  // no surviving task references a removed child (no dangling deps left behind)
  for (const [tid, t] of Object.entries(state.tasks)) {
    for (const dep of t.deps || []) {
      assert.ok(tid !== dep && dep in state.tasks, `surviving task ${tid} has no dangling dep (${dep})`);
    }
  }
});

// --- task-level graph-mutation commands (V-TC) -----------------------------
// SpawnTask / RemoveTask / AddDep / RemoveDep are a CAPABILITY routed through the
// single validated commit. These prove they insert/remove tasks and edges, that
// the three rejection cases (incomplete spec, cycle-creating add-dep, remove with
// dependents) leave state byte-unchanged and exit non-zero, and that removing a
// leaf whose executor is exclusive prints the dangling RELEASE owner line. No
// automatic caller exists — every command here is invoked manually by the test.

// A complete folded-graph node body (everything but the id), suitable as --spec.
// It is an `implement` node body, matching the type the dump and explode author.
function specBody(over = {}) {
  return {
    type: "implement",
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

// The exclusive executor now lives on an AUDIT subnode (the audit-resolver picks a
// specialized executor at runtime), since implement is general-purpose-only. We
// reach it via the resolve --panel path: complete X.impl, resolve a panel whose
// auditor uses subagent(amplify:computer-use), and the exclusive lock is owned by
// X.audit.0. This helper drives a single task X to that mid-audit state.
const EXCLUSIVE_PANEL = panel([{ focus: "gui", executor: "subagent(amplify:computer-use)" }]);
function driveToExclusiveAudit(stateDir, id, t = "X") {
  run(stateDir, ["complete", "--id", id, "--node", `${t}.impl`]);
  run(stateDir, ["resolve", "--id", id, "--node", `${t}.resolve`, "--panel", EXCLUSIVE_PANEL]);
}

test("V-TC.3 remove-task: a leaf whose AUDIT subnode is exclusive prints the dangling RELEASE owner line", () => {
  const { dir, stateDir } = ws();
  // X is a general-purpose implement leaf; its audit panel uses the exclusive
  // computer-use executor (a host-global lock). keep stays so the graph is non-empty.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [task("X"), task("keep")],
  }).stdout.trim();
  driveToExclusiveAudit(stateDir, id, "X");
  // confirm the audit subnode carries the exclusive executor
  let state = readState(stateDir, id);
  assert.equal(state.subnodes["X.audit.0"].executor, "subagent(amplify:computer-use)");
  const runId = state.runId;

  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "X"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^RELEASE ${runId}:X\\.audit\\.0$`, "m"),
    "remove-task reports the dangling exclusive-lock owner as RELEASE <runId>:<subnode>");
  state = readState(stateDir, id);
  assert.ok(!("X" in state.tasks), "the leaf is removed");
  assert.ok(!("X.audit.0" in state.subnodes), "its exclusive audit subnode is gone");
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

test("V-RT.1 remove-task: a rejected removal (last task, exclusive audit) emits no RELEASE and writes no state", () => {
  const { dir, stateDir } = ws();
  // Single task whose audit subnode is exclusive; removing it empties the graph ->
  // validateGraph rejects, so the RELEASE for the exclusive audit must NOT be printed.
  const id = init(stateDir, dir, { version: 1, nodes: [task("only")] }).stdout.trim();
  driveToExclusiveAudit(stateDir, id, "only");
  assert.equal(readState(stateDir, id).subnodes["only.audit.0"].executor, "subagent(amplify:computer-use)");
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
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("keep")] }).stdout.trim();
  driveToExclusiveAudit(stateDir, id, "A");
  run(stateDir, ["dispatch", "--id", id, "--node", "A.audit.0"]); // A.audit.0 -> running (exclusive)
  const raw = readFileSync(join(stateDir, `${id}.json`), "utf8");
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A"]);
  assert.notEqual(r.status, 0, "removing a task with a running subnode must be refused without --force");
  assert.match(r.stderr, /running/, "the refusal explains the running subnode");
  assert.match(r.stderr, /A\.audit\.0/, "the refusal names the running subnode");
  assert.doesNotMatch(r.stdout, /RELEASE/, "a refused removal emits no RELEASE");
  assert.equal(readFileSync(join(stateDir, `${id}.json`), "utf8"), raw,
    "a refused remove-task writes no state (byte-for-byte unchanged)");
});

test("V-RT.3 remove-task: --force removes a running task, warns on stderr, and RELEASEs after commit", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("keep")] }).stdout.trim();
  const runId = readState(stateDir, id).runId;
  driveToExclusiveAudit(stateDir, id, "A");
  run(stateDir, ["dispatch", "--id", id, "--node", "A.audit.0"]); // A.audit.0 -> running (exclusive)
  const r = run(stateDir, ["remove-task", "--id", id, "--task-id", "A", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^RELEASE ${runId}:A\\.audit\\.0$`, "m"),
    "RELEASE is emitted (after commit) for the exclusive running subnode");
  assert.match(r.stderr, /orphaning/, "a stderr warning flags the orphaned in-flight work");
  assert.match(r.stderr, /A\.audit\.0/, "the warning names the orphaned subnode");
  const state = readState(stateDir, id);
  assert.ok(!("A" in state.tasks), "the force-removed task is gone");
  assert.ok(!("A.audit.0" in state.subnodes), "its running subnode is gone");
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

// Start a background `wait-for-free`; resolve `released` when it prints RELEASED (or exits).
function startWaitForFree(stateDir, resources, extra = ["--interval", "1"]) {
  const child = spawn("node", [ENGINE, "wait-for-free", "--resource", resources, ...extra], {
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

test("active: classifies dispatchable and resource-blocked ready work", { skip: !PERL_OK }, async () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B")] });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  run(stateDir, ["resolve", "--id", id, "--node", "A.resolve", "--panel", panel([
    { focus: "computer", executor: "subagent(amplify:computer-use)" },
  ])]);

  const free = JSON.parse(run(stateDir, ["active", "--id", id, "--json"]).stdout)[0];
  assert.equal(free.ready, 2);
  assert.equal(free.dispatchableReady, 2);
  assert.equal(free.resourceBlockedReady, 0);
  assert.deepEqual(free.blockedResources, []);

  const holder = startHold(stateDir, "computer-use", "external-owner");
  assert.equal(await holder.first, "HELD");
  const held = JSON.parse(run(stateDir, ["active", "--id", id, "--json"]).stdout)[0];
  assert.equal(held.ready, 2);
  assert.equal(held.dispatchableReady, 1);
  assert.equal(held.resourceBlockedReady, 1);
  assert.deepEqual(held.blockedResources, ["computer-use"]);

  run(stateDir, ["dispatch", "--id", id, "--node", "B.impl"]);
  const onlyBlocked = JSON.parse(run(stateDir, ["active", "--id", id, "--json"]).stdout)[0];
  assert.equal(onlyBlocked.ready, 1);
  assert.equal(onlyBlocked.running, 1);
  assert.equal(onlyBlocked.dispatchableReady, 0);
  assert.equal(onlyBlocked.resourceBlockedReady, 1);

  killHold(holder);
  await delay(400);
  const stale = JSON.parse(run(stateDir, ["active", "--id", id, "--json"]).stdout)[0];
  assert.equal(stale.ready, 1);
  assert.equal(stale.dispatchableReady, 1);
  assert.equal(stale.resourceBlockedReady, 0);
  assert.deepEqual(stale.blockedResources, []);
});

test("wait-for-free: returns immediately when the resource is free", () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const r = run(stateDir, ["wait-for-free", "--resource", "computer-use", "--interval", "1"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^RELEASED computer-use/m);
});

test("wait-for-free: blocks while held, returns RELEASED when the holder dies", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "sessX:T");   // simulate an external holder
  assert.equal(await a.first, "HELD");
  const wf = startWaitForFree(stateDir, "computer-use");
  // still waiting while held
  assert.equal(await Promise.race([wf.released.then(() => "R"), delay(800).then(() => "W")]), "W");
  killHold(a);                                                // external release
  assert.equal(await wf.released, "RELEASED");
});

test("wait-for-free: comma-separated returns when ANY listed resource frees", { skip: !PERL_OK }, async () => {
  const { stateDir } = ws(); ensureDir(stateDir);
  const a = startHold(stateDir, "computer-use", "X");
  const b = startHold(stateDir, "chrome-devtools", "Y");
  assert.equal(await a.first, "HELD");
  assert.equal(await b.first, "HELD");
  const wf = startWaitForFree(stateDir, "computer-use,chrome-devtools");
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
  const r = init(stateDir, dir, { version: 1, nodes: [{ id: "A", type: "implement", name: "A", deps: [], acceptance_criteria: ["x"], max_attempts: 1 }] });
  assert.notEqual(r.status, 0, "expected non-zero exit for missing design_aspect");
  assert.match(r.stderr, /design_aspect/);
});

// ---------------------------------------------------------------------------
// V1: new node types — agent, fn, expand, switch + output_schema
// ---------------------------------------------------------------------------

test("V1 agent: a complete agent node validates (executor, prompt, output_schema, max_attempts)", () => {
  const { dir, stateDir } = ws();
  const agentNode = {
    id: "A", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Summarise the research findings.",
    output_schema: { type: "string" },
    max_attempts: 2,
  };
  const r = init(stateDir, dir, { version: 1, nodes: [agentNode] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.equal(state.tasks.A.type, "agent", "agent type persists on the task record");
  assert.deepEqual(state.tasks.A.output_schema, { type: "string" });
  assert.equal(state.tasks.A.prompt, "Summarise the research findings.");
});

test("V1 agent: output_schema with enum validates and persists", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [{
    id: "A", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Classify the sentiment.",
    output_schema: { type: "string", enum: ["positive", "negative", "neutral"] },
    max_attempts: 1,
  }] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.deepEqual(state.tasks.A.output_schema.enum, ["positive", "negative", "neutral"]);
});

test("V1 agent: boolean output_schema validates", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [{
    id: "A", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Should we proceed?",
    output_schema: { type: "boolean" },
    max_attempts: 1,
  }] });
  assert.equal(r.status, 0, r.stderr);
});

test("V1 fn: a complete fn node validates (module, export, output_schema)", () => {
  const { dir, stateDir } = ws();
  const fnNode = {
    id: "F", type: "fn", deps: [],
    module: "./reducers/sum.mjs",
    export: "sum",
    output_schema: { type: "integer" },
  };
  const r = init(stateDir, dir, { version: 1, nodes: [fnNode] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.equal(state.tasks.F.type, "fn", "fn type persists");
  assert.equal(state.tasks.F.module, "./reducers/sum.mjs");
  assert.equal(state.tasks.F["export"], "sum");
  assert.deepEqual(state.tasks.F.output_schema, { type: "integer" });
});

test("V1 fn: optional require='all-resolved' validates", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    module: "./gather.mjs",
    export: "gather",
    output_schema: { type: "array" },
    require: "all-resolved",
  }] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.equal(state.tasks.F.require, "all-resolved");
});

test("V1 expand: a complete expand node validates (over, template, gather) with an upstream agent", () => {
  const { dir, stateDir } = ws();
  const agentNode = {
    id: "SRC", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "produce a list of items",
    output_schema: { type: "array" },
    max_attempts: 1,
  };
  const gatherNode = {
    id: "G", type: "fn", deps: [],
    module: "./gather.mjs",
    export: "gather",
    output_schema: { type: "array" },
    require: "all-resolved",
  };
  const expandNode = {
    id: "E", type: "expand", deps: ["SRC"],
    over: "SRC",
    template: { type: "agent", prompt: "process item", output_schema: { type: "string" }, max_attempts: 1 },
    gather: "G",
  };
  const r = init(stateDir, dir, { version: 1, nodes: [agentNode, expandNode, gatherNode] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.equal(state.tasks.E.type, "expand");
  assert.equal(state.tasks.E.over, "SRC");
  assert.equal(state.tasks.E.gather, "G");
  assert.ok(state.tasks.E.template, "template persists");
});

test("V1 switch (boolean): switch with boolean selector and exhaustive {true,false} cases validates", () => {
  const { dir, stateDir } = ws();
  const selectorNode = {
    id: "SEL", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Should we retry?",
    output_schema: { type: "boolean" },
    max_attempts: 1,
  };
  const switchNode = {
    id: "SW", type: "switch", deps: ["SEL"],
    over: "SEL",
    cases: {
      "true": { type: "agent", prompt: "retry" },
      "false": { type: "fn", module: "./done.mjs", export: "done" },
    },
  };
  const r = init(stateDir, dir, { version: 1, nodes: [selectorNode, switchNode] });
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, r.stdout.trim());
  assert.equal(state.tasks.SW.type, "switch");
  assert.equal(state.tasks.SW.over, "SEL");
});

test("V1 switch (enum): switch with enum selector and exhaustive cases validates", () => {
  const { dir, stateDir } = ws();
  const selectorNode = {
    id: "CLS", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Classify.",
    output_schema: { type: "string", enum: ["pass", "fail", "skip"] },
    max_attempts: 1,
  };
  const switchNode = {
    id: "SW", type: "switch", deps: ["CLS"],
    over: "CLS",
    cases: {
      "pass": { type: "fn", module: "./pass.mjs", export: "handle" },
      "fail": { type: "fn", module: "./fail.mjs", export: "handle" },
      "skip": { type: "fn", module: "./skip.mjs", export: "handle" },
    },
  };
  const r = init(stateDir, dir, { version: 1, nodes: [selectorNode, switchNode] });
  assert.equal(r.status, 0, r.stderr);
});

test("V1 mixed: agent -> fn -> switch graph validates end to end", () => {
  const { dir, stateDir } = ws();
  const agentNode = {
    id: "A", type: "agent", deps: [],
    executor: "subagent(general-purpose)",
    prompt: "Decide pass/fail.",
    output_schema: { type: "string", enum: ["pass", "fail"] },
    max_attempts: 2,
  };
  const fnNode = {
    id: "F", type: "fn", deps: ["A"],
    module: "./transform.mjs",
    export: "transform",
    output_schema: { type: "string", enum: ["pass", "fail"] },
  };
  const switchNode = {
    id: "SW", type: "switch", deps: ["F"],
    over: "F",
    cases: { "pass": {}, "fail": {} },
  };
  const r = init(stateDir, dir, { version: 1, nodes: [agentNode, fnNode, switchNode] });
  assert.equal(r.status, 0, r.stderr);
});

test("V1 unknown type is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [{ id: "A", type: "frobnicate", deps: [], executor: "subagent(general-purpose)" }] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /frobnicate/);
  assert.match(r.stderr, /unknown/i);
});

// V1 rejection cases for new node types
const v1RejectCases = {
  "agent missing prompt": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    output_schema: { type: "boolean" }, max_attempts: 1,
  }] },
  "agent missing output_schema": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do it", max_attempts: 1,
  }] },
  "agent missing max_attempts": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do it", output_schema: { type: "boolean" },
  }] },
  "agent output_schema.type invalid": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do it", output_schema: { type: "frobnicate" }, max_attempts: 1,
  }] },
  "agent output_schema.enum empty": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do it", output_schema: { type: "string", enum: [] }, max_attempts: 1,
  }] },
  "agent output_schema unknown property": { version: 1, nodes: [{
    id: "A", type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "do it", output_schema: { type: "string", description: "hi" }, max_attempts: 1,
  }] },
  "fn missing module": { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    export: "fn", output_schema: { type: "boolean" },
  }] },
  "fn missing export": { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    module: "./m.mjs", output_schema: { type: "boolean" },
  }] },
  "fn missing output_schema": { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    module: "./m.mjs", export: "fn",
  }] },
  "fn invalid require value": { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    module: "./m.mjs", export: "fn", output_schema: { type: "boolean" },
    require: "all-settled",
  }] },
  "fn with executor field (outside template)": { version: 1, nodes: [{
    id: "F", type: "fn", deps: [],
    module: "./m.mjs", export: "fn", output_schema: { type: "boolean" },
    executor: "subagent(general-purpose)",
  }] },
  "expand missing over": { version: 1, nodes: [{
    id: "E", type: "expand", deps: [],
    template: {}, gather: "G",
  }] },
  "expand missing template": { version: 1, nodes: [{
    id: "E", type: "expand", deps: [],
    over: "SRC", gather: "G",
  }] },
  "expand missing gather": { version: 1, nodes: [{
    id: "E", type: "expand", deps: [],
    over: "SRC", template: {},
  }] },
  "switch missing over": { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)", prompt: "p", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], cases: { "true": {}, "false": {} } },
  ] },
  "switch missing cases": { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)", prompt: "p", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL" },
  ] },
};

for (const [label, graph] of Object.entries(v1RejectCases)) {
  test(`V1 reject: ${label}`, () => {
    const { dir, stateDir } = ws();
    const r = init(stateDir, dir, graph);
    assert.notEqual(r.status, 0, `expected non-zero exit for: ${label}`);
    assert.match(r.stderr, /task: /);
    assert.equal(
      readdirSync(stateDir).filter((f) => f.endsWith(".json")).length, 0,
      "a rejected graph writes no state",
    );
  });
}

// ---------------------------------------------------------------------------
// V2: switch exhaustiveness validation
// ---------------------------------------------------------------------------

test("V2 switch: boolean selector with missing 'false' case is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "decide", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { "true": {} } }, // missing 'false'
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing.*false/i, "error names the missing case");
});

test("V2 switch: boolean selector with missing 'true' case is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "decide", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { "false": {} } }, // missing 'true'
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing.*true/i);
});

test("V2 switch: boolean selector with both cases missing is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "decide", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL", cases: {} },
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exhaustively/i);
});

test("V2 switch: boolean selector with extra case (beyond true/false) is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "decide", output_schema: { type: "boolean" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { "true": {}, "false": {}, "maybe": {} } }, // 'maybe' not in domain
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /extra.*maybe/i, "error names the extra unknown case");
});

test("V2 switch: enum selector with missing enum value is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "CLS", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "classify", output_schema: { type: "string", enum: ["pass", "fail", "skip"] }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["CLS"], over: "CLS",
      cases: { "pass": {}, "fail": {} } }, // missing 'skip'
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing.*skip/i);
});

test("V2 switch: enum selector with extra case is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "CLS", type: "fn", deps: [],
      module: "./classify.mjs", export: "classify",
      output_schema: { type: "string", enum: ["a", "b"] } },
    { id: "SW", type: "switch", deps: ["CLS"], over: "CLS",
      cases: { "a": {}, "b": {}, "c": {} } }, // 'c' is not in enum
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /extra.*c/i);
});

test("V2 switch: non-enumerable selector (string type, no enum) is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SEL", type: "agent", deps: [], executor: "subagent(general-purpose)",
      prompt: "produce a string", output_schema: { type: "string" }, max_attempts: 1 },
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { "hello": {}, "world": {} } },
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-enumerable/i, "error flags non-enumerable selector");
});

test("V2 switch: non-enumerable selector (integer type, no enum) is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "CNT", type: "fn", deps: [],
      module: "./count.mjs", export: "count",
      output_schema: { type: "integer" } },
    { id: "SW", type: "switch", deps: ["CNT"], over: "CNT",
      cases: { "0": {}, "1": {} } },
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-enumerable/i);
});

test("V2 switch: selector node with no output_schema is rejected", () => {
  const { dir, stateDir } = ws();
  // implement node (no output_schema) as selector
  const r = init(stateDir, dir, { version: 1, nodes: [
    task("IMPL"),
    { id: "SW", type: "switch", deps: ["IMPL"], over: "IMPL",
      cases: { "true": {}, "false": {} } },
  ] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no output_schema|non-enumerable/i);
});

test("V2 switch: over references unknown node is rejected", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    { id: "SW", type: "switch", deps: [],
      over: "ghost", cases: { "true": {}, "false": {} } },
  ] });
  assert.notEqual(r.status, 0);
  // may be caught by the `over` unknown-node check or missing from deps
  assert.match(r.stderr, /task: /);
});

// ---------------------------------------------------------------------------
// V4: content-addressed value store + by-reference, schema-validated output
// ---------------------------------------------------------------------------
// `complete --output` records a node's output BY REFERENCE: the bytes go to a
// per-run, content-addressed store under the state dir, and only a handle
// (task.outputRef) enters the orchestrator's view. An agent node carries an
// output_schema but the generalized scheduler that would dispatch/settle it is a
// LATER task, so these tests plant a running subnode (the black-box-legal
// state-planting the mvcc/invalidation tests already use) to drive `complete`.

// Plant a running subnode on `taskId` so `complete` has something to settle.
function plantRunning(stateDir, id, taskId, subId = `${taskId}.work`) {
  const state = readState(stateDir, id);
  state.subnodes[subId] = { task: taskId, role: "impl", status: "running" };
  writeState(stateDir, id, state);
  return subId;
}

function agentNode(id, schema, over = {}) {
  return {
    id, type: "agent", deps: [], executor: "subagent(general-purpose)",
    prompt: "produce a value", output_schema: schema, max_attempts: 1, ...over,
  };
}

test("V4 value store: complete --output validates vs output_schema, records BY REFERENCE, and is retrievable", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [agentNode("A", { type: "array" })] }).stdout.trim();
  const subId = plantRunning(stateDir, id, "A");

  const r = run(stateDir, ["complete", "--id", id, "--node", subId, "--output", "[1,2,3]"]);
  assert.equal(r.status, 0, r.stderr);

  // The orchestrator's view holds only a handle, never the bytes.
  const after = readState(stateDir, id);
  const ref = after.tasks.A.outputRef;
  assert.match(ref, /^[0-9a-f]{64}$/, "output is recorded by reference (a content-addressed sha256 handle)");

  // The value bytes live in the per-run content-addressed store, keyed by node id -> handle.
  const valuePath = join(stateDir, "values", id, `${ref}.json`);
  assert.ok(existsSync(valuePath), "the value bytes live in the store under the state dir");
  assert.deepEqual(JSON.parse(readFileSync(valuePath, "utf8")), [1, 2, 3], "the stored output round-trips");
});

test("V4 value store: identical outputs dedupe (content-addressed) to the same handle", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [agentNode("A", { type: "array" }), agentNode("B", { type: "array" })] }).stdout.trim();
  plantRunning(stateDir, id, "A");
  plantRunning(stateDir, id, "B");
  run(stateDir, ["complete", "--id", id, "--node", "A.work", "--output", "[1,2,3]"]);
  run(stateDir, ["complete", "--id", id, "--node", "B.work", "--output", "[1,2,3]"]);
  const st = readState(stateDir, id);
  assert.equal(st.tasks.A.outputRef, st.tasks.B.outputRef, "equal outputs share one content-addressed handle");
  assert.deepEqual(readdirSync(join(stateDir, "values", id)), [`${st.tasks.A.outputRef}.json`],
    "only one value file exists for the deduped output");
});

test("V4 value store: complete --output rejects a value violating output_schema.type (non-zero, nothing stored)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [agentNode("A", { type: "integer" })] }).stdout.trim();
  const subId = plantRunning(stateDir, id, "A");

  const r = run(stateDir, ["complete", "--id", id, "--node", subId, "--output", '"not-an-integer"']);
  assert.notEqual(r.status, 0, "an output violating output_schema must be rejected");
  assert.match(r.stderr, /output_schema/i);

  const after = readState(stateDir, id);
  assert.equal(after.tasks.A.outputRef, undefined, "a rejected output is NOT recorded by reference");
  assert.equal(after.subnodes[subId].status, "running", "a rejected completion makes no state change");
  const vdir = join(stateDir, "values", id);
  assert.deepEqual(existsSync(vdir) ? readdirSync(vdir) : [], [], "no value bytes are stored for a rejected output");
});

test("V4 value store: complete --output rejects a value outside output_schema.enum", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [agentNode("A", { type: "string", enum: ["pass", "fail"] })] }).stdout.trim();
  const subId = plantRunning(stateDir, id, "A");
  const r = run(stateDir, ["complete", "--id", id, "--node", subId, "--output", '"maybe"']);
  assert.notEqual(r.status, 0, "an output outside the enum must be rejected");
  assert.match(r.stderr, /enum/i);
  assert.equal(readState(stateDir, id).tasks.A.outputRef, undefined, "nothing recorded on rejection");
});

// ---------------------------------------------------------------------------
// V11: resolve-context --inputs returns per-dep {status, output?} envelopes
// ---------------------------------------------------------------------------

test("V11 envelopes: resolve-context --inputs distinguishes a failed upstream from a done node with a falsy output", () => {
  const { dir, stateDir } = ws();
  // G depends on three SUCCEEDED deps whose outputs are falsy ([], false, 0) and one
  // FAILED dep. The settle that would set these statuses is a later task, so plant
  // them; write the referenced value files under opaque handles (the read path treats
  // the handle as an opaque filename, so the test need not replicate the hashing).
  const id = init(stateDir, dir, { version: 1, nodes: [
    task("D_EMPTY"), task("D_FALSE"), task("D_ZERO"), task("F_FAIL"),
    task("G", ["D_EMPTY", "D_FALSE", "D_ZERO", "F_FAIL"]),
  ] }).stdout.trim();

  const state = readState(stateDir, id);
  state.tasks.D_EMPTY.status = "done"; state.tasks.D_EMPTY.outputRef = "ref_empty";
  state.tasks.D_FALSE.status = "done"; state.tasks.D_FALSE.outputRef = "ref_false";
  state.tasks.D_ZERO.status = "done"; state.tasks.D_ZERO.outputRef = "ref_zero";
  state.tasks.F_FAIL.status = "failed"; // a failed dep records NO output
  writeState(stateDir, id, state);

  const vdir = join(stateDir, "values", id);
  ensureDir(vdir);
  writeFileSync(join(vdir, "ref_empty.json"), JSON.stringify([]));
  writeFileSync(join(vdir, "ref_false.json"), JSON.stringify(false));
  writeFileSync(join(vdir, "ref_zero.json"), JSON.stringify(0));

  const r = run(stateDir, ["resolve-context", "--id", id, "--node", "G", "--inputs"]);
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);

  // done deps carry their (falsy) output, with the output key PRESENT.
  assert.deepEqual(env.D_EMPTY, { status: "done", output: [] });
  assert.deepEqual(env.D_FALSE, { status: "done", output: false });
  assert.deepEqual(env.D_ZERO, { status: "done", output: 0 });
  // the failed dep is {status:"failed"} with NO output key — distinct from a falsy output.
  assert.deepEqual(env.F_FAIL, { status: "failed" });
  assert.ok(!("output" in env.F_FAIL), "a failed envelope carries NO output key");
  assert.ok("output" in env.D_FALSE && "output" in env.D_ZERO && "output" in env.D_EMPTY,
    "a done envelope carries the output key even when the value is falsy");
});

test("V4+V11 round-trip: complete --output stores by reference; a downstream resolve-context --inputs reads it back", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [
    agentNode("UP", { type: "array" }),
    agentNode("DOWN", { type: "string" }, { deps: ["UP"] }),
  ] }).stdout.trim();

  // record UP's output through the real complete --output path (content-addressed store write)
  plantRunning(stateDir, id, "UP");
  const c = run(stateDir, ["complete", "--id", id, "--node", "UP.work", "--output", '["x","y"]']);
  assert.equal(c.status, 0, c.stderr);

  // mark UP done (the settle that does this is a later task; plant it)
  let state = readState(stateDir, id);
  assert.match(state.tasks.UP.outputRef, /^[0-9a-f]{64}$/, "complete recorded UP's output by reference");
  state.tasks.UP.status = "done";
  writeState(stateDir, id, state);

  // DOWN fetches its inputs as envelopes — UP's output round-trips through the store,
  // with no hardcoded handle (the handle came from the real store write above).
  const r = run(stateDir, ["resolve-context", "--id", id, "--node", "DOWN", "--inputs"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { UP: { status: "done", output: ["x", "y"] } });
});

test("V11 envelopes: resolve-context (no --inputs) still dumps the resolver context (back-compat)", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { design_aspect: "Architecture" })] }).stdout.trim();
  const r = run(stateDir, ["resolve-context", "--id", id, "--node", "A"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TASK NAME: Task A/, "the default (dump) behavior is unchanged when --inputs is absent");
});

// ---------------------------------------------------------------------------
// V3: type-driven scheduling of the flat node kinds (agent/fn/expand/switch)
// ---------------------------------------------------------------------------
// readySet now decides readiness from a node's TYPE for the generalized flat kinds,
// ADDED ALONGSIDE the preserved legacy IMPL/RESOLVE/AUDIT subnode branches (all the
// tests above still exercise that legacy lifecycle). A flat node has no subnode, so
// `ready` reports a ready one by its TASK id. The settle path that would set a flat
// node to "done"/give it an outputRef belongs to later tasks, so these tests plant
// those statuses by editing the persisted state JSON — the same black-box-legal
// mechanism the mvcc/invalidation/envelope tests already use.

// Convenience constructors for valid flat nodes.
function flatAgent(id, schema, deps = []) {
  return { id, type: "agent", deps, executor: "subagent(general-purpose)",
    prompt: `produce ${id}`, output_schema: schema, max_attempts: 1 };
}
function flatFn(id, deps = [], over = {}) {
  return { id, type: "fn", deps, module: `./${id}.mjs`, export: "run",
    output_schema: { type: "array" }, ...over };
}

test("V3 schedule: flat agent/fn/expand/switch nodes ready by TYPE in dependency order", () => {
  const { dir, stateDir } = ws();
  const nodes = [
    flatAgent("SRC", { type: "array" }),     // source list (no deps -> ready at init)
    flatAgent("FLAG", { type: "boolean" }),  // switch selector (no deps -> ready at init)
    flatFn("PROC", ["SRC"]),                 // plain fn (all-done): waits for SRC done
    flatFn("GATH", [], { require: "all-resolved" }), // gather target (no deps)
    { id: "EXP", type: "expand", deps: ["SRC"], over: "SRC",
      template: { type: "agent", prompt: "item", output_schema: { type: "string" }, max_attempts: 1 },
      gather: "GATH" },
    { id: "SW", type: "switch", deps: ["FLAG"], over: "FLAG",
      cases: { "true": {}, "false": {} } },
  ];
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();

  // init: the two no-dep agents (SRC, FLAG) and the no-dep all-resolved reducer
  // (GATH, vacuously resolved) are ready; PROC waits on SRC done; EXP/SW wait on
  // their upstream's OUTPUT.
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["FLAG", "GATH", "SRC"]);

  // SRC done but WITHOUT an outputRef: the plain fn PROC (all-done) readies; the
  // expand EXP does NOT (it needs the upstream's output to fan out over).
  let state = readState(stateDir, id);
  state.tasks.SRC.status = "done"; // no outputRef yet
  writeState(stateDir, id, state);
  let ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.ok(ready.includes("PROC"), "a plain (all-done) fn readies once its dep is done");
  assert.ok(!ready.includes("EXP"), "expand does NOT ready on a done upstream that has no outputRef");

  // give SRC an outputRef -> EXP readies (its single upstream's output now exists)
  state = readState(stateDir, id);
  state.tasks.SRC.outputRef = "src-ref";
  writeState(stateDir, id, state);
  ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.ok(ready.includes("EXP"), "expand readies once its upstream is done WITH an outputRef");

  // FLAG done WITH an outputRef -> the switch SW readies on its selector's output
  state = readState(stateDir, id);
  state.tasks.FLAG.status = "done"; state.tasks.FLAG.outputRef = "flag-ref";
  writeState(stateDir, id, state);
  ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.ok(ready.includes("SW"), "switch readies once its selector is done WITH an outputRef");
});

test("V3 schedule: a reducer fn (require=all-resolved) readies once every dep is resolved (done|failed)", () => {
  const { dir, stateDir } = ws();
  const nodes = [
    flatAgent("A", { type: "string" }),
    flatAgent("B", { type: "string" }),
    flatFn("RED", ["A", "B"], { require: "all-resolved" }), // reducer/gather
    flatFn("PLAIN", ["A", "B"]),                            // all-done (default)
  ];
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();

  // init: only the two source agents are ready; neither fn is (deps unresolved).
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["A", "B"]);

  // A done, B FAILED.
  let state = readState(stateDir, id);
  state.tasks.A.status = "done";
  state.tasks.B.status = "failed";
  writeState(stateDir, id, state);
  const ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  // the reducer readies despite B failing; the plain all-done fn does NOT (it would
  // otherwise run on a missing/failed input).
  assert.ok(ready.includes("RED"), "an all-resolved reducer readies once deps are done|failed");
  assert.ok(!ready.includes("PLAIN"), "an all-done plain fn does NOT ready while a dep is failed");
});

test("V3 schedule: a switch readies only once its selector is done WITH an outputRef", () => {
  const { dir, stateDir } = ws();
  const nodes = [
    flatAgent("SEL", { type: "boolean" }),
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { "true": {}, "false": {} } },
  ];
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();
  // selector ready, switch not.
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["SEL"]);

  // selector DONE but no outputRef -> switch still not ready (no selector value yet).
  let state = readState(stateDir, id);
  state.tasks.SEL.status = "done";
  writeState(stateDir, id, state);
  assert.ok(!ids(run(stateDir, ["ready", "--id", id]).stdout).includes("SW"),
    "switch is not ready until its selector output exists");

  // add the outputRef -> switch readies.
  state = readState(stateDir, id);
  state.tasks.SEL.outputRef = "sel-ref";
  writeState(stateDir, id, state);
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("SW"),
    "switch readies once its selector is done with an outputRef");
});

test("V3 schedule: legacy implement subnodes and flat-kind nodes schedule side by side", () => {
  const { dir, stateDir } = ws();
  // One legacy implement node (explodes to IMPL.impl/IMPL.resolve subnodes) and one
  // flat agent node, in the same graph: proves the type-driven flat scheduling is
  // ADDED ALONGSIDE the preserved legacy lifecycle, not replacing it.
  const id = init(stateDir, dir, { version: 1, nodes: [
    task("IMPL"),
    flatAgent("AG", { type: "string" }),
  ] }).stdout.trim();

  // both ready: the legacy impl subnode (IMPL.impl) AND the flat agent task (AG).
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["AG", "IMPL.impl"]);
  // the flat agent emits its task-record executor on the ready line.
  assert.ok(lines(run(stateDir, ["ready", "--id", id]).stdout).includes("AG\tsubagent(general-purpose)"),
    "a ready flat agent carries its executor from the task record");

  // the legacy lifecycle still drives forward through a real commit: completing
  // IMPL.impl readies IMPL.resolve, with the flat agent still ready beside it.
  assert.deepEqual(ids(run(stateDir, ["complete", "--id", id, "--node", "IMPL.impl"]).stdout),
    ["AG", "IMPL.resolve"]);
});

// ---------------------------------------------------------------------------
// V5: exec-node runs a deterministic fn over its input envelopes, validates the
// result vs output_schema, stores it BY REFERENCE, prints ONLY the handle, and
// writes NO engine state. The settle that would mark the upstream deps "done" is a
// later task, so we plant their status/outputRef + value files (the same
// black-box-legal state-planting the V4/V11/V3 tests use). exec-node is invoked as
// a standalone `node task.mjs exec-node` process here, demonstrating it is safe to
// run out-of-process.
// ---------------------------------------------------------------------------

// Write a tiny PURE fn fixture module into the workspace (out of any production
// path) and return its absolute path. Each export is a pure function of the input
// envelopes {depId: {status, output?}}.
function writeFnFixture(dir) {
  ensureDir(dir);
  const p = join(dir, "fns.mjs");
  writeFileSync(p, [
    "// Test fixtures for exec-node (V5). Pure functions over input envelopes.",
    "export function sum(inputs) {",
    "  let total = 0;",
    "  for (const env of Object.values(inputs)) {",
    "    if (env && env.status === 'done') total += env.output;",
    "  }",
    "  return total;",
    "}",
    "export function badType() { return 'not-an-integer'; } // violates an integer schema",
    "export function entropy() {",
    "  // A pure fn must not read these; exec-node stubs both to 0 so the result is",
    "  // deterministic. With the stubs in place this returns 0 on every run.",
    "  return Date.now() + Math.random();",
    "}",
    "",
  ].join("\n"));
  return p;
}

// Plant a dep as done with a stored output value (opaque handle, like the V11 test).
function plantDoneOutput(stateDir, id, taskId, value, handle = `ref_${taskId}`) {
  const state = readState(stateDir, id);
  state.tasks[taskId].status = "done";
  state.tasks[taskId].outputRef = handle;
  writeState(stateDir, id, state);
  const vdir = join(stateDir, "values", id);
  ensureDir(vdir);
  writeFileSync(join(vdir, `${handle}.json`), JSON.stringify(value));
}

test("V5 exec-node: a fn that sums its inputs stores the correct output and prints ONLY the handle", () => {
  const { dir, stateDir } = ws();
  const mod = writeFnFixture(dir);
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("A", { type: "integer" }),
    flatAgent("B", { type: "integer" }),
    { id: "F", type: "fn", deps: ["A", "B"], module: mod, export: "sum", output_schema: { type: "integer" } },
  ] }).stdout.trim();

  plantDoneOutput(stateDir, id, "A", 2);
  plantDoneOutput(stateDir, id, "B", 3);

  const r = run(stateDir, ["exec-node", "--id", id, "--node", "F"]);
  assert.equal(r.status, 0, r.stderr);

  // prints ONLY the handle: a single 64-hex line on stdout, nothing else.
  const out = lines(r.stdout);
  assert.equal(out.length, 1, "exec-node prints exactly one line");
  const handle = out[0];
  assert.match(handle, /^[0-9a-f]{64}$/, "the printed line is a content-addressed sha256 handle");

  // the value bytes are in the per-run store under the printed handle, and equal the sum.
  const valuePath = join(stateDir, "values", id, `${handle}.json`);
  assert.ok(existsSync(valuePath), "the fn output is written to the value store by reference");
  assert.equal(JSON.parse(readFileSync(valuePath, "utf8")), 5, "sum(2,3) === 5 round-trips through the store");
});

test("V5 exec-node: an output violating output_schema is rejected non-zero and stores nothing", () => {
  const { dir, stateDir } = ws();
  const mod = writeFnFixture(dir);
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("A", { type: "integer" }),
    // declares an integer output but the export returns a string -> must be rejected.
    { id: "F", type: "fn", deps: ["A"], module: mod, export: "badType", output_schema: { type: "integer" } },
  ] }).stdout.trim();
  plantDoneOutput(stateDir, id, "A", 1);

  const r = run(stateDir, ["exec-node", "--id", id, "--node", "F"]);
  assert.notEqual(r.status, 0, "an output violating output_schema must be rejected non-zero");
  assert.match(r.stderr, /output_schema/i, "the rejection names output_schema");
  assert.equal(r.stdout.trim(), "", "no handle is printed on rejection");

  // nothing new is stored: only the planted dep value (ref_A) exists in the store.
  const vdir = join(stateDir, "values", id);
  assert.deepEqual(readdirSync(vdir).sort(), ["ref_A.json"], "no value bytes are stored for a rejected output");
});

test("V5 exec-node: writes NO engine state (the orchestrator commits separately)", () => {
  const { dir, stateDir } = ws();
  const mod = writeFnFixture(dir);
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("A", { type: "integer" }),
    flatAgent("B", { type: "integer" }),
    { id: "F", type: "fn", deps: ["A", "B"], module: mod, export: "sum", output_schema: { type: "integer" } },
  ] }).stdout.trim();
  plantDoneOutput(stateDir, id, "A", 4);
  plantDoneOutput(stateDir, id, "B", 6);

  const statePath = join(stateDir, `${id}.json`);
  const before = readFileSync(statePath, "utf8");
  const r = run(stateDir, ["exec-node", "--id", id, "--node", "F"]);
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(statePath, "utf8");
  assert.equal(after, before, "exec-node is READ-ONLY on engine state: the state file is byte-unchanged");

  // F is NOT advanced to done and gets NO outputRef from exec-node (commit is separate).
  const state = readState(stateDir, id);
  assert.equal(state.tasks.F.status, "pending", "exec-node does not settle the fn node");
  assert.equal(state.tasks.F.outputRef, undefined, "exec-node does not record the output onto engine state");
});

test("V5 exec-node: a failed upstream surfaces as a {status:failed} envelope (distinct from a falsy output)", () => {
  const { dir, stateDir } = ws();
  const mod = writeFnFixture(dir);
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("OK", { type: "integer" }),
    flatAgent("BAD", { type: "integer" }),
    // sum ignores failed envelopes, so a failed BAD contributes 0 (not a crash).
    { id: "F", type: "fn", deps: ["OK", "BAD"], module: mod, export: "sum", output_schema: { type: "integer" } },
  ] }).stdout.trim();
  plantDoneOutput(stateDir, id, "OK", 7);
  // BAD failed: no outputRef, no value file.
  const state = readState(stateDir, id);
  state.tasks.BAD.status = "failed";
  writeState(stateDir, id, state);

  const r = run(stateDir, ["exec-node", "--id", id, "--node", "F"]);
  assert.equal(r.status, 0, r.stderr);
  const handle = lines(r.stdout)[0];
  assert.equal(JSON.parse(readFileSync(join(stateDir, "values", id, `${handle}.json`), "utf8")), 7,
    "the fn reads {status:failed} for BAD and sums only the done OK envelope");
});

test("V5 exec-node: purity stubs Date.now/Math.random so the body is deterministic", () => {
  const { dir, stateDir } = ws();
  const mod = writeFnFixture(dir);
  const id = init(stateDir, dir, { version: 1, nodes: [
    { id: "F", type: "fn", deps: [], module: mod, export: "entropy", output_schema: { type: "integer" } },
  ] }).stdout.trim();

  const r = run(stateDir, ["exec-node", "--id", id, "--node", "F"]);
  assert.equal(r.status, 0, r.stderr);
  const handle = lines(r.stdout)[0];
  // Date.now()+Math.random() would be a huge run-varying float without the stubs;
  // with both stubbed to 0 the result is a deterministic 0 (a valid integer).
  assert.equal(JSON.parse(readFileSync(join(stateDir, "values", id, `${handle}.json`), "utf8")), 0,
    "Date.now and Math.random are neutralized to 0 while the fn body runs");
});

test("V5 exec-node: rejects a non-fn node and an unknown node", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [
    task("IMPL"),
    flatAgent("AG", { type: "string" }),
  ] }).stdout.trim();
  const onImplement = run(stateDir, ["exec-node", "--id", id, "--node", "IMPL"]);
  assert.notEqual(onImplement.status, 0, "exec-node refuses a non-fn (implement) node");
  const onAgent = run(stateDir, ["exec-node", "--id", id, "--node", "AG"]);
  assert.notEqual(onAgent.status, 0, "exec-node refuses a non-fn (agent) node");
  const onGhost = run(stateDir, ["exec-node", "--id", id, "--node", "ghost"]);
  assert.notEqual(onGhost.status, 0, "exec-node refuses an unknown node");
  assert.match(onGhost.stderr, /unknown node/i);
});

// ---------------------------------------------------------------------------
// V17: the runId-scoped single-writer COMMIT LOCK
// ---------------------------------------------------------------------------
// Two concurrent `complete` writes to ONE GRAPH_ID must SERIALIZE under the runId
// commit lock so NEITHER update is lost. Each process loads the state, records its
// node's output by reference, and persists; WITHOUT the lock the later saveState
// would clobber the earlier writer's outputRef (the classic lost update). The lock
// plus commit's under-lock re-read make BOTH land regardless of interleaving. The
// lock degrades to lock-free without perl (flock), so the guarantee is perl-gated
// exactly like the other flock tests.

// Run `complete --output` as its OWN process, async, so several overlap their
// read-modify-write windows. Resolves with {status, stdout, stderr} on exit.
function completeAsync(stateDir, id, node, outputJson) {
  const child = spawn("node", [ENGINE, "complete", "--id", id, "--node", node, "--output", outputJson], {
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { err += d.toString(); });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

test("V17 commit lock: two concurrent complete writes to one GRAPH_ID both land (no lost update)", { skip: !PERL_OK }, async () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [
    agentNode("A", { type: "array" }),
    agentNode("B", { type: "array" }),
  ] }).stdout.trim();
  // Plant a running subnode on each so `complete --output` settles it AND records
  // the output by reference (the dispatch/settle wiring for flat nodes is a later
  // task; this is the black-box-legal state-planting the V4 tests use).
  plantRunning(stateDir, id, "A");
  plantRunning(stateDir, id, "B");

  // Fire BOTH completions concurrently against the SAME graph; their read-modify-
  // write windows overlap, so without serialization one outputRef gets clobbered.
  const [ra, rb] = await Promise.all([
    completeAsync(stateDir, id, "A.work", "[1,2,3]"),
    completeAsync(stateDir, id, "B.work", "[4,5,6]"),
  ]);
  assert.equal(ra.status, 0, ra.stderr);
  assert.equal(rb.status, 0, rb.stderr);

  // BOTH updates landed: each task carries its own content-addressed handle and
  // each planted subnode settled to done — neither writer's update was lost.
  const st = readState(stateDir, id);
  assert.match(st.tasks.A.outputRef ?? "", /^[0-9a-f]{64}$/, "A's output landed (not lost)");
  assert.match(st.tasks.B.outputRef ?? "", /^[0-9a-f]{64}$/, "B's output landed (not lost)");
  assert.equal(st.subnodes["A.work"].status, "done", "A.work settled to done");
  assert.equal(st.subnodes["B.work"].status, "done", "B.work settled to done");
  // and the value bytes round-trip from the per-run content-addressed store.
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "values", id, `${st.tasks.A.outputRef}.json`), "utf8")), [1, 2, 3]);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "values", id, `${st.tasks.B.outputRef}.json`), "utf8")), [4, 5, 6]);
});

test("V17 commit lock: N concurrent complete writes to one GRAPH_ID all land (stress)", { skip: !PERL_OK }, async () => {
  const { dir, stateDir } = ws();
  const N = 6;
  const nodeIds = Array.from({ length: N }, (_, i) => `N${i}`);
  const id = init(stateDir, dir, {
    version: 1,
    nodes: nodeIds.map((nid) => agentNode(nid, { type: "integer" })),
  }).stdout.trim();
  for (const nid of nodeIds) plantRunning(stateDir, id, nid);

  // Launch all N completions at once; each records a distinct integer output.
  const results = await Promise.all(
    nodeIds.map((nid, i) => completeAsync(stateDir, id, `${nid}.work`, String(i * 10))),
  );
  for (const r of results) assert.equal(r.status, 0, r.stderr);

  // Every writer's update survives: all N tasks have an outputRef and every value
  // round-trips to the integer that writer wrote — a single dropped commit would
  // leave one of these undefined.
  const st = readState(stateDir, id);
  for (let i = 0; i < N; i++) {
    const ref = st.tasks[nodeIds[i]].outputRef;
    assert.match(ref ?? "", /^[0-9a-f]{64}$/, `${nodeIds[i]}'s output landed (not lost)`);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "values", id, `${ref}.json`), "utf8")), i * 10);
    assert.equal(st.subnodes[`${nodeIds[i]}.work`].status, "done", `${nodeIds[i]}.work settled`);
  }
});

// ---------------------------------------------------------------------------
// V6 / V3: the expand (fan-out) combinator
// ---------------------------------------------------------------------------
// When an expand node's upstream output exists, `expand --node E` reads the `over`
// list and, in ONE commit, creates one child from `template` per element, binds each
// child to its element BY REFERENCE (a per-element value-store entry), wires each
// child to `gather`, and tags it generatedBy the expand node. The settle that marks
// the upstream `over` node "done"/gives it an outputRef is a later task, so these
// tests plant that status + the list value file (the same black-box-legal mechanism
// the V3/V4/V5 scheduler/store tests use; the read path treats the handle as an
// opaque filename, so the test need not replicate the content hashing).

// A standalone acyclicity check over the live task deps (Kahn's algorithm), so the
// V3 expand test proves the expanded graph has no cycle independent of the engine.
function hasCycle(tasks) {
  const ids = Object.keys(tasks);
  const indeg = new Map(ids.map((i) => [i, (tasks[i].deps || []).filter((d) => tasks[d]).length]));
  const dependents = new Map(ids.map((i) => [i, []]));
  for (const i of ids) for (const d of tasks[i].deps || []) if (tasks[d]) dependents.get(d).push(i);
  const q = ids.filter((i) => indeg.get(i) === 0);
  let seen = 0;
  while (q.length) {
    const i = q.shift();
    seen++;
    for (const dep of dependents.get(i)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) q.push(dep);
    }
  }
  return seen !== ids.length; // a node left unprocessed sits on a cycle
}

// A graph with: SRC (the `over` list source), an expand node E over an agent
// template into the gather G (an all-resolved reducer that depends on E). Returns
// the GRAPH_ID with SRC planted DONE and its list output written to the store.
function expandGraph(stateDir, dir, list, overRef = "src-ref") {
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SRC", { type: "array" }),
    { id: "E", type: "expand", deps: ["SRC"], over: "SRC",
      template: { type: "agent", executor: "subagent(general-purpose)",
        prompt: "process item", output_schema: { type: "string" }, max_attempts: 1 },
      gather: "G" },
    flatFn("G", ["E"], { require: "all-resolved" }),
  ] }).stdout.trim();
  const state = readState(stateDir, id);
  state.tasks.SRC.status = "done";
  state.tasks.SRC.outputRef = overRef;
  writeState(stateDir, id, state);
  const vdir = join(stateDir, "values", id);
  ensureDir(vdir);
  writeFileSync(join(vdir, `${overRef}.json`), JSON.stringify(list));
  return { id, vdir };
}

test("V6 expand: a 3-element list creates 3 children wired to gather, each bound to its element BY REFERENCE, in a single commit", () => {
  const { dir, stateDir } = ws();
  const list = ["alpha", "beta", "gamma"];
  const { id, vdir } = expandGraph(stateDir, dir, list);

  const seqBefore = readState(stateDir, id).commitSeq;
  const r = run(stateDir, ["expand", "--id", id, "--node", "E"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  // the whole fan-out is ONE commit (commitSeq increments exactly once).
  assert.equal(state.commitSeq, seqBefore + 1, "the fan-out is a SINGLE commit");

  // one child per element, each built from the template (an agent), and no extra.
  const childIds = ["E-item-0", "E-item-1", "E-item-2"];
  for (const cid of childIds) {
    assert.ok(cid in state.tasks, `child ${cid} was created`);
    assert.equal(state.tasks[cid].type, "agent", `${cid} is built from the template`);
  }
  assert.ok(!("E-item-3" in state.tasks), "exactly N children created, no more");

  // each child is wired to gather (gather DEPENDS ON it).
  for (const cid of childIds) {
    assert.ok((state.tasks.G.deps || []).includes(cid), `gather depends on ${cid}`);
  }

  // each child is bound to its element BY REFERENCE: a per-element store entry whose
  // bytes equal the element, with only the HANDLE on the child record (no bytes).
  list.forEach((element, i) => {
    const cid = `E-item-${i}`;
    const ref = state.tasks[cid].inputRef;
    assert.match(ref, /^[0-9a-f]{64}$/, `${cid} carries a content-addressed handle, not bytes`);
    const valuePath = join(vdir, `${ref}.json`);
    assert.ok(existsSync(valuePath), `${cid}'s element lives in the value store`);
    assert.deepEqual(JSON.parse(readFileSync(valuePath, "utf8")), element, `${cid} is bound to element[${i}]`);
  });
  // distinct elements -> distinct per-element handles (one store entry each).
  const refs = childIds.map((c) => state.tasks[c].inputRef);
  assert.equal(new Set(refs).size, 3, "each element has its own store entry");

  // the expand node itself settled, so `ready` stops re-offering it.
  assert.equal(state.tasks.E.status, "done", "the expand node settles after fanning out");
  assert.equal(state.tasks.E.doneHash, state.tasks.E.contentHash, "doneHash records the expansion hash");
});

test("V6 expand: an empty list creates zero children and gather still proceeds", () => {
  const { dir, stateDir } = ws();
  const { id } = expandGraph(stateDir, dir, [], "empty-ref");

  const r = run(stateDir, ["expand", "--id", id, "--node", "E"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  const children = Object.keys(state.tasks).filter((t) => t.startsWith("E-item-"));
  assert.deepEqual(children, [], "an empty list creates no children");
  // gather gained no new deps; with the expand node settled, gather's only dep (E)
  // is resolved, so the gather readies and proceeds (it is still reachable).
  assert.deepEqual(state.tasks.G.deps, ["E"], "gather gains no children for an empty list");
  assert.equal(state.tasks.E.status, "done", "the expand node still settles on an empty list");
  const ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.ok(ready.includes("G"), "gather still proceeds (reachable) after an empty expansion");
});

test("V3 expand: the expansion adds only fresh forward edges, the graph stays acyclic, and children carry generatedBy = the expand id", () => {
  const { dir, stateDir } = ws();
  const { id } = expandGraph(stateDir, dir, ["a", "b"]);

  // The commit re-validates the projected graph (validateGraph -> findCycle); a cycle
  // would make the whole fan-out exit non-zero, so status 0 is itself the
  // single-commit acyclicity backstop. We additionally prove acyclicity in-test.
  const r = run(stateDir, ["expand", "--id", id, "--node", "E"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  const childIds = ["E-item-0", "E-item-1"];
  for (const cid of childIds) {
    assert.equal(state.tasks[cid].generatedBy, "E", `${cid} is generatedBy the expand node`);
    // forward edges only: gather depends on the child; the child has no back edge to
    // gather, and no dangling dep.
    assert.ok((state.tasks.G.deps || []).includes(cid), `gather -> ${cid} is a fresh forward edge`);
    assert.ok(!(state.tasks[cid].deps || []).includes("G"), `${cid} has no back edge to gather`);
    for (const dep of state.tasks[cid].deps || []) {
      assert.ok(dep in state.tasks, `${cid} dep ${dep} exists (no dangling edge)`);
    }
  }
  // the whole expanded graph is acyclic.
  assert.ok(!hasCycle(state.tasks), "the expanded graph stays acyclic");
});

// ---------------------------------------------------------------------------
// V7 / V3: the switch (branch) combinator
// ---------------------------------------------------------------------------
// When a switch node's selector output exists, `switch --node SW` reads the `over`
// selector value, matches it (stringified) to one of the node's `cases`, and in ONE
// commit instantiates ONLY that case's branch (fresh id `<switch-id>-case-<key>`,
// tagged generatedBy the switch), wiring every node that depends on the switch to
// ALSO depend on the branch (the stable exit/merge). The non-matching cases are never
// created. The settle that marks the selector "done"/gives it an outputRef is a later
// task, so these tests plant that status + the selector value file (the same
// black-box-legal mechanism the V3/V4/V5/V6 tests use; the read path treats the
// handle as an opaque filename, so the test need not replicate the content hashing).

// A reusable agent branch body (a flat agent node body the switch stamps for the
// matching case). A distinct `prompt` per case lets a test confirm the RIGHT branch
// fired, not merely that SOME branch did.
function branchBody(prompt) {
  return { type: "agent", executor: "subagent(general-purpose)",
    prompt, output_schema: { type: "string" }, max_attempts: 1 };
}

// A graph with: SEL (the selector), a switch SW over SEL into the cases, and EXIT (an
// all-resolved reducer that depends on SW — the stable exit/merge). Returns the
// GRAPH_ID with SEL planted DONE and its selector value written to the store.
function switchGraph(stateDir, dir, { schema, cases, selValue, selRef = "sel-ref", exit = true }) {
  const nodes = [
    flatAgent("SEL", schema),
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL", cases },
  ];
  if (exit) nodes.push(flatFn("EXIT", ["SW"], { require: "all-resolved" }));
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();
  const state = readState(stateDir, id);
  state.tasks.SEL.status = "done";
  state.tasks.SEL.outputRef = selRef;
  writeState(stateDir, id, state);
  const vdir = join(stateDir, "values", id);
  ensureDir(vdir);
  writeFileSync(join(vdir, `${selRef}.json`), JSON.stringify(selValue));
  return { id, vdir };
}

test("V7 switch (enum): a selector matching one of N cases creates ONLY that branch, wired to the exit, in a single commit", () => {
  const { dir, stateDir } = ws();
  const { id, vdir } = switchGraph(stateDir, dir, {
    schema: { type: "string", enum: ["a", "b", "c"] },
    cases: { a: branchBody("branch a"), b: branchBody("branch b"), c: branchBody("branch c") },
    selValue: "b",
  });

  const seqBefore = readState(stateDir, id).commitSeq;
  const r = run(stateDir, ["switch", "--id", id, "--node", "SW"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  // the whole branch is ONE commit (commitSeq increments exactly once).
  assert.equal(state.commitSeq, seqBefore + 1, "the branch is a SINGLE commit");

  // ONLY the matching case's branch exists; the non-matching cases are never created.
  assert.ok("SW-case-b" in state.tasks, "the matching case's branch is created");
  assert.ok(!("SW-case-a" in state.tasks), "a non-matching case is NOT created");
  assert.ok(!("SW-case-c" in state.tasks), "a non-matching case is NOT created");
  // it is built from the matching case body (the RIGHT branch, not just any branch).
  assert.equal(state.tasks["SW-case-b"].type, "agent", "the branch is built from the case body");
  assert.equal(state.tasks["SW-case-b"].prompt, "branch b", "the RIGHT case body was instantiated");

  // the branch is wired to the stable exit/merge: EXIT (which depends on the switch)
  // now ALSO depends on the instantiated branch.
  assert.ok((state.tasks.EXIT.deps || []).includes("SW-case-b"),
    "the exit/merge depends on the instantiated branch (stable downstream wiring)");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW"), "the exit still depends on the switch itself");

  // the branch carries generatedBy = the switch id (provenance for re-fire teardown).
  assert.equal(state.tasks["SW-case-b"].generatedBy, "SW", "the branch carries generatedBy = the switch id");
  // it is bound to the selector value BY REFERENCE (a handle, not bytes).
  assert.match(state.tasks["SW-case-b"].inputRef, /^[0-9a-f]{64}$/, "the branch carries a content-addressed handle");
  assert.deepEqual(JSON.parse(readFileSync(join(vdir, `${state.tasks["SW-case-b"].inputRef}.json`), "utf8")), "b",
    "the branch is bound to the selector value");

  // the switch itself settled, so `ready` stops re-offering it.
  assert.equal(state.tasks.SW.status, "done", "the switch settles after selecting");
  assert.equal(state.tasks.SW.doneHash, state.tasks.SW.contentHash, "doneHash records the selection hash");

  // the branched graph stays acyclic (the commit's findCycle backstop, re-proven in-test).
  assert.ok(!hasCycle(state.tasks), "the branched graph stays acyclic");
});

test("V7 switch (boolean true): a true selector instantiates the 'true' branch and not the 'false' one", () => {
  const { dir, stateDir } = ws();
  const { id } = switchGraph(stateDir, dir, {
    schema: { type: "boolean" },
    cases: { "true": branchBody("YES"), "false": branchBody("NO") },
    selValue: true,
  });
  const r = run(stateDir, ["switch", "--id", id, "--node", "SW"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  assert.ok("SW-case-true" in state.tasks, "the 'true' branch is instantiated");
  assert.ok(!("SW-case-false" in state.tasks), "the 'false' branch is NOT instantiated");
  assert.equal(state.tasks["SW-case-true"].prompt, "YES", "the true-case body was instantiated");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW-case-true"), "exit wired to the true branch");
  assert.equal(state.tasks["SW-case-true"].generatedBy, "SW");
  assert.equal(state.tasks.SW.status, "done");
  assert.ok(!hasCycle(state.tasks), "the branched graph stays acyclic");
});

test("V7 switch (boolean false): a false selector instantiates the 'false' branch and not the 'true' one", () => {
  const { dir, stateDir } = ws();
  const { id } = switchGraph(stateDir, dir, {
    schema: { type: "boolean" },
    cases: { "true": branchBody("YES"), "false": branchBody("NO") },
    selValue: false,
  });
  const r = run(stateDir, ["switch", "--id", id, "--node", "SW"]);
  assert.equal(r.status, 0, r.stderr);

  const state = readState(stateDir, id);
  assert.ok("SW-case-false" in state.tasks, "the 'false' branch is instantiated");
  assert.ok(!("SW-case-true" in state.tasks), "the 'true' branch is NOT instantiated");
  assert.equal(state.tasks["SW-case-false"].prompt, "NO", "the false-case body was instantiated");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW-case-false"), "exit wired to the false branch");
  assert.equal(state.tasks["SW-case-false"].generatedBy, "SW");
  assert.equal(state.tasks.SW.status, "done");
  assert.ok(!hasCycle(state.tasks), "the branched graph stays acyclic");
});

test("V7 switch: with no consumer the branch IS the exit (no extra wiring), and the switch still settles", () => {
  const { dir, stateDir } = ws();
  // no EXIT node: nothing depends on the switch, so the instantiated branch is itself
  // the terminal exit — the wiring loop adds no edge.
  const { id } = switchGraph(stateDir, dir, {
    schema: { type: "boolean" },
    cases: { "true": branchBody("T"), "false": branchBody("F") },
    selValue: true,
    exit: false,
  });
  const r = run(stateDir, ["switch", "--id", id, "--node", "SW"]);
  assert.equal(r.status, 0, r.stderr);
  const state = readState(stateDir, id);
  assert.ok("SW-case-true" in state.tasks, "the matching branch is the terminal exit");
  assert.deepEqual(state.tasks["SW-case-true"].deps, [], "a terminal branch has no forward edge added");
  assert.equal(state.tasks.SW.status, "done", "the switch settles even with no consumer");
  assert.ok(!hasCycle(state.tasks), "the graph stays acyclic");
});

test("V7 switch: re-firing on a changed selector tears down the prior branch and re-wires the exit (idempotent, one clean shape)", () => {
  const { dir, stateDir } = ws();
  // first selection: "a"
  const { id, vdir } = switchGraph(stateDir, dir, {
    schema: { type: "string", enum: ["a", "b", "c"] },
    cases: { a: branchBody("A"), b: branchBody("B"), c: branchBody("C") },
    selValue: "a",
  });
  assert.equal(run(stateDir, ["switch", "--id", id, "--node", "SW"]).status, 0);
  let state = readState(stateDir, id);
  assert.ok("SW-case-a" in state.tasks, "first fire created the 'a' branch");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW-case-a"), "exit wired to the 'a' branch");

  // the selector value changes to "c" (rewrite the value file the planted ref points to)
  writeFileSync(join(vdir, "sel-ref.json"), JSON.stringify("c"));
  assert.equal(run(stateDir, ["switch", "--id", id, "--node", "SW"]).status, 0, "re-firing on a settled switch is allowed");

  state = readState(stateDir, id);
  // the prior 'a' branch is torn down; only the new 'c' branch survives.
  assert.ok(!("SW-case-a" in state.tasks), "the prior branch is torn down on re-fire");
  assert.ok("SW-case-c" in state.tasks, "the new matching branch is created");
  // the exit is re-wired: it no longer depends on the stale 'a' branch, but on 'c'.
  assert.ok(!(state.tasks.EXIT.deps || []).includes("SW-case-a"), "the stale branch dep is stripped from the exit");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW-case-c"), "the exit is re-wired onto the new branch");
  assert.ok((state.tasks.EXIT.deps || []).includes("SW"), "the exit still depends on the switch");
  assert.ok(!hasCycle(state.tasks), "the re-fired graph stays acyclic");
});

test("V7 switch: rejects a non-switch node, an unknown node, and a selector with no output yet", () => {
  const { dir, stateDir } = ws();
  // a selector that is NOT yet done-with-output: the switch verb refuses to fire early.
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SEL", { type: "boolean" }),
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL", cases: { "true": branchBody("T"), "false": branchBody("F") } },
  ] }).stdout.trim();
  const early = run(stateDir, ["switch", "--id", id, "--node", "SW"]);
  assert.notEqual(early.status, 0, "switch refuses to fire before its selector has output");
  assert.match(early.stderr, /no output yet/i);

  // a non-switch node and an unknown node are both refused.
  assert.notEqual(run(stateDir, ["switch", "--id", id, "--node", "SEL"]).status, 0, "switch refuses a non-switch node");
  const ghost = run(stateDir, ["switch", "--id", id, "--node", "ghost"]);
  assert.notEqual(ghost.status, 0, "switch refuses an unknown node");
  assert.match(ghost.stderr, /unknown node/i);
});

// ---------------------------------------------------------------------------
// V2: exhaustiveness is enforced at validate_graph time (reused from task 1)
// ---------------------------------------------------------------------------
// The switch combinator RELIES ON validateGraph rejecting a non-exhaustive switch at
// init (the registry-and-validation task owns that check; it is not re-implemented in
// the switch runtime). This asserts the guarantee the combinator depends on: a switch
// whose cases don't cover the selector's declared domain never reaches a runnable
// state, so the `switch` verb can assume a matching case always exists.

test("V2 switch: init rejects a non-exhaustive switch (cases don't cover the enum domain); no state, never runnable", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SEL", { type: "string", enum: ["a", "b", "c"] }),
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { a: branchBody("A"), b: branchBody("B") } }, // missing 'c'
  ] });
  assert.notEqual(r.status, 0, "a non-exhaustive switch is rejected at init");
  assert.match(r.stderr, /exhaustively|missing.*c/i, "the rejection names the exhaustiveness failure");
  assert.equal(
    readdirSync(stateDir).filter((f) => f.endsWith(".json")).length, 0,
    "a rejected graph writes no state — the switch verb can never reach a non-exhaustive switch",
  );
});

test("V2 switch: init rejects a boolean switch missing the 'false' case", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SEL", { type: "boolean" }),
    { id: "SW", type: "switch", deps: ["SEL"], over: "SEL", cases: { "true": branchBody("T") } },
  ] });
  assert.notEqual(r.status, 0, "a boolean switch missing a case is rejected at init");
  assert.match(r.stderr, /missing.*false|exhaustively/i);
});

// ---------------------------------------------------------------------------
// V8 / V3: the budgeted forward-unroll loop (built ON the switch combinator)
// ---------------------------------------------------------------------------
// A loop is realized as a budgeted FORWARD UNROLL on the existing `switch` combinator
// — NO new primitive, NO back-edge. The loop's tail is a `switch` node whose two cases
// are the loop's routes: "continue" (the next iteration body) and "stop" (the exit).
// `loop --node L --state <handle>` reads the carried {budget, accumulator}, routes
// continue iff budget>0 AND no stop condition holds, and spawns ONE fresh FORWARD node
// per step: `L-iter-<k>` (depending on the prior iteration) on continue, or `L-exit`
// on stop. The budget is strictly decremented and the accumulator folded across
// iterations, threaded BY REFERENCE through the value store. It provably terminates
// (<= budget steps) and never forms a cycle. The selector value + the seed state are
// planted (the same black-box-legal mechanism the V6/V7 combinator tests use).

// A loop body / exit case body — a flat fn node body (validateGraph requires
// module/export/output_schema). The loop overrides its id/deps and binds its state.
function loopBody() {
  return { type: "fn", module: "./iter.mjs", export: "step", output_schema: { type: "object" } };
}

// Build a loop graph: SEL (the continue/stop selector), L (the tail switch over SEL),
// AFTER (an all-resolved reducer that depends on L — the stable exit/merge consumer),
// and TRIGGER (an unrelated implement node, so a committing verb can drive
// invalidateStale for the GEN_CAP test). Plants SEL done with the given selector value
// and writes the seed {budget, accumulator:0} into the store. Returns the id, the value
// dir, and the seed handle.
function loopGraph(stateDir, dir, { budget, selValue = "continue" }) {
  const nodes = [
    flatAgent("SEL", { type: "string", enum: ["continue", "stop"] }),
    { id: "L", type: "switch", deps: ["SEL"], over: "SEL",
      cases: { continue: loopBody(), stop: loopBody() } },
    flatFn("AFTER", ["L"], { require: "all-resolved" }),
    task("TRIGGER"),
  ];
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();
  const state = readState(stateDir, id);
  state.tasks.SEL.status = "done";
  state.tasks.SEL.outputRef = "sel-ref";
  writeState(stateDir, id, state);
  const vdir = join(stateDir, "values", id);
  ensureDir(vdir);
  writeFileSync(join(vdir, "sel-ref.json"), JSON.stringify(selValue));
  const seedHandle = "seed-state";
  writeFileSync(join(vdir, `${seedHandle}.json`), JSON.stringify({ budget, accumulator: 0 }));
  return { id, vdir, seedHandle };
}

// Fire one loop step; returns the printed next-/final-state handle.
function fireLoop(stateDir, id, stateHandle) {
  const r = run(stateDir, ["loop", "--id", id, "--node", "L", "--state", stateHandle]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// Read a state object {budget, accumulator} back from a node's bound inputRef handle.
function boundState(stateDir, id, vdir, taskId) {
  const ref = readState(stateDir, id).tasks[taskId].inputRef;
  return JSON.parse(readFileSync(join(vdir, `${ref}.json`), "utf8"));
}

test("V8 loop: a budget-3 loop unrolls 3 fresh forward iterations, decrements the budget, threads the accumulator, terminates at the exit, and never forms a cycle", () => {
  const { dir, stateDir } = ws();
  const { id, vdir, seedHandle } = loopGraph(stateDir, dir, { budget: 3 });

  // step 0: spawn iter-0 from the seed; the loop is still in progress (not settled).
  const h1 = fireLoop(stateDir, id, seedHandle);
  let state = readState(stateDir, id);
  assert.ok("L-iter-0" in state.tasks, "the first step spawns L-iter-0");
  assert.deepEqual(state.tasks["L-iter-0"].deps, [], "the first iteration has no prior-iteration edge");
  assert.equal(state.tasks["L-iter-0"].generatedBy, "L", "the iteration is generatedBy the loop node");
  assert.equal(state.tasks.L.status, "pending", "the loop node is NOT settled while iterating (forward progress)");
  assert.ok(!hasCycle(state.tasks), "acyclic after step 0");

  // step 1: spawn iter-1, a FRESH FORWARD node depending on iter-0 (never a back-edge).
  const h2 = fireLoop(stateDir, id, h1);
  state = readState(stateDir, id);
  assert.ok("L-iter-1" in state.tasks, "the second step spawns a fresh L-iter-1");
  assert.deepEqual(state.tasks["L-iter-1"].deps, ["L-iter-0"], "iter-1 is a FORWARD node after iter-0");
  assert.ok(!(state.tasks["L-iter-0"].deps || []).includes("L-iter-1"), "no back-edge from iter-0 to iter-1");
  assert.ok(!hasCycle(state.tasks), "acyclic after step 1");

  // step 2: spawn iter-2.
  const h3 = fireLoop(stateDir, id, h2);
  state = readState(stateDir, id);
  assert.ok("L-iter-2" in state.tasks, "the third step spawns L-iter-2");
  assert.deepEqual(state.tasks["L-iter-2"].deps, ["L-iter-1"], "iter-2 is a FORWARD node after iter-1");
  assert.ok(!hasCycle(state.tasks), "acyclic after step 2");

  // step 3: the budget is now 0 -> the guard FORCES stop -> the exit, no 4th iteration.
  const hf = fireLoop(stateDir, id, h3);
  state = readState(stateDir, id);
  assert.ok("L-exit" in state.tasks, "budget exhaustion routes to the exit");
  assert.ok(!("L-iter-3" in state.tasks), "no fourth iteration is spawned (the budget bottomed out)");

  // exactly 3 fresh iteration nodes, all distinct ids.
  const iters = Object.keys(state.tasks).filter((t) => t.startsWith("L-iter-")).sort();
  assert.deepEqual(iters, ["L-iter-0", "L-iter-1", "L-iter-2"], "exactly 3 distinct iteration nodes");

  // the carried budget strictly decrements across iterations: 3, 2, 1.
  assert.deepEqual(
    iters.map((t) => boundState(stateDir, id, vdir, t).budget), [3, 2, 1],
    "the budget strictly decrements each iteration and bottoms out",
  );

  // the accumulator is threaded/folded across iterations: 0, 3, 5; final = 3+2+1 = 6.
  assert.deepEqual(
    iters.map((t) => boundState(stateDir, id, vdir, t).accumulator), [0, 3, 5],
    "the accumulator carries forward across iterations",
  );
  const finalState = boundState(stateDir, id, vdir, "L-exit");
  assert.equal(finalState.budget, 0, "the exit sees the exhausted budget");
  assert.equal(finalState.accumulator, 6, "the final accumulator is the fold across iterations (3+2+1)");
  // the loop prints ONLY the threaded final-state handle (no value crosses the orchestrator).
  assert.deepEqual(JSON.parse(readFileSync(join(vdir, `${hf}.json`), "utf8")), { budget: 0, accumulator: 6 },
    "loop prints ONLY the threaded final-state handle");

  // the exit is the stable merge: AFTER (which depends on L) now ALSO depends on L-exit.
  assert.ok((state.tasks.AFTER.deps || []).includes("L-exit"), "the consumer is wired onto the exit (stable exit/merge)");
  assert.ok((state.tasks.AFTER.deps || []).includes("L"), "the consumer still lists the loop node");

  // the loop node settled at stop, so a later upstream drift re-unrolls it; acyclic.
  assert.equal(state.tasks.L.status, "done", "the loop node settles when it stops");
  assert.equal(state.tasks.L.doneHash, state.tasks.L.contentHash, "doneHash records the settle hash (drift -> re-unroll)");
  assert.ok(!hasCycle(state.tasks), "the fully unrolled loop is acyclic");
});

test("V8 loop: a stop CONDITION (selector 'stop') routes to the exit before the budget is exhausted", () => {
  const { dir, stateDir } = ws();
  const { id, seedHandle } = loopGraph(stateDir, dir, { budget: 5, selValue: "stop" });
  fireLoop(stateDir, id, seedHandle);
  const state = readState(stateDir, id);
  assert.ok(!("L-iter-0" in state.tasks), "a stop condition spawns NO iteration");
  assert.ok("L-exit" in state.tasks, "a stop condition routes straight to the exit");
  assert.equal(state.tasks.L.status, "done", "the loop settles immediately on a stop condition");
  assert.ok(!hasCycle(state.tasks), "acyclic");
});

test("V8 loop: rejects a non-switch node, a missing --state, and a negative budget (the termination guard)", () => {
  const { dir, stateDir } = ws();
  const { id, seedHandle, vdir } = loopGraph(stateDir, dir, { budget: 2 });
  assert.notEqual(run(stateDir, ["loop", "--id", id, "--node", "SEL", "--state", seedHandle]).status, 0,
    "loop refuses a non-switch node");
  assert.notEqual(run(stateDir, ["loop", "--id", id, "--node", "L"]).status, 0, "loop requires --state");
  // a negative carried budget violates the termination invariant (the guard).
  writeFileSync(join(vdir, "bad-state.json"), JSON.stringify({ budget: -1, accumulator: 0 }));
  const neg = run(stateDir, ["loop", "--id", id, "--node", "L", "--state", "bad-state"]);
  assert.notEqual(neg.status, 0, "a negative carried budget is rejected (termination guard)");
  assert.match(neg.stderr, /non-negative integer/i);
});

// [Task-local] Re-running a settled loop after an upstream change reuses GEN_CAP
// (task.mjs:73-83): a loop iteration is an ordinary generated node, so invalidateStale's
// GEN_CAP path bounds its re-runs under input drift exactly as for any failed node.

test("V8 loop/GEN_CAP: a terminally-failed loop iteration AT the cap under input drift stays failed (NOT re-run) — bounded by GEN_CAP", () => {
  const { dir, stateDir } = ws();
  const { id, seedHandle } = loopGraph(stateDir, dir, { budget: 3 });
  // unroll one iteration so there is a real loop-body node generatedBy the loop.
  fireLoop(stateDir, id, seedHandle);
  let state = readState(stateDir, id);
  assert.equal(state.tasks["L-iter-0"].generatedBy, "L", "iter-0 is a loop-generated node");

  // Plant the loop-body node FAILED with a stale provenance hash (an upstream drift) AND
  // its generation already AT the cap. The next invalidation would be generation
  // GEN_CAP+1, so it must be REFUSED — the iteration stays failed.
  state.tasks["L-iter-0"].status = "failed";
  state.tasks["L-iter-0"].doneHash = "deadbeef".repeat(8); // 64-hex, != the real contentHash (drift)
  state.tasks["L-iter-0"].generation = 3; // GEN_CAP
  writeState(stateDir, id, state);

  // a committing verb (dispatch the unrelated TRIGGER) drives invalidateStale over the
  // drifted loop iteration too.
  run(stateDir, ["dispatch", "--id", id, "--node", "TRIGGER.impl"]);
  state = readState(stateDir, id);
  assert.equal(state.tasks["L-iter-0"].status, "failed", "the capped loop iteration stays failed (NOT re-run)");
  assert.equal(state.tasks["L-iter-0"].generation, 3, "generation is not advanced past the GEN_CAP ceiling");
});

test("V8 loop/GEN_CAP: a failed loop iteration BELOW the cap under input drift is re-run (generation bumped)", () => {
  const { dir, stateDir } = ws();
  const { id, seedHandle } = loopGraph(stateDir, dir, { budget: 3 });
  fireLoop(stateDir, id, seedHandle);
  let state = readState(stateDir, id);

  // failed, drifted, generation below the cap -> the next invalidation resets + re-runs.
  state.tasks["L-iter-0"].status = "failed";
  state.tasks["L-iter-0"].doneHash = "deadbeef".repeat(8);
  state.tasks["L-iter-0"].generation = 0;
  writeState(stateDir, id, state);

  run(stateDir, ["dispatch", "--id", id, "--node", "TRIGGER.impl"]);
  state = readState(stateDir, id);
  assert.equal(state.tasks["L-iter-0"].status, "pending", "a sub-cap failed iteration resets to pending (re-run)");
  assert.equal(state.tasks["L-iter-0"].generation, 1, "each bounded re-run bumps the generation toward GEN_CAP");
  assert.equal(state.tasks["L-iter-0"].doneHash, undefined, "the stale provenance hash is cleared on reset");
});

// ---------------------------------------------------------------------------
// V9: engine-enforced concurrency window on `ready`
//
// With an OPTIONAL --window N, `ready` emits at most max(0, N - in-flight) of the
// otherwise-ready nodes (stable/sorted order) and keeps the rest ready-deferred.
// With NO --window the behavior is UNBOUNDED and byte-identical to before — the
// safety constraint the active self-orchestrating run depends on.
// ---------------------------------------------------------------------------

// A fan-out of M no-dep flat agent nodes, all ready at init (in-flight 0).
function fanOut(stateDir, dir, m) {
  const nodes = [];
  for (let i = 0; i < m; i++) nodes.push(flatAgent(`n${i}`, { type: "string" }));
  return init(stateDir, dir, { version: 1, nodes }).stdout.trim();
}

test("V9 window: M>N ready nodes with --window N (in-flight 0) emits exactly the first N in stable order; the rest deferred", () => {
  const { dir, stateDir } = ws();
  const id = fanOut(stateDir, dir, 5); // n0..n4 all ready, nothing in flight
  // sanity: all 5 ready with no window
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id]).stdout), ["n0", "n1", "n2", "n3", "n4"]);
  // --window 2, in-flight 0 -> exactly 2, the first two in sorted order (stable)
  const r = run(stateDir, ["ready", "--id", id, "--window", "2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r.stdout), ["n0", "n1"], "emits exactly N nodes, the rest ready-deferred");
});

test("V9 window: with K in-flight, --window N emits max(0, N-K) ready nodes (never negative)", () => {
  const { dir, stateDir } = ws();
  // 5 ready flat agents + 2 legacy implement tasks we dispatch to make in-flight = 2.
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("n0", { type: "string" }), flatAgent("n1", { type: "string" }),
    flatAgent("n2", { type: "string" }), flatAgent("n3", { type: "string" }),
    flatAgent("n4", { type: "string" }),
    task("T0"), task("T1"),
  ] }).stdout.trim();
  // dispatch the two impl subnodes -> running == in-flight 2 (and out of the ready set)
  run(stateDir, ["dispatch", "--id", id, "--node", "T0.impl"]);
  run(stateDir, ["dispatch", "--id", id, "--node", "T1.impl"]);
  // window 4, in-flight 2 -> budget 2 -> first two agents (n0, n1)
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id, "--window", "4"]).stdout), ["n0", "n1"],
    "emits max(0, N - in-flight) = 4 - 2 = 2");
  // window 2, in-flight 2 -> budget 0 -> nothing emitted (all ready-deferred)
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id, "--window", "2"]).stdout), [],
    "in-flight at the cap defers everything (max(0, 2-2) = 0)");
  // window 1, in-flight 2 -> max(0, 1-2) = 0 (clamped, never negative)
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id, "--window", "1"]).stdout), [],
    "in-flight above the window still emits zero, never negative");
});

test("V9 window: with NO --window, `ready` returns ALL M ready nodes (unbounded); a window wider than ready is a no-op", () => {
  const { dir, stateDir } = ws();
  const id = fanOut(stateDir, dir, 5);
  const unbounded = run(stateDir, ["ready", "--id", id]);
  assert.equal(unbounded.status, 0, unbounded.stderr);
  assert.deepEqual(ids(unbounded.stdout), ["n0", "n1", "n2", "n3", "n4"], "no window -> all M ready nodes");
  // a window >= (ready + in-flight) never truncates: byte-identical to the default.
  const wide = run(stateDir, ["ready", "--id", id, "--window", "99"]);
  assert.equal(wide.stdout, unbounded.stdout, "a window wider than the ready set is byte-identical to the unbounded default");
});

test("V9 window: default (no --window) output is byte-identical on a MIXED legacy+flat graph (safety regression)", () => {
  const { dir, stateDir } = ws();
  // The shape the active self-orchestrating run uses: legacy implement subnodes
  // alongside flat agent nodes. The no-window `ready` MUST stay the pre-window
  // engine's exact output: the full sorted readySet with executors, nothing deferred.
  const id = init(stateDir, dir, { version: 1, nodes: [
    task("IMPL"),
    flatAgent("AG", { type: "string" }),
  ] }).stdout.trim();
  const out = run(stateDir, ["ready", "--id", id]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(lines(out.stdout).sort(),
    ["AG\tsubagent(general-purpose)", "IMPL.impl\tsubagent(general-purpose)"],
    "no window -> the exact pre-window ready lines (ids + executors), nothing truncated");
});

test("V9 window: window 0 defers everything; a bare/non-integer/negative window is rejected non-zero", () => {
  const { dir, stateDir } = ws();
  const id = fanOut(stateDir, dir, 3);
  assert.deepEqual(ids(run(stateDir, ["ready", "--id", id, "--window", "0"]).stdout), [],
    "--window 0 emits nothing (budget max(0, 0-0) = 0)");
  for (const bad of ["-1", "1.5", "abc"]) {
    const r = run(stateDir, ["ready", "--id", id, "--window", bad]);
    assert.notEqual(r.status, 0, `--window ${bad} must be rejected`);
    assert.match(r.stderr, /window/, "the error names --window");
  }
  const bare = run(stateDir, ["ready", "--id", id, "--window"]);
  assert.notEqual(bare.status, 0, "a bare --window with no value is rejected");
});

// ---------------------------------------------------------------------------
// V10: the implement-and-audit lifecycle as a 5-node composition (INTEGRATION)
// ---------------------------------------------------------------------------
// verifiedTaskNodes(spec) (scripts/lifecycle.mjs) is a PRODUCER helper: it RETURNS
// the folded-graph nodes — work(agent) -> resolve(agent, emits the panel list) ->
// audit(expand over the panel) -> fold(fn, folds the auditor verdicts) ->
// terminal(switch, the loop tail) — wired together; it never runs the engine. These
// tests INIT a graph built from the helper and DRIVE it through the engine verbs
// (ready / complete --output / expand / exec-node / loop) to prove the composition
// reproduces implement-and-audit end to end.
//
// Flat agent/fn settling to "done" is a LATER task (execute-plan-update), so — as the
// V4/V5/V6/V7/V8 combinator tests already do — these tests plant a running impl
// subnode to drive `complete --output` for the by-reference output channel, then mark
// the flat node done (black-box-legal state-planting). expand / exec-node / loop are
// driven through the REAL engine verbs.

// Record an agent node's output through the real `complete --output` by-reference
// channel (plant a running subnode so complete has something to settle), then mark the
// flat node done. Returns the recorded outputRef handle.
function lcCompleteOut(stateDir, id, taskId, outputJson) {
  let state = readState(stateDir, id);
  state.subnodes[`${taskId}.run`] = { task: taskId, role: "impl", status: "running" };
  writeState(stateDir, id, state);
  const r = run(stateDir, ["complete", "--id", id, "--node", `${taskId}.run`, "--output", outputJson]);
  assert.equal(r.status, 0, `complete --output ${taskId}: ${r.stderr}`);
  state = readState(stateDir, id);
  state.tasks[taskId].status = "done";
  writeState(stateDir, id, state);
  return state.tasks[taskId].outputRef;
}

// Record a node's output that is ALREADY in the store, by HANDLE (pure by-reference),
// through `complete --output-ref` (validated vs output_schema), then mark it done.
function lcCompleteRef(stateDir, id, taskId, handle) {
  let state = readState(stateDir, id);
  state.subnodes[`${taskId}.run`] = { task: taskId, role: "impl", status: "running" };
  writeState(stateDir, id, state);
  const r = run(stateDir, ["complete", "--id", id, "--node", `${taskId}.run`, "--output-ref", handle]);
  assert.equal(r.status, 0, `complete --output-ref ${taskId}: ${r.stderr}`);
  state = readState(stateDir, id);
  state.tasks[taskId].status = "done";
  writeState(stateDir, id, state);
}

function readValue(stateDir, id, handle) {
  return JSON.parse(readFileSync(join(stateDir, "values", id, `${handle}.json`), "utf8"));
}

// Init a graph whose backbone is the helper's 5-node lifecycle for base id "T", plus
// any `extraNodes` (e.g. a successor that proves non-halting). Returns the GRAPH_ID.
function lcInit(stateDir, dir, extraNodes = []) {
  const nodes = [...verifiedTaskNodes({ id: "T", prompt: "implement T", output_schema: { type: "string" } }), ...extraNodes];
  return init(stateDir, dir, { version: 1, nodes }).stdout.trim();
}

// Drive the lifecycle from work through fold via the real engine verbs, with one
// boolean verdict per auditor in `verdicts` (the resolver emits a panel of that size;
// each auditor completes with its verdict). A `null` verdict marks that auditor's RUN
// as FAILED (status failed, no output) instead of completing it, to exercise the
// failed-envelope path. Returns the fold's routing signal ("continue" | "stop").
function lcDriveToFold(stateDir, id, verdicts) {
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("T-work"), "work readies at init");
  lcCompleteOut(stateDir, id, "T-work", JSON.stringify("impl-result"));
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("T-resolve"), "resolve readies once work is done");
  lcCompleteOut(stateDir, id, "T-resolve", JSON.stringify(verdicts.map((_, i) => `focus-${i}`)));
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("T-audit"), "audit(expand) readies once the panel exists");
  const ex = run(stateDir, ["expand", "--id", id, "--node", "T-audit"]);
  assert.equal(ex.status, 0, `expand T-audit: ${ex.stderr}`);
  verdicts.forEach((v, i) => {
    const child = `T-audit-item-${i}`;
    if (v === null) {
      const s = readState(stateDir, id);
      s.tasks[child].status = "failed"; // a failed auditor RUN: {status:"failed"}, no output
      writeState(stateDir, id, s);
    } else {
      lcCompleteOut(stateDir, id, child, JSON.stringify(v));
    }
  });
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("T-fold"),
    "fold (all-resolved) readies once the expand and every auditor are resolved");
  const ec = run(stateDir, ["exec-node", "--id", id, "--node", "T-fold"]);
  assert.equal(ec.status, 0, `exec-node T-fold: ${ec.stderr}`);
  const foldRef = lines(ec.stdout)[0];
  const signal = readValue(stateDir, id, foldRef);
  lcCompleteRef(stateDir, id, "T-fold", foldRef);
  return signal;
}

// Seed the loop's carried {budget, accumulator} state into the store and return its
// (opaque) handle, mirroring the V8 loopGraph seed.
function lcSeed(stateDir, id, budget) {
  ensureDir(join(stateDir, "values", id));
  writeFileSync(join(stateDir, "values", id, "lc-seed.json"), JSON.stringify({ budget, accumulator: 0 }));
  return "lc-seed";
}

test("V10 lifecycle: the 5-node helper stamps work->resolve->audit(expand)->fold(fn)->terminal(switch)", () => {
  const { dir, stateDir } = ws();
  const nodes = verifiedTaskNodes({ id: "T", prompt: "implement T", output_schema: { type: "string" } });
  // exactly the 5-node skeleton, in order, of the right kinds, correctly wired.
  assert.deepEqual(nodes.map((n) => n.id), ["T-work", "T-resolve", "T-audit", "T-fold", "T-terminal"]);
  assert.deepEqual(nodes.map((n) => n.type), ["agent", "agent", "expand", "fn", "switch"]);
  const [work, resolve, audit, fold, terminal] = nodes;
  assert.deepEqual(resolve.deps, ["T-work"], "resolve depends on work");
  assert.equal(audit.over, "T-resolve", "audit expands over the resolver's panel list");
  assert.equal(audit.gather, "T-fold", "audit gathers into fold");
  assert.equal(fold.require, "all-resolved", "fold is an all-resolved reducer (reads failed envelopes)");
  assert.deepEqual(fold.output_schema.enum, ["continue", "stop"], "fold emits the routing signal");
  assert.equal(terminal.over, "T-fold", "terminal switches on the fold signal");
  assert.deepEqual(Object.keys(terminal.cases).sort(), ["continue", "stop"], "terminal's cases cover the fold domain (exhaustive)");
  // and the produced graph is accepted by the real engine (validateGraph), proving the
  // wiring + switch exhaustiveness are valid, not just structurally plausible.
  const id = init(stateDir, dir, { version: 1, nodes }).stdout.trim();
  assert.match(id, HEX16, "the 5-node composition initializes into a valid graph");
});

test("V10 lifecycle (happy path): all auditors pass -> fold 'stop' -> the terminal loop exits (task done)", () => {
  const { dir, stateDir } = ws();
  const id = lcInit(stateDir, dir);
  // two auditors, both pass.
  const signal = lcDriveToFold(stateDir, id, [true, true]);
  assert.equal(signal, "stop", "every auditor passing folds to 'stop' (exit)");

  // drive the terminal loop: 'stop' routes to the exit; the task reaches "done".
  const lp = run(stateDir, ["loop", "--id", id, "--node", "T-terminal", "--state", lcSeed(stateDir, id, 3)]);
  assert.equal(lp.status, 0, lp.stderr);
  const state = readState(stateDir, id);
  assert.ok("T-terminal-exit" in state.tasks, "the loop instantiates the exit on 'stop'");
  assert.ok(!Object.keys(state.tasks).some((t) => t.startsWith("T-terminal-iter-")),
    "no retry iteration is spawned when every auditor passed");
  assert.equal(state.tasks["T-terminal"].status, "done", "the terminal settles when the loop stops");
  assert.equal(state.tasks["T-terminal"].doneHash, state.tasks["T-terminal"].contentHash, "the settled terminal stamps its doneHash");
  assert.ok(!hasCycle(state.tasks), "the settled lifecycle is acyclic");
});

test("V10 lifecycle (retry): an auditor fails & budget remains -> the terminal switch spawns a fresh work iteration (loop)", () => {
  const { dir, stateDir } = ws();
  const id = lcInit(stateDir, dir);
  // two auditors; the second fails -> fold 'continue'.
  const signal = lcDriveToFold(stateDir, id, [true, false]);
  assert.equal(signal, "continue", "any auditor failing folds to 'continue' (retry)");

  // budget remains (3): the loop spawns the next work iteration as a fresh FORWARD node.
  const lp = run(stateDir, ["loop", "--id", id, "--node", "T-terminal", "--state", lcSeed(stateDir, id, 3)]);
  assert.equal(lp.status, 0, lp.stderr);
  assert.match(lines(lp.stdout)[0] || "", /^[0-9a-f]{64}$/, "the loop prints ONLY the threaded next-state handle");
  const state = readState(stateDir, id);
  assert.ok("T-terminal-iter-0" in state.tasks, "the loop spawns a fresh work iteration on 'continue' + budget>0");
  assert.equal(state.tasks["T-terminal-iter-0"].generatedBy, "T-terminal", "the iteration is generatedBy the terminal node");
  assert.equal(state.tasks["T-terminal"].status, "pending", "the terminal is NOT settled while iterating (forward progress)");
  assert.ok(!("T-terminal-exit" in state.tasks), "no exit yet — the lifecycle is looping, not terminating");
  assert.ok(!hasCycle(state.tasks), "the forward unroll never forms a cycle");
});

test("V10 lifecycle (budget exhaustion): an auditor fails & budget=0 -> terminal-failed routes to the exit, NON-HALTING", () => {
  const { dir, stateDir } = ws();
  // a successor of the terminal proves a terminal failure does not halt the graph.
  const succ = { id: "AFTER", type: "fn", deps: ["T-terminal"], module: LIFECYCLE, export: "gatherSuccesses",
    output_schema: { type: "array" }, require: "all-resolved" };
  const id = lcInit(stateDir, dir, [succ]);
  // an auditor's RUN fails (status:"failed") -> fold 'continue', but budget is exhausted.
  const signal = lcDriveToFold(stateDir, id, [true, null]);
  assert.equal(signal, "continue", "a failed auditor run folds to 'continue'");

  // budget 0: the loop's budget>0 guard FORCES 'stop', so it routes to the exit anyway —
  // a TERMINAL FAILURE that is non-halting (the exit is reached, successors proceed).
  const lp = run(stateDir, ["loop", "--id", id, "--node", "T-terminal", "--state", lcSeed(stateDir, id, 0)]);
  assert.equal(lp.status, 0, lp.stderr);
  let state = readState(stateDir, id);
  assert.ok("T-terminal-exit" in state.tasks, "budget exhaustion routes to the exit (terminal-failed), not an endless loop");
  assert.ok(!Object.keys(state.tasks).some((t) => t.startsWith("T-terminal-iter-")), "no iteration is spawned when the budget is exhausted");
  assert.equal(state.tasks["T-terminal"].status, "done", "the terminal settles at the exhausted exit");
  assert.ok((state.tasks.AFTER.deps || []).includes("T-terminal-exit"), "the successor is wired onto the exit (stable merge)");

  // NON-HALTING: even when the terminal-failed exit itself FAILS, the all-resolved
  // successor still readies — a logged failure never sinks the run.
  state = readState(stateDir, id);
  state.tasks["T-terminal-exit"].status = "failed";
  writeState(stateDir, id, state);
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("AFTER"),
    "the successor proceeds despite the terminal failure (non-halting)");
  assert.ok(!hasCycle(readState(stateDir, id).tasks), "the terminated lifecycle is acyclic");
});

// ---------------------------------------------------------------------------
// V12: reduce/gather failure handling (INTEGRATION)
// ---------------------------------------------------------------------------
// gatherSuccesses (scripts/lifecycle.mjs) is the reduce/gather fn: a reducer (fn,
// require="all-resolved") reads per-child {status, output?} envelopes, GATHERS the
// done ones, DROPS the failed ones, and UNIONS a threaded accumulator of prior
// successes (an array output is unioned element-wise) so a retry never drops earlier
// successes. These tests drive a real fan-out (expand), exec-node the reducer, and
// drive the retry as a budgeted forward unroll via the loop.

// A reducer fn node bound to gatherSuccesses (require="all-resolved").
function gatherNode(id, deps) {
  return { id, type: "fn", deps, module: LIFECYCLE, export: "gatherSuccesses",
    output_schema: { type: "array" }, require: "all-resolved" };
}

// Mark a planted task as a FAILED upstream (status:"failed", no output) — the
// counterpart of plantDoneOutput, for the failed-envelope path.
function plantFailed(stateDir, id, taskId) {
  const state = readState(stateDir, id);
  state.tasks[taskId].status = "failed";
  writeState(stateDir, id, state);
}

test("V12 gather: a fan-out where some children fail -> the reducer gathers the successes, dropping the failed", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SRC", { type: "array" }),
    { id: "E", type: "expand", deps: ["SRC"], over: "SRC",
      template: flatAgent("x", { type: "string" }), gather: "R" },
    gatherNode("R", ["E"]),
  ] }).stdout.trim();

  // fan out over a 3-element list (the settle marking SRC done is a later task; plant it).
  plantDoneOutput(stateDir, id, "SRC", ["a", "b", "c"], "src-ref");
  const ex = run(stateDir, ["expand", "--id", id, "--node", "E"]);
  assert.equal(ex.status, 0, ex.stderr);

  // two children succeed, the middle one FAILS.
  plantDoneOutput(stateDir, id, "E-item-0", "a");
  plantFailed(stateDir, id, "E-item-1");
  plantDoneOutput(stateDir, id, "E-item-2", "c");

  // the reducer readies (all-resolved: done|failed) and gathers ONLY the successes.
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("R"),
    "the all-resolved reducer readies despite a failed child");
  const ec = run(stateDir, ["exec-node", "--id", id, "--node", "R"]);
  assert.equal(ec.status, 0, ec.stderr);
  const gathered = readValue(stateDir, id, lines(ec.stdout)[0]);
  assert.deepEqual(gathered.slice().sort(), ["a", "c"],
    "the reducer gathers the done children and drops the failed one (no missing-input crash)");
});

test("V12 retry: the failed subset is re-run via the loop, and the final reducer unions prior successes (accumulator)", () => {
  const { dir, stateDir } = ws();
  // Round-1 fan-out + reducer R1; a loop tail (RSEL/LT) for the budgeted retry; and a
  // final union reducer R2 over [R1 (the threaded accumulator), RETRY (the re-run
  // failed subset's success)].
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("SRC", { type: "array" }),
    { id: "E", type: "expand", deps: ["SRC"], over: "SRC",
      template: flatAgent("x", { type: "string" }), gather: "R1" },
    gatherNode("R1", ["E"]),
    flatAgent("RSEL", { type: "string", enum: ["continue", "stop"] }), // the loop selector
    { id: "LT", type: "switch", deps: ["RSEL"], over: "RSEL",
      cases: { continue: flatAgent("rb", { type: "string" }), stop: flatAgent("eb", { type: "string" }) } },
    flatAgent("RETRY", { type: "string" }), // carries the re-run failed subset's success
    gatherNode("R2", ["R1", "RETRY"]),
  ] }).stdout.trim();

  // Round 1: fan out, the middle child fails; R1 gathers ["a","c"].
  plantDoneOutput(stateDir, id, "SRC", ["a", "b", "c"], "src-ref");
  assert.equal(run(stateDir, ["expand", "--id", id, "--node", "E"]).status, 0);
  plantDoneOutput(stateDir, id, "E-item-0", "a");
  plantFailed(stateDir, id, "E-item-1");
  plantDoneOutput(stateDir, id, "E-item-2", "c");
  const ec1 = run(stateDir, ["exec-node", "--id", id, "--node", "R1"]);
  assert.equal(ec1.status, 0, ec1.stderr);
  const r1Ref = lines(ec1.stdout)[0];
  assert.deepEqual(readValue(stateDir, id, r1Ref).slice().sort(), ["a", "c"], "round-1 reducer gathers the successes");
  // record R1's accumulator so the final reducer can thread it (the value is already in
  // the store from exec-node; plant the done status + handle).
  let state = readState(stateDir, id);
  state.tasks.R1.status = "done"; state.tasks.R1.outputRef = r1Ref;
  writeState(stateDir, id, state);

  // RETRY via the loop: the selector says 'continue' (a failed subset remains) and the
  // budget is non-zero, so the loop spawns the retry as a fresh FORWARD iteration.
  plantDoneOutput(stateDir, id, "RSEL", "continue", "rsel-ref");
  ensureDir(join(stateDir, "values", id));
  writeFileSync(join(stateDir, "values", id, "retry-seed.json"), JSON.stringify({ budget: 2, accumulator: 0 }));
  const lp = run(stateDir, ["loop", "--id", id, "--node", "LT", "--state", "retry-seed"]);
  assert.equal(lp.status, 0, lp.stderr);
  state = readState(stateDir, id);
  assert.ok("LT-iter-0" in state.tasks, "the loop re-runs the failed subset as a fresh forward iteration");
  assert.equal(state.tasks["LT-iter-0"].generatedBy, "LT", "the retry iteration is generatedBy the loop");
  assert.ok(!hasCycle(state.tasks), "the retry forward-unroll stays acyclic");

  // The re-run succeeds ("b"); the final reducer R2 unions the prior accumulator (R1)
  // with the retried success — earlier successes (a, c) are NOT dropped.
  plantDoneOutput(stateDir, id, "RETRY", "b");
  const ec2 = run(stateDir, ["exec-node", "--id", id, "--node", "R2"]);
  assert.equal(ec2.status, 0, ec2.stderr);
  assert.deepEqual(readValue(stateDir, id, lines(ec2.stdout)[0]).slice().sort(), ["a", "b", "c"],
    "the final result unions the retried success with the prior accumulator (earlier successes preserved)");
});

test("V12 no-missing-input: a plain fn (require=all-done) is NOT readied while a dep is failed; a reducer (all-resolved) is", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [
    flatAgent("A", { type: "string" }),
    flatAgent("B", { type: "string" }),
    { id: "PLAIN", type: "fn", deps: ["A", "B"], module: LIFECYCLE, export: "gatherSuccesses", output_schema: { type: "array" } }, // all-done (default)
    gatherNode("RED", ["A", "B"]), // all-resolved
  ] }).stdout.trim();

  // A done, B FAILED.
  let state = readState(stateDir, id);
  state.tasks.A.status = "done";
  state.tasks.B.status = "failed";
  writeState(stateDir, id, state);

  const ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.ok(!ready.includes("PLAIN"),
    "a plain all-done fn is NOT readied while a dep is failed, so it never runs on a missing input");
  assert.ok(ready.includes("RED"), "an all-resolved reducer IS readied (it reads the failed envelope and gathers)");

  // and the reason the scheduler withholds PLAIN: its B input would be a {status:"failed"}
  // envelope — a missing input the plain contract must not run on.
  const env = JSON.parse(run(stateDir, ["resolve-context", "--id", id, "--node", "PLAIN", "--inputs"]).stdout);
  assert.deepEqual(env.B, { status: "failed" }, "PLAIN's failed dep surfaces as a {status:failed} envelope (a missing input)");
  assert.ok(!("output" in env.B), "the failed envelope carries no output");
});

// ---------------------------------------------------------------------------
// V13 / V18: divide-and-conquer Mode B — a SHIPPED skill graph + fn modules
// ---------------------------------------------------------------------------
// A Mode B skill ships a JSON folded-graph plus its `fn` module files in its own
// folder; the engine loads it (a node's RELATIVE `module` resolves against the SKILL
// DIR, where the modules ship — not the cwd that ran init), validates it, and runs
// the wide fan-out, gathering the successes even when some children fail. These tests
// run the REAL shipped example end to end, deterministically (fn `seed`/`gather` are
// executed; the per-item `agent` children are planted, not dispatched), to anchor the
// e2e task (V13: loads + runs + gathers; V18: still gathers under forced failure).
const DC_EXAMPLE_GRAPH = fileURLToPath(
  new URL("../skills/divide-and-conquer/examples/wide-research/graph.json", import.meta.url));
const DC_EXAMPLE_DIR = dirname(DC_EXAMPLE_GRAPH);

test("V13 Mode B: the shipped wide-research example validates, loads, and resolves fn modules relative to the skill dir", () => {
  const { stateDir } = ws();
  // init the REAL on-disk example graph (not a tmp copy). State + values are written
  // under the test's AMPLIFY_STATE_DIR; the skill folder itself is never written to.
  const r = run(stateDir, ["init", "--graph", DC_EXAMPLE_GRAPH]);
  assert.equal(r.status, 0, `the shipped example graph must validate + load: ${r.stderr}`);
  const id = r.stdout.trim();
  assert.match(id, HEX16, "init prints a GRAPH_ID for the example");

  const state = readState(stateDir, id);
  // init records the graph's OWN dir as the fn-module resolution base, so a relative
  // `module` resolves against the SKILL DIR rather than the cwd that ran init.
  assert.equal(state.graphDir, DC_EXAMPLE_DIR,
    "init records the graph's own directory as the fn-module resolution base");
  // the shipped relative module paths are stored VERBATIM (identity unchanged).
  assert.equal(state.tasks.seed.module, "./fns/seed.mjs", "the source fn ships its module relative to the skill dir");
  assert.equal(state.tasks.gather.module, "./fns/gather.mjs", "the gather reducer ships its module relative to the skill dir");
  assert.equal(state.tasks.gather.require, "all-resolved", "the gather reducer is all-resolved (reads failed envelopes)");
  assert.equal(state.tasks.research.type, "expand", "the fan-out is an expand over the seed list");
  assert.equal(state.tasks.research.gather, "gather", "the expand gathers into the reducer");
});

test("V18 Mode B: the wide-research fan-out gathers the successes end to end even when some children fail", () => {
  const { stateDir } = ws();
  const id = run(stateDir, ["init", "--graph", DC_EXAMPLE_GRAPH]).stdout.trim();

  // 1) the SEED fn (relative module ./fns/seed.mjs) loads from the skill dir and runs.
  //    A successful exec-node PROVES skill-dir resolution: the module is NOT under the
  //    test's cwd or stateDir, so it could only have resolved against state.graphDir.
  const es = run(stateDir, ["exec-node", "--id", id, "--node", "seed"]);
  assert.equal(es.status, 0, `seed fn must resolve + run from the skill dir: ${es.stderr}`);
  const seedRef = lines(es.stdout)[0];
  const topics = readValue(stateDir, id, seedRef);
  assert.ok(Array.isArray(topics) && topics.length >= 3, "the seed fn emits the fan-out list");

  // mark seed done with its list output so the expand can fan out (black-box plant,
  // as in the V5/V12 tests — the orchestrator's `complete` is a later concern here).
  let state = readState(stateDir, id);
  state.tasks.seed.status = "done";
  state.tasks.seed.outputRef = seedRef;
  writeState(stateDir, id, state);

  // 2) EXPAND research: one child per topic, each wired into gather.
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("research"),
    "the expand readies once the seed list exists");
  const ex = run(stateDir, ["expand", "--id", id, "--node", "research"]);
  assert.equal(ex.status, 0, ex.stderr);
  state = readState(stateDir, id);
  const childIds = topics.map((_, i) => `research-item-${i}`);
  for (const c of childIds) assert.ok(c in state.tasks, `expand created child ${c}`);

  // 3) most children succeed; force the FIRST to FAIL (the V18 forced-failure case).
  plantFailed(stateDir, id, childIds[0]);
  for (let i = 1; i < childIds.length; i++) {
    plantDoneOutput(stateDir, id, childIds[i], `findings:${topics[i]}`);
  }

  // 4) the GATHER reducer (relative module ./fns/gather.mjs -> gatherSuccesses) readies
  //    (all-resolved) and gathers ONLY the successes, dropping the failed child — no
  //    missing-input crash, and one failure does not sink the run.
  assert.ok(ids(run(stateDir, ["ready", "--id", id]).stdout).includes("gather"),
    "the all-resolved gather reducer readies despite a failed child");
  const eg = run(stateDir, ["exec-node", "--id", id, "--node", "gather"]);
  assert.equal(eg.status, 0, `gather fn must resolve + run from the skill dir: ${eg.stderr}`);
  const gathered = readValue(stateDir, id, lines(eg.stdout)[0]);
  const expected = topics.slice(1).map((t) => `findings:${t}`).sort();
  assert.deepEqual(gathered.slice().sort(), expected,
    "the run gathers every successful child's findings and drops the failed one");
});
