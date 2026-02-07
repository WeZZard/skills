#!/usr/bin/env bash
# PostToolUse hook for EnterPlanMode - reminds Claude to use planning skills

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nBefore writing to the plan file, you MUST invoke the **amplify:write-plan** skill using the Skill tool.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
