// Black-box tests for the amplify Stop hook.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./loop-resume.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("../scripts/task.mjs", import.meta.url));

let ROOT;
before(() => { ROOT = mkdtempSync(join(tmpdir(), "amplify-loop-resume-test-")); });
after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

let counter = 0;
function ws() {
  const dir = join(ROOT, `case-${counter++}`);
  const stateDir = join(dir, "state");
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { dir, stateDir };
}

function task(id) {
  return {
    id,
    type: "implement",
    name: `Task ${id}`,
    deps: [],
    acceptance_criteria: ["does the thing"],
    design_aspect: "Architecture",
    max_attempts: 2,
  };
}

function panel(entries) { return JSON.stringify(entries); }

function runEngine(stateDir, session, args, cwd) {
  const res = spawnSync("node", [ENGINE, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: session },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function initGraph(stateDir, dir, session, nodes) {
  const graph = { version: 1, variables: {}, plan_file: "/tmp/plan.md", nodes };
  const path = join(dir, `graph-${counter++}.json`);
  writeFileSync(path, JSON.stringify(graph));
  const res = runEngine(stateDir, session, ["init", "--graph", path], dir);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function runHook(stateDir, payload) {
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, AMPLIFY_STATE_DIR: stateDir },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

const HOLDERS = [];
after(() => { for (const h of HOLDERS) killHold(h); });

function killHold(h) {
  try { process.kill(-h.child.pid, "SIGKILL"); }
  catch { try { h.child.kill("SIGKILL"); } catch {} }
}

function startHold(stateDir, resource, owner) {
  const child = spawn("node", [ENGINE, "hold", "--resource", resource, "--owner", owner], {
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

function stopPayload(dir, session) {
  return { hook_event_name: "Stop", cwd: realpathSync(dir), session_id: session };
}

test("Stop hook stays silent when there is no active graph", () => {
  const { dir, stateDir } = ws();
  const res = runHook(stateDir, stopPayload(dir, "sess-none"));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
});

test("Stop hook continues when ready work is dispatchable despite running work", () => {
  const { dir, stateDir } = ws();
  const session = "sess-dispatchable";
  const id = initGraph(stateDir, dir, session, [task("A"), task("B")]);
  runEngine(stateDir, session, ["dispatch", "--id", id, "--node", "A.impl"], dir);

  const res = runHook(stateDir, stopPayload(dir, session));
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /continuing the scheduling loop/);
  assert.match(out.hookSpecificOutput.additionalContext, /1 dispatchable/);
  assert.match(out.hookSpecificOutput.additionalContext, /pgrep/);
  assert.match(out.hookSpecificOutput.additionalContext, /only signal/i);
});

test("Stop hook allows idle when ready work is only resource-held and running work exists", async () => {
  const { dir, stateDir } = ws();
  const session = "sess-held-running";
  const id = initGraph(stateDir, dir, session, [task("A"), task("B")]);
  runEngine(stateDir, session, ["complete", "--id", id, "--node", "A.impl"], dir);
  runEngine(stateDir, session, ["resolve", "--id", id, "--node", "A.resolve", "--panel", panel([
    { focus: "computer", executor: "subagent(amplify:computer-use)" },
  ])], dir);
  const holder = startHold(stateDir, "computer-use", "external-owner");
  assert.equal(await holder.first, "HELD");
  runEngine(stateDir, session, ["dispatch", "--id", id, "--node", "B.impl"], dir);

  const res = runHook(stateDir, stopPayload(dir, session));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});
  killHold(holder);
});

test("Stop hook continues when no running work can wake resource-held ready work", async () => {
  const { dir, stateDir } = ws();
  const session = "sess-held-stalled";
  const id = initGraph(stateDir, dir, session, [task("A")]);
  runEngine(stateDir, session, ["complete", "--id", id, "--node", "A.impl"], dir);
  runEngine(stateDir, session, ["resolve", "--id", id, "--node", "A.resolve", "--panel", panel([
    { focus: "computer", executor: "subagent(amplify:computer-use)" },
  ])], dir);
  const holder = startHold(stateDir, "computer-use", "external-owner");
  assert.equal(await holder.first, "HELD");

  const res = runHook(stateDir, stopPayload(dir, session));
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.hookSpecificOutput.additionalContext, /0 dispatchable, 1 resource-held/);
  killHold(holder);
});
