#!/usr/bin/env bash
# SessionStart hook for wezzard skills plugin

set -euo pipefail

# Determine plugin root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Read using-skills content
using_skills_content=$(cat "${PLUGIN_ROOT}/references/using-skills.md" 2>&1 || echo "Error reading using-skills reference")
communicaiton_style_guidelines_content=$(cat "${PLUGIN_ROOT}/references/communication-style-guidelines.md" 2>&1 || echo "Error reading communication-style-guidelines reference")

# Escape outputs for JSON using pure bash
escape_for_json() {
    local input="$1"
    local output=""
    local i char
    for (( i=0; i<${#input}; i++ )); do
        char="${input:$i:1}"
        case "$char" in
            $'\\') output+='\\' ;;
            '"') output+='\"' ;;
            $'\n') output+='\n' ;;
            $'\r') output+='\r' ;;
            $'\t') output+='\t' ;;
            *) output+="$char" ;;
        esac
    done
    printf '%s' "$output"
}

using_skills_escaped=$(escape_for_json "$using_skills_content")
communicaiton_style_guidelines_escaped=$(escape_for_json "$communicaiton_style_guidelines_content")

# Output context injection as JSON
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${using_skills_escaped}\n\n${communicaiton_style_guidelines_escaped}"
  }
}
EOF

exit 0
