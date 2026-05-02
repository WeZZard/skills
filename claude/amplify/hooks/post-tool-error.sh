#!/usr/bin/env bash
# PostToolUseFailure hook - suggests recover-from-errors skill on tool failures

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUseFailure",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nUse **amplify:recover-from-errors** skill when you encounter repeated failures (2+ consecutive) or feel stuck.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
