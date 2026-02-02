---
name: analyze
description: Analyze ADA session - correlates voice, screen, and trace data for diagnosis
---

# Analyze ADA Capture Session

## Purpose

Analyze a captured ADA session using a voice-first workflow that extracts user intent from transcripts, then correlates with trace events and screenshots for evidence-based diagnosis.

## MANDATORY: Environment

**MANDATORY:** Replace ${CLAUDE_PLUGIN_ROOT} with the actual path to the plugin root directory.

**MANDATORY:** Before running any ada command, set the environment:

```bash
export ADA_AGENT_RPATH_SEARCH_PATHS="${ADA_LIB_DIR}"
```

**IMPORTANT**: Always use the full path `${ADA_BIN_DIR}/ada` for commands to avoid conflicts with other `ada` binaries in PATH.

## Recognize Session To Analyze

You MUST recognize session to analyze and set $SESSION to the session ID.

## MANDATORY: Step 0. Preflight Check

**If $PREFLIGHT_CHECK is set to 1, skip to Step 1.**

Run the ADA doctor to verify all dependencies:

```bash
${ADA_BIN_DIR}/ada doctor check --format json
```

Parse the JSON output. Check all fields are `ok: true`.

**If any check fails:**
1. Show the user which checks failed with fix instructions
2. Stop and ask user to fix issues
3. After fixes, re-run `ada doctor check`

**If all checks pass:**
- Set `$PREFLIGHT_CHECK = 1`
- Continue to Step 1

## MANDATORY: Step 1. Intent Extraction

You **MUST** use Task tool with the following invocation which carries an inlined task prompt to extract user intents from the voice transcript in the session bundle.
You **MUST** evaluate the variable wrapped by `{{}}` like `{{$VAR}}` in the inlined task prompt before spawning the task agent.

Task(
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt:
  """
  Set $SESSION to {{$SESSION}}
  You MUST read and follow the instructions in: prompts/intent-extraction.md
  You MUST return the JSON output as specified in that document.
  """
)

**CRITICAL: Wait for Result**: The task returns a JSON object with:

- `session_info`: First event timestamp and duration
- `issues`: Array of identified issues with severity, time windows, and keywords

**CRITICAL: If No Issues Found**:

If `issues` array is empty, you MUST inform the user:

> No issues found in the session.
>
> You can ask me to output the transcript and identify potential issues in the texts.

Then **STOP**.

## MANDATORY: Step 2. Filtering Detected Issues

**CRITICAL: Skip this step if**: All issues are CRITICAL or HIGH severity (analyze all automatically).

If the intent extraction found issues, present those non-CRITICAL and non-HIGH severity issues with AskUserQuestion tool to the user for selection.

**Use AskUserQuestion:**
```json
{
  "questions": [{
    "question": "Which issues should we analyze? Critical and high issues will be analyzed automatically.",
    "header": "Issues",
    "multiSelect": true,
    "options": [
      {
        "label": "{{issues[0].issue.id}} ({{issues[0].issue.severity}})",
        "description": "{{issues[0].issue.description}}"
      },
      {
        "label": "{{issues[1].issue.id}} ({{issues[1].issue.severity}})",
        "description": "{{issues[1].issue.description}}"
      },
      {
        "label": "Analyze all",
        "description": "Include all identified issues"
      }
    ]
  }]
}
```

You **MUST** identify if the user response in the other field contains issue analysis.
If the user response contains issue analysis, set it to **$USER_ANALYSIS**.

## MANDATORY: Step 3. Analysis

For each selected issue, you **MUST** use Task tool with the following invocation which carries an inlined task prompt to analyze.
You **MUST** evaluate the variable wrapped by `{{}}` like `{{$VAR}}` or `{{var}}` in the inlined task prompt before spawning the task agent.
You **MUST** follow the guidances in the HTML comments (<!-- COMMENTS -->) to evaluate the inlined task prompt.

