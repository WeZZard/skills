#!/usr/bin/env bash
# PostToolUse hook - detects tool errors and suggests recover-from-errors skill

set -euo pipefail

# Read tool result from stdin
input=$(cat)

# Check for error indicators using jq for reliable JSON parsing
# The tool_response object contains error information
is_error=$(echo "$input" | jq -r '
    (.tool_response.error // false) or
    (.tool_response.success == false) or
    (.tool_response.is_error // false)
' 2>/dev/null || echo "false")

if [ "$is_error" != "true" ]; then
    # No error detected, output empty JSON
    echo '{}'
    exit 0
fi

# Output context injection as JSON for error case
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nA tool call may have failed.\n\nIf you encounter repeated failures (2+ consecutive) or feel stuck, consider using:\n\n**wezzard:recover-from-errors** - This skill helps you systematically diagnose and recover from errors.\n</EXTREMELY_IMPORTANT>"
  }
}
EOF

exit 0
