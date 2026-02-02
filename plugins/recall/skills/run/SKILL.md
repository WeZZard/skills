---
name: run
description: "Run any app, program."
---

# Run Application with ADA Capture

## Purpose

Launch an application with ADA tracing enabled, capturing execution traces, voice narration, and screen recording for later analysis.

## MANDATORY: Environment Setup

Before running any ada command, set the environment:

<example>
export ADA_AGENT_RPATH_SEARCH_PATHS="${ADA_LIB_DIR}"
</example>

**IMPORTANT**: Always use the full path `${ADA_BIN_DIR}/ada` for commands to avoid conflicts with other `ada` binaries in PATH.

## Workflow

### MANDATORY: Step 1. Preflight Check

**If $PREFLIGHT_CHECK is set to 1, skip to Step 1.**

Run the ADA doctor to verify all dependencies:

<example>
${ADA_BIN_DIR}/ada doctor check --format json
</example>

Parse the JSON output. Check all fields are `ok: true`.

**If any check fails:**
1. Show the user which checks failed with fix instructions
2. Stop and ask user to fix issues
3. After fixes, re-run `ada doctor check`

**If all checks pass:**
- Set `$PREFLIGHT_CHECK = 1`
- Continue to Step 1

### MANDATORY: Step 2. Project Detection

You ***MUST** explore the project to find the app to run and the build system building it.

### MANDATORY: Step 3. Build (if applicable)

You MAY use the app's build system to build the app.

### MANDATORY: Step 4. Start Capture

Start capturing with the following command:

<example>
${ADA_BIN_DIR}/ada capture start <binary_path>
</example>

**Report to user:**

> **Capturing**
>
> Session directory path: [session_directory_path]
>

#### If the `ada capsture` command succeeds

Report to user:

> **Capture Completed**
>
> Session directory path: [session_directory_path]
> Use `/ada:analyze` skill to analyze the captured data
>

**Hand-off to Analyze**

After report to user, you MUST use `/ada:analyze` skill to analyze the captured data

#### Otherwise

You MUST show the error message and ask the user to fix it.

### Capture

## Error Handling

- **Build failure**: Show build errors, suggest fixes
- **Binary not found**: Guide user to specify path manually