Task(
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt:
  """
  You MUST read and follow the instructions in: prompts/issue-analysis.md

  Analyze this issue:
  - Issue ID: {{issue.id}}
  - Description: {{issue.description}}
  - Start time (seconds): {{issue.time_range_sec.start}}
  - End time (seconds): {{issue.time_range_sec.end}}
  - First event (nanoseconds): {{session_info.first_event_ns}}
  - Keywords: {{issue.keywords}}
  - User quotes: {{issue.user_quotes}}
  - User analysis: {{$USER_ANALYSIS}} <!-- User response is optional and only capable if $USER_ANALYSIS is not empty and related to issue {{issue.id}} -->

  Return the JSON output as specified in that document.
  """
)

Set task agent ID to **$ANALYSIS_TASK_AGENT_ID**

**Spawn all tasks in a single message** to run them in parallel. Use multiple Task tool invocations.

**Collect Results**: Wait for all parallel tasks to complete.

## MANDATORY: Step 4. Merge Findings

Combine all analysis results into a summary table for the user.

**Output Format:**

```markdown
## Analysis Summary

| Issue | Severity | Description | Primary Cause | Likelihood |
|-------|----------|-------------|---------------|------------|
| ISS-001 | [issue_001_severity] | [issue_001_description] | [issue_001_primary_cause] | [issue_001_primary_cause_likelihood] |
| ISS-002 | [issue_002_severity] | [issue_002_description] | [issue_002_primary_cause] | [issue_002_primary_cause_likelihood] |
| ... | ... | ... | ... | ... |

### Detailed Findings

#### ISS-001: [issue_001_description]
**Primary Hypothesis:** [issue_001_primary_hypothesis]
- **Evidence:** [issue_001_evidence]
- **Visual:** [issue_001_visual]
- **User:**
> [issue_001_user_quote]
**Suggested Code Areas:** [issue_001_suggested_code_areas]

#### ISS-002: [issue_002_description]
**Primary Hypothesis:** [issue_002_primary_hypothesis]
- **Evidence:** [issue_002_evidence]
- **Visual:** [issue_002_visual]
- **User:**
> [issue_002_user_quote]
**Suggested Code Areas:** [issue_002_suggested_code_areas]

...
```

## MANDATORY: Step 5. Ready to Fix or Add Additional Information

Present findings and ask user which issues to investigate further.

**Use AskUserQuestion:**

```json
{
  "questions": [
    {
      "header": "Ready to fix?",
      "question": "Before we start fixing these issues, would you like to add any more details?",
      "multiSelect": false,
      "options": [
        {
          "label": "Start fixing now.",
          "description": "No additional details. Go ahead and fix them.
        }
      ]
    }
  ]
}
```

**If additional information is provided:** Set additional information to **$USER_ADDITIONAL_INFO**

You MUST evaluate if the additional information contradicts the existing hypothesis of any issues.

- If the additional information **DOES** contradict the existing hypothesis of any issues:

  For each this kind of issue, You MUST use Task tool to resume the task used for analyzing the issue.
  You **MUST** evaluate the variable wrapped by `{{}}` like `{{$VAR}}` in the task invoation before spawning the task agent.
  You **MUST** follow the guidances in the HTML comments (<!-- COMMENTS -->) to evaluate the inlined task prompt.

  Task(
    subagent_type: "general-purpose",
    run_in_background: false,
    prompt:
    """
    ## User Feedback

    **User feedback contradicts with the hypothesis:**
    
    <!-- User feedback extracted from $USER_ADDITIONAL_INFO that related to the issue -->
    
    """,
    resume: {{$ANALYSIS_TASK_AGENT_ID}}
  )

  **Spawn all tasks in a single message** to run them in parallel. Use multiple Task tool invocations.
  **Collect Results**: Wait for all parallel tasks to complete.
  **MANDATORY:** Goto Step 4 to re-merge the findings

