#!/usr/bin/env bash
# SubagentStop hook for Plan agent - reminds Claude to use write-plan skill before writing plan file

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStop",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nYou **MUST** use the **amplify:write-plan** skill to write or update the Claude Code session plan file.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
