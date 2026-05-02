#!/usr/bin/env bash
# UserPromptSubmit hook

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nYou **MUST** support your every claim with evidence and references.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
