#!/usr/bin/env node
// amplify:execute-plan loop-resume hook.
//
// Registered under Stop only — fired for the MAIN agent (the execute-plan
// orchestrator). A SubagentStop hook's additionalContext is delivered to the
// subagent that stopped, not the parent orchestrator (per Claude Code's hooks
// reference), so re-priming the scheduling loop must run on the main agent's
// Stop. It prevents turn-end when the loop has dispatchable ready work or no
// running subagents left to wake the scheduler.
//
// Scoping: it passes the hook payload's session_id to `active --session` so it
// only counts graphs owned by THIS chat window. Two windows sharing one project
// dir no longer interfere — and when no graph is active (e.g. session id absent),
// it emits nothing and never blocks, so the failure mode is safe.
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
  const lines = graphs.map((g) => {
    const dispatchable = g.dispatchableReady ?? g.ready ?? 0;
    const resourceBlocked = g.resourceBlockedReady ?? 0;
    const resources = Array.isArray(g.blockedResources) && g.blockedResources.length
      ? `; held resources: ${g.blockedResources.join(",")}`
      : "";
    return `  - graph ${g.graphId}: ${g.ready} ready (${dispatchable} dispatchable, ${resourceBlocked} resource-held${resources}), ${g.running} running, ${g.incomplete} incomplete`;
  });
  const primary = graphs[0].graphId;
  return [
    "<EXTREMELY_IMPORTANT>",
    "The amplify:execute-plan scheduling loop is NOT done. You MUST continue it before ending your turn.",
    "",
    "Resume the scheduling loop now:",
    "  1. If this resume followed a subagent completion, apply that result first with the engine verb (complete / fail / resolve).",
    `  2. Run  task.mjs ready --id ${primary}  (and for every other active graph below) to recompute ready subnodes.`,
    "  3. Dispatch each resource-available ready subnode in the background as you spawn it",
    "     (task.mjs dispatch --id <graphId> --node <subnode>), then keep reacting to completions.",
    "  4. If nothing is in flight and only held resources remain, arm task.mjs wait-for-free for those resources.",
    "Do NOT end your turn while report shows INCOMPLETE tasks.",
    "A subagent's completion notification (and the verdict it returns) is the ONLY signal that its work — including any external codex/kimi process — is done. Do NOT run ps/pgrep/pkill against codex or kimi to judge completion, and do NOT kill host processes; unrelated codex/kimi processes the user started are never this run's agents.",
    "",
    "Active graphs:",
    ...lines,
    "</EXTREMELY_IMPORTANT>",
  ].join("\n");
}

function shouldContinueLoop(graphs) {
  return graphs.some((g) => {
    const dispatchable = Number(g.dispatchableReady ?? g.ready ?? 0);
    const running = Number(g.running ?? 0);
    return dispatchable > 0 || running === 0;
  });
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
      "task.mjs",
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
    // No active execute-plan run for this project — stay silent (emit nothing).
    process.exit(0);
  }

  const ctx = buildContext(graphs);

  if (event === "Stop") {
    if (shouldContinueLoop(graphs)) {
      console.log(
        JSON.stringify({
          decision: "block",
          reason:
            "amplify:execute-plan has dispatchable work or no in-flight subagents — continuing the scheduling loop.",
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: ctx,
          },
        }),
      );
    } else {
      // Active graphs are waiting on in-flight subagents or held resources that
      // those subagents can release — allow this turn to end.
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  }
}

main();