- If the additional information **DOES NOT** contradict the existing hypothesis of any issues:

  You MUST set these additional information to **$COMPLEMENTARY_INFO**
  Continue to Step 6.

## MANDATORY: Step 6. Enter Plan Mode

Call **EnterPlanMode** to create a plan for fixing the issues.

You MUST spawn a **Plan** task to create the plan file.
You **MUST** evaluate the variable wrapped by `{{}}` like `{{$VAR}}` in the task invoation before spawning the task agent.
You **MUST** follow the guidances in the HTML comments (<!-- COMMENTS -->) to evaluate the inlined task prompt.
  
Task(
  subagent_type: "Plan",
  run_in_background: false,
  prompt:
  """
  The user wants to fix the following identified issues:
  
  [Include for each selected issue:]
  - Issue ID and description
  - Primary hypothesis with likelihood
  - Narration of how the evidence supports the hypothesis
  - Suggest verification steps
  - Recommended code areas to investigate
  - Evidence summary

  <!-- ONLY APPLICABLE WHEN $COMPLEMENTARY_INFO IS NOT EMPTY -->
  Additionally, the user provided the following information:
  {{$COMPLEMENTARY_INFO}}
  <!-- ONLY APPLICABLE WHEN $COMPLEMENTARY_INFO IS NOT EMPTY -->

  Create a plan to fix these issues. The plan should:
  1. Verify each hypothesis with targeted code review
  2. Propose specific code changes
  3. Include test cases to prevent regression
  """
)

Call **ExitPlanMode** to make the user review the plan.

## CRITICAL: Error Handling

### No Session Found

```bash
${ADA_BIN_DIR}/ada query @latest time-info
```
If this fails, guide user to use `ada:run` skill first to capture a session.

### No OpenAI Whisper Installed

If OpenAI Whisper is not installed:
1. Inform user: "OpenAI Whisper is not installed. Cannot perform voice analysis."
2. Suggest installing it using `brew install openai-whisper`
3. For full system check, suggest running the `ada-doctor` skill.

### No FFMPEG Installed

If FFMPEG is not installed:
1. Inform user: "FFMPEG is not installed. Cannot perform screen analysis."
2. Suggest installing it using `brew install ffmpeg`
3. For full system check, suggest running the `ada-doctor` skill.

### No Voice Recording

If the session has no voice transcript:
1. Inform user: "This session was captured without voice. Switching to trace-first analysis."
2. Skip Step 1 (intent extraction)
3. Query all trace events and look for anomalies:
   - Exceptions or errors
   - Long gaps (potential hangs)
   - Unexpected function sequences
4. Present findings and continue from Step 5

### No Screen Recording

Continue with trace and transcript. Note in findings that visual correlation is unavailable.

### Empty Trace

If no trace events exist:
1. Inform user: "No trace events found in this session."
2. Check if the correct process was traced
3. Suggest re-running capture with correct target

---

## CRITICAL: ADA Query Commands Quick Reference

```bash
# Session info
${ADA_BIN_DIR}/ada query @latest time-info

# List sessions
${ADA_BIN_DIR}/ada query --list-sessions

# Voice transcript (JSON for parsing)
# REQUIRED: The timeout duration of this tool MUST be 3600000 MS (60 MINUTES)
${ADA_BIN_DIR}/ada query @latest transcribe segments --limit 100 --format json

# Voice transcript (time range)
# REQUIRED: The timeout duration of this tool MUST be 3600000 MS (60 MINUTES)
${ADA_BIN_DIR}/ada query @latest transcribe segments --since <sec> --until <sec>

# Screenshot at time
${ADA_BIN_DIR}/ada query @latest screenshot --time <seconds> --output <path>

# Trace events (time range)
${ADA_BIN_DIR}/ada query @latest events --since-ns <ns> --until-ns <ns> --limit 100

# Trace events (function filter)
${ADA_BIN_DIR}/ada query @latest events --function <name> --limit 100
```
