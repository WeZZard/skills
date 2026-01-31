#!/usr/bin/env bash
# PostToolUse hook - detects tool errors and suggests recover-from-errors skill

set -euo pipefail

# Read tool result from stdin
input=$(cat)

# Check for error indicators in the result
# Look for common error patterns: "error", "failed", "Error:", exit codes, etc.
has_error=false

# Check for error field or error patterns
if echo "$input" | grep -qi '"error"[[:space:]]*:[[:space:]]*"[^"]\+"\|"error"[[:space:]]*:[[:space:]]*true'; then
    has_error=true
elif echo "$input" | grep -qi '"exitCode"[[:space:]]*:[[:space:]]*[1-9]\|"exit_code"[[:space:]]*:[[:space:]]*[1-9]'; then
    has_error=true
elif echo "$input" | grep -qi '"status"[[:space:]]*:[[:space:]]*"failed"\|"status"[[:space:]]*:[[:space:]]*"error"'; then
    has_error=true
fi

if [ "$has_error" = "false" ]; then
    # No error detected, output empty JSON
    echo '{}'
    exit 0
fi

# Output context injection as JSON for error case
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<TOOL_ERROR_DETECTED>\nA tool call may have failed.\n\nIf you encounter repeated failures (2+ consecutive) or feel stuck, consider using:\n\n**wezzard:recover-from-errors** - This skill helps you systematically diagnose and recover from errors.\n</TOOL_ERROR_DETECTED>"
  }
}
EOF

exit 0
