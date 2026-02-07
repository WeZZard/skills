#!/usr/bin/env bash
# PostToolUseFailure hook - suggests recover-from-errors skill on tool failures

set -euo pipefail

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUseFailure",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nA tool call may have failed.\n\nIf you encounter repeated failures (2+ consecutive) or feel stuck, consider using:\n\n**amplify:recover-from-errors**\n</EXTREMELY_IMPORTANT>"
  }
}
EOF
