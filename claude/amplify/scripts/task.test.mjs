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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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

test("scheduling: ready returns only dependency-free .impl", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"]), task("C", ["A"])] }).stdout.trim();
  const ready = ids(run(stateDir, ["ready", "--id", id]).stdout);
  assert.deepEqual(ready, ["A.impl"]);
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
