#!/usr/bin/env bash
# PreToolUse hook for EnterPlanMode - reminds Claude to use planning skills

set -euo pipefail

# Output context injection as JSON
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "<PLAN_MODE_REMINDER>\nYou are entering plan mode.\n\n**MANDATORY:** You MUST use these skills while planning:\n\n1. **wezzard:write-plan** - Use this skill to create and update the plan file with proper structure\n2. **wezzard:recover-from-errors** - Use this skill if you encounter repeated failures or blockers\n\nInvoke the write-plan skill BEFORE writing any plan content.\n</PLAN_MODE_REMINDER>"
  }
}
EOF

exit 0
