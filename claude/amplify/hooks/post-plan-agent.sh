#!/usr/bin/env bash
# SubagentStop hook for Plan agent - reminds Claude to use write-plan skill before writing plan file

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStop",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nBefore writing to the plan file, you MUST invoke the **amplify:write-plan** skill using the Skill tool.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
