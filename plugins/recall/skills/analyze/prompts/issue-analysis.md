# Issue Analysis Sub-Task

## Purpose

Perform deep technical analysis of a single issue using all three data sources: trace events, screenshots, and voice transcript. Generate evidence-based hypotheses for the root cause.

## Input Parameters

This sub-task receives the following parameters from the main agent:

| Parameter | Description | Required | Example |
|-----------|-------------|----------|---------|
| `{{issue_id}}` | Issue identifier | Required | `ISS-001` |
| `{{description}}` | Issue summary | Required | `Connection shows Lost but works` |
| `{{start_sec}}` | Start time (seconds) | Required | `72.0` |
| `{{end_sec}}` | End time (seconds) | Required | `112.0` |
| `{{first_event_ns}}` | Session first event (nanoseconds) | Required | `1652017000000000` |
| `{{keywords}}` | Search terms | Required | `connection, lost, status` |
| `{{user_quotes}}` | User's exact words | Required | Array of strings |
| `{{user_analysis}}` | User's analysis before issue | Optional | Array of strings |

## MANDATORY: Environment

**MANDATORY:** Replace ${CLAUDE_PLUGIN_ROOT} with the actual path to the plugin root directory in ANY command invocation.

## MANDATORY: Step 1. Calculate Nanosecond Time Window

Convert seconds to nanoseconds relative to first event:

```
start_ns = first_event_ns + (start_sec * 1,000,000,000)
end_ns = first_event_ns + (end_sec * 1,000,000,000)
```

<example>
- `first_event_ns = 1652017000000000`
- `start_sec = 72.0`
- `start_ns = 1652017000000000 + 72000000000 = 1652089000000000`
</example>

## MANDATORY: Step 2. Extract Visual Context

Get screenshots at key moments:

**Screenshot at issue start**

Command: ${ADA_BIN_DIR}/ada query @latest screenshot --time {{start_sec}} --output /tmp/{{issue_id}}_start.png

**Screenshot at issue end**

Command: ${ADA_BIN_DIR}/ada query @latest screenshot --time {{end_sec}} --output /tmp/{{issue_id}}_end.png

**Screenshot at midpoint if window > 20 seconds**

Command: ${ADA_BIN_DIR}/ada query @latest screenshot --time <midpoint_sec> --output /tmp/{{issue_id}}_mid.png

Read each screenshot using the Read tool and note:

- UI state (dialogs, panels, indicators)
- Error messages visible
- User interaction context

## MANDATORY: Step 3. Query Trace Events

**Get all events in time window**

Command: ${ADA_BIN_DIR}/ada query @latest events --since-ns <start_ns> --until-ns <end_ns> --limit 200

**If too many events, filter by keywords**

Command: ${ADA_BIN_DIR}/ada query @latest events --since-ns <start_ns> --until-ns <end_ns> --function <keyword> --limit 100

## MANDATORY: Step 4. Analyze Trace Patterns

Look for these anomalies in the trace:

### Exception Patterns

- Functions that returned but didn't enter (missing entry)
- Entry without corresponding return (crash/exception)
- Error return values

### Timing Anomalies

- Gaps > 100ms between related events (potential blocking)
- Rapid repeated calls (potential busy loop)
- Out-of-order events (race condition)

### State Inconsistencies

- Getter/setter pairs where set never called
- Property access patterns that don't match expected flow
- Missing state update calls

## MANDATORY: Step 5. Get Transcript Context

Command: ${ADA_BIN_DIR}/ada query @latest transcribe segments --since {{start_sec}} --until {{end_sec}}

Note what the user was doing and saying during this window.

## MANDATORY: Step 6. Correlate Evidence

Build a timeline combining all sources:

