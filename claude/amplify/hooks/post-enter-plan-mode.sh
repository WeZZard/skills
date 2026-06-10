#!/usr/bin/env bash
# PostToolUse hook for EnterPlanMode - reminds Claude to use planning skills

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nYou **MUST** use the **amplify:write-plan** skill to write or update the plan.\nYou **MUST** make the plan focus on current task.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
