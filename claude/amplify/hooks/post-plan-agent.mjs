#!/usr/bin/env node
// amplify PostToolUse(Agent) hook — runs in the MAIN agent after a subagent
// returns. When that subagent was the built-in "Plan" agent, it reminds the
// main agent to use the amplify:write-plan skill to write the session plan file.
//
// Why PostToolUse and not SubagentStop: a SubagentStop hook's additionalContext
// is injected into the subagent that stopped, not the parent — so the reminder
// would never reach the orchestrator that actually writes the plan. A PostToolUse
// hook's additionalContext is appended to the tool result in the CALLING (parent)
// agent — the orchestrator — which is the one that uses write-plan.
//
// A PostToolUse matcher only filters by tool name, so this fires for every
// subagent; it emits the reminder only when tool_input.subagent_type === "Plan".
//
// A hook must never break the session: on ANY error it exits 0 silently.

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

const REMINDER =
  "<EXTREMELY_IMPORTANT>\n" +
  "You **MUST** use the **amplify:write-plan** skill to write or update the Claude Code session plan file.\n" +
  "</EXTREMELY_IMPORTANT>";

async function main() {
  let input;
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) process.exit(0);
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Only react to the built-in Plan subagent finishing; otherwise stay silent.
  if (!input || input.tool_input?.subagent_type !== "Plan") {
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: REMINDER,
      },
    })
  );
  process.exit(0);
}

main();
