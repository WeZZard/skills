---
name: ada-doctor
description: ADA system health check - verifies dependencies for capture and analysis
---

# ADA Doctor

## Purpose

Check system health and dependencies for ADA capture and analysis workflows.

## Environment

**MANDATORY:** Before running any ada command, set the environment:

```bash
export ADA_AGENT_RPATH_SEARCH_PATHS="${ADA_LIB_DIR}"
```

## MANDATORY: Step 0. Preflight Check

**If $PREFLIGHT_CHECK is set to 1:**
- Inform user: "Preflight already passed this session."
- Still run `ada doctor check` to show current status (user explicitly requested it)

**If $PREFLIGHT_CHECK is not set:**
- Run `ada doctor check`
- If all checks pass, set `$PREFLIGHT_CHECK = 1`

## Usage

Run the doctor command:

```bash
${ADA_BIN_DIR}/ada doctor check
```

For JSON output (useful for programmatic parsing):

```bash
${ADA_BIN_DIR}/ada doctor check --format json
```

## Output Interpretation

Present the results to the user:

- Items marked with a checkmark are ready to use
- Items marked with an X need attention with fix instructions

### Example Text Output

```
ADA Doctor
==========

Core:
  ✓ frida agent: /path/to/libfrida_agent.dylib

Analysis:
  ✓ whisper: /opt/homebrew/bin/whisper
  ✗ ffmpeg: not found
    → brew install ffmpeg

Status: 1 issue found
```

### Example JSON Output

```json
{
  "status": "issues_found",
  "checks": {
    "frida_agent": { "ok": true, "path": "/path/to/lib" },
    "code_signing": { "ok": true },
    "whisper": { "ok": true, "path": "/opt/homebrew/bin/whisper" },
    "ffmpeg": { "ok": false, "fix": "brew install ffmpeg" }
  },
  "issues_count": 1
}
```

## Checks Performed

| Category | Check | Description |
|----------|-------|-------------|
| **Core** | Frida agent library | Checks `ADA_AGENT_RPATH_SEARCH_PATHS` or known paths for `libfrida_agent.dylib` |
| **Analysis** | Whisper installed | Checks for OpenAI Whisper via `which whisper` |
| **Analysis** | FFmpeg installed | Checks for FFmpeg via `which ffmpeg` |

**NOT checked by doctor** (checked at runtime when capture starts):
- Screen recording permission - Triggers OS dialog if checked
- Microphone access - Triggers OS dialog if checked

## Issue Resolution

If issues are found:

1. Show which components are affected (capture vs analysis)
2. Provide exact fix commands
3. Suggest re-running doctor after fixes

### Common Fixes

- **Frida agent not found**: Set `ADA_AGENT_RPATH_SEARCH_PATHS` environment variable
- **Whisper not found**: `brew install openai-whisper`
- **FFmpeg not found**: `brew install ffmpeg`
