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
import { spawnSync } from "node:child_process";
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

// ready/complete/fail emit "<subnode-id>\t<executor>" per line; this extracts
// just the id column so existing id-only assertions stay readable.
function ids(s) {
  return lines(s).map((x) => x.split("\t")[0]);
}

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

function task(id, deps = [], over = {}) {
  return {
    id, name: `Task ${id}`, deps,
    acceptance_criteria: ["does the thing"],
    audit: { executor: "subagent(general-purpose)" }, max_attempts: 2,
    ...over,
  };
}

function init(stateDir, dir, graph, extra = []) {
  ensureDir(dir); ensureDir(stateDir);
  const p = join(dir, `graph-${counter++}.json`);
  writeFileSync(p, JSON.stringify(graph));
  return run(stateDir, ["init", "--graph", p, ...extra]);
}

const HEX16 = /^[0-9a-f]{16}$/;

test("init: valid snake_case graph succeeds, prints GRAPH_ID, explodes to 2N subnodes", () => {
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
    ["A.audit", "A.impl", "B.audit", "B.impl"],
  );
  assert.equal(Object.keys(state.tasks).length, 2);
});

test("init: state is written under AMPLIFY_STATE_DIR, not elsewhere", () => {
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [task("A")] });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(stateDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{16}\.json$/);
});

const invalidCases = {
  "missing required field (acceptance_criteria)": { version: 1, nodes: [{ id: "A", name: "A", deps: [], audit: { executor: "subagent(general-purpose)" }, max_attempts: 1 }] },
  "audit.executor with invalid grammar": { version: 1, nodes: [task("A", [], { audit: { executor: "subagent(bogus)" } })] },
  "missing audit": { version: 1, nodes: [task("A", [], { audit: undefined })] },
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

test("scheduling: complete .impl readies .audit; complete .audit readies the successor SET", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A"), task("B", ["A"]), task("C", ["A"])] }).stdout.trim();

  const afterImpl = ids(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(afterImpl, ["A.audit"]);

  const afterAudit = ids(run(stateDir, ["complete", "--id", id, "--node", "A.audit"]).stdout);
  assert.deepEqual(afterAudit.sort(), ["B.impl", "C.impl"]); // multi-element set
});

test("scheduling: ready/complete emit '<id>\\t<executor>' per line, carrying each subnode's executor", () => {
  const { dir, stateDir } = ws();
  // A: default impl executor + a non-default audit executor; B depends on A.
  const id = init(stateDir, dir, {
    version: 1,
    nodes: [
      task("A", [], { audit: { executor: "subagent(amplify:codex-driver)" } }),
      task("B", ["A"], { impl: { executor: "subagent(explore)" } }),
    ],
  }).stdout.trim();

  // ready: A.impl gets the default impl executor.
  const readyLines = lines(run(stateDir, ["ready", "--id", id]).stdout);
  assert.deepEqual(readyLines, ["A.impl\tsubagent(general-purpose)"]);
  for (const line of readyLines) assert.match(line, /^[^\t]+\tsubagent\(.+\)$/);

  // complete A.impl -> A.audit becomes ready with the node's audit executor.
  const afterImpl = lines(run(stateDir, ["complete", "--id", id, "--node", "A.impl"]).stdout);
  assert.deepEqual(afterImpl, ["A.audit\tsubagent(amplify:codex-driver)"]);

  // complete A.audit -> B.impl becomes ready with B's explicit impl executor.
  const afterAudit = lines(run(stateDir, ["complete", "--id", id, "--node", "A.audit"]).stdout);
  assert.deepEqual(afterAudit, ["B.impl\tsubagent(explore)"]);
});

test("failure: fail under max_attempts reopens .impl; at max_attempts marks failed and stays non-halting", () => {
  const { dir, stateDir } = ws();
  // A has max_attempts 2; B depends on A
  const id = init(stateDir, dir, { version: 1, nodes: [task("A", [], { max_attempts: 2 }), task("B", ["A"])] }).stdout.trim();

  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  // attempt 1 fails -> reopen A.impl
  const retry = ids(run(stateDir, ["fail", "--id", id, "--node", "A.audit", "--reason", "nope"]).stdout);
  assert.ok(retry.includes("A.impl"), "A.impl should reopen for retry");

  // attempt 2 fails -> exhausted -> A failed, B.impl becomes ready (non-halting)
  run(stateDir, ["complete", "--id", id, "--node", "A.impl"]);
  const exhausted = ids(run(stateDir, ["fail", "--id", id, "--node", "A.audit", "--reason", "still nope"]).stdout);
  assert.ok(exhausted.includes("B.impl"), "successor must proceed after a logged failure");

  const report = run(stateDir, ["report", "--id", id]).stdout;
  assert.match(report, /\|\s*A\s*\|.*\|\s*FAILED\s*\|/);
});

test("fail: rejects a non-audit subnode", () => {
  const { dir, stateDir } = ws();
  const id = init(stateDir, dir, { version: 1, nodes: [task("A")] }).stdout.trim();
  const r = run(stateDir, ["fail", "--id", id, "--node", "A.impl"]);
  assert.notEqual(r.status, 0);
});

test("identity: same graph + same salt => same GRAPH_ID (resume preserves state)", () => {
  const { dir, stateDir } = ws();
  const graph = { version: 1, nodes: [task("A"), task("B", ["A"])] };
  const id1 = init(stateDir, dir, graph, ["--salt", "p"]).stdout.trim();
  // advance state
  run(stateDir, ["complete", "--id", id1, "--node", "A.impl"]);
  // re-init identical graph+salt
  const id2 = init(stateDir, dir, graph, ["--salt", "p"]).stdout.trim();
  assert.equal(id1, id2);
  // state preserved: A.impl still done, so ready should be A.audit (not A.impl)
  const ready = ids(run(stateDir, ["ready", "--id", id2]).stdout);
  assert.deepEqual(ready, ["A.audit"]);
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
    ["acceptance_criteria", "audit", "deps", "id", "max_attempts", "name"],
    "schema required keys are the snake_case contract",
  );
  const node = {
    id: "A", name: "A", deps: [],
    acceptance_criteria: ["x"], audit: { executor: "subagent(general-purpose)" }, max_attempts: 1,
  };
  // every required key must be present in the node we build
  for (const k of required) assert.ok(k in node, `missing required key ${k}`);
  const { dir, stateDir } = ws();
  const r = init(stateDir, dir, { version: 1, nodes: [node] });
  assert.equal(r.status, 0, r.stderr);
});

test("unknown verb exits non-zero", () => {
  const { stateDir } = ws();
  ensureDir(stateDir);
  const r = run(stateDir, ["frobnicate"]);
  assert.notEqual(r.status, 0);
});
