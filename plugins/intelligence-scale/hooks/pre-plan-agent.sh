#!/usr/bin/env bash
# PreToolUse hook for Task with subagent_type=Plan - reminds Claude to use planning skills

set -euo pipefail

# Read tool parameters from stdin
input=$(cat)

# Check if subagent_type is "Plan"
subagent_type=$(echo "$input" | grep -o '"subagent_type"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)

if [ "$subagent_type" != "Plan" ]; then
    # Not a Plan agent, output empty JSON
    echo '{}'
    exit 0
fi

# Output context injection as JSON for Plan agent
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nYou are spawning a Plan subagent.\n\n**MANDATORY:** The Plan agent MUST use these skills:\n\n1. **wezzard:write-plan** - Use this skill to create and update the plan file with proper structure\n2. **wezzard:recover-from-errors** - Use this skill if encountering repeated failures or blockers\n\nThe Plan agent should invoke the write-plan skill BEFORE writing any plan content.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF

exit 0
