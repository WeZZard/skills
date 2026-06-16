#!/usr/bin/env node
// amplify:execute-plan loop-resume hook.
//
// Registered under SubagentStop and Stop. On every subagent completion it
// re-primes the orchestrator's scheduling loop with deterministic context;
// on a true stall (an active graph with running == 0) it blocks turn-end.
//
// Scoping: it passes the hook payload's session_id to `active --session` so it
// only counts graphs owned by THIS chat window. Two windows sharing one project
// dir no longer interfere — and when nothing matches (e.g. session id absent),
// it stays silent / emits {} and never blocks, so the failure mode is safe.
//
// A hook must never break the session: on ANY error it exits 0 silently.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function buildContext(graphs) {
  const lines = graphs.map(
    (g) =>
      `  - graph ${g.graphId}: ${g.ready} ready, ${g.running} running, ${g.incomplete} incomplete`
  );
  const primary = graphs[0].graphId;
  return [
    "<EXTREMELY_IMPORTANT>",
    "The amplify:execute-plan scheduling loop is NOT done. You MUST NOT end your turn.",
    "",
    "A subnode just finished. Do the following now:",
    "  1. Apply the just-completed subnode's result with the engine verb (complete / fail / resolve).",
    `  2. Run  task.mjs ready --id ${primary}  (and for every other active graph below) to recompute ready subnodes.`,
    "  3. Dispatch each newly-ready subnode in the background as you spawn it",
    "     (task.mjs dispatch --id <graphId> --node <subnode>), then keep reacting to completions.",
    "Do NOT end your turn while report shows INCOMPLETE tasks.",
    "",
    "Active graphs:",
    ...lines,
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) {
      process.exit(0);
    }
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const event = input && input.hook_event_name;
  const cwd = input && input.cwd;
  const session = input && input.session_id;
  if (!cwd) {
    process.exit(0);
  }

  let graphs;
  try {
    const taskMjs = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "task.mjs"
    );
    // Scope to this chat window via --session when the payload carries one; fall
    // back to --cwd only on an older harness that omits session_id.
    const args = [taskMjs, "active", "--cwd", cwd];
    if (session) args.push("--session", session);
    args.push("--json");
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    graphs = JSON.parse(out);
  } catch {
    process.exit(0);
  }

  if (!Array.isArray(graphs) || graphs.length === 0) {
    // No active execute-plan run for this project.
    if (event === "Stop") {
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  }

  const ctx = buildContext(graphs);

  if (event === "Stop") {
    const stalled = graphs.some((g) => g.running === 0);
    if (stalled) {
      console.log(
        JSON.stringify({
          decision: "block",
          reason: "amplify:execute-plan loop has ready work but no subagents in flight — re-priming the scheduling loop.",
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: ctx,
          },
        })
      );
    } else {
      // Every active graph is waiting on in-flight subagents — allow idle.
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  }

  // SubagentStop
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStop",
        additionalContext: ctx,
      },
    })
  );
  process.exit(0);
}

main();