<example>
| Time (sec) | Source | Event |
|------------|--------|-------|
| 72.0 | user | "I'm switching to Local mode now" |
| 72.1 | trace | `ConnectionManager.setMode("local")` enter |
| 72.1 | trace | `ConnectionManager.setMode("local")` return |
| 72.2 | visual | Status indicator shows "Connection Lost" |
| 72.5 | trace | `StatusView.update()` not called |
| 73.0 | user | "Wait, the connection is still there" |
</example>

## MANDATORY: Step 7. Generate Hypotheses

For each potential cause:
1. State the hypothesis clearly
2. List supporting evidence from trace/visual/user
3. Narrate how the evidence supports the hypothesis
4. Rate likelihood (high/medium/low)
5. Suggest verification steps proving the hypothesis is a valid fix.

## Output Format

Return a JSON object with this exact structure:

```json
{
  "issue_id": "{{issue_id}}",
  "issue_description": "{{description}}",
  "time_window": {
    "start_sec": "[issue_start_sec]",
    "end_sec": "[issue_end_sec]",
    "start_ns": "[issue_start_ns]",
    "end_ns": "[issue_end_ns]"
  },
  "potential_causes": [
    {
      "likelihood": "high|medium|low",
      "cause": "[hypothesis_written_in_step_7]",
      "narration": "[narration_written_in_step_7]",
      "evidence": [
        {
          "time_sec": [evidence_time_sec],
          "source": "user|visual|trace",
          "event": "[transacript_digest]"|"[screensnapshot_path]"|"[function_name] started|ended"
          "observations": ["[visual_event_observation_1]", "[visual_event_observation_2]"]
        }
      ]
      "verification": [
        "Step 1. [step_1_of_the_verification_steps_written_in_step_7]",
        "Step 2. [step_2_of_the_verification_steps_written_in_step_7]"
      ]
    }
  ]
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `issue_id` | string | Sequential identifier (ISS-001, ISS-002, ...) |
| `issue_description` | string | Issue description. |
| `time_window` | dict | The issue happened time window. |
| `time_window.start_sec` | string | The start of the issue happened time window in seconds. |
| `time_window.end_sec` | string | The end of the issue happened time window in seconds. |
| `time_window.start_ns` | string | The start of the issue happened time window in nanoseconds. |
| `time_window.end_ns` | string | The end of the issue happened time window in nanoseconds. |
| `potential_causes` | array | Array of potential causes of the issue. |
| `potential_causes[n].likelihood` | enum | `high`, `medium`, `low` |
| `potential_causes[n].cause` | string | Potential cause of the issue {n}. |
| `potential_causes[n].narration` | string | Narration of how the evidence supports the hypothetical cause of the issue {n}. |
| `potential_causes[n].evidence` | array | Array of evidence supporting the hypothetical cause of the issue {n}. |
| `potential_causes[n].evidence[n].source` | enum | `trace`, `visual`, `user` |
| `potential_causes[n].evidence[n].event` | string | Event related to the evidence. |
| `potential_causes[n].evidence[n].observations` | array | Array of observations related to the evidence. Only applicable for visual source evidence. |
| `potential_causes[n].verification` | array | Array of verification steps of the fix of the issue {n}. |

## MANDATORY: Error Handling

### No Trace Events in Window

```json
{
  "issue_id": "{{issue_id}}",
  "analysis_summary": "Unable to analyze - no trace events in time window",
  "potential_causes": [],
  "timeline": [],
  "error": "no_trace_events",
  "suggestion": "Check if the application was running during this time window"
}
```

### Screenshot Unavailable

Continue analysis with trace and transcript only. Note in output:

```json
"screenshots_analyzed": [],
"note": "No screen recording available for this session"
```

## Important Notes

1. **Evidence-Based**: Every hypothesis must cite specific trace functions, visual observations, or user statements
2. **Trace-First**: Trace data is the most precise - prioritize it over screenshots
3. **Timeline Precision**: Use nanosecond precision internally, report in seconds for readability
4. **Function Names**: Include full path (Class.method) for trace functions
5. **Conservative Likelihood**: Mark as "high" only when multiple evidence sources agree
