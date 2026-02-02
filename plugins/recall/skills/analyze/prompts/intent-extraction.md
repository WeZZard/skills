# Intent Extraction Sub-Task

## Purpose

Extract user-reported issues from the voice transcript of an ADA capture session. This is the first step in voice-first analysis - the transcript is the ground truth of user intent.

## MANDATORY: Environment

**MANDATORY:** Replace ${CLAUDE_PLUGIN_ROOT} with the actual path to the plugin root directory in ANY command invocation.

## MANDATORY: Step 1. Get Session Time Info

Command: ${ADA_BIN_DIR}/ada query {{$SESSION}} time-info

Capture `first_event_ns` and `duration_sec` for later calculations.

## MANDATORY: Step 2. Get Voice Transcript

REQUIRED: The timeout duration of this tool MUST be 3600000 MS (60 MINUTES)
Command: ${ADA_BIN_DIR}/ada query {{$SESSION}} transcribe segments --format json

This returns segments with timestamps in seconds relative to session start.

## MANDATORY: Step 3. Identify Issues

Scan the transcript for:

### Bug Reports (explicit problems)

You **MUST** be aware the non-English expression of the following list to extract from non-English transcripts:

<example>
- "crash", "crashes", "crashed"
- "error", "exception", "failed"
- "broken", "doesn't work", "not working"
- "wrong", "incorrect", "invalid"
- "missing", "disappeared", "lost"
</example>

### Unexpected Behavior (implicit problems)

You **MUST** be aware the non-English expression of the following list to extract from non-English transcripts:

<example>
- "weird", "strange", "odd"
- "expected X but got Y"
- "should be", "supposed to"
- "slow", "takes too long", "laggy"
- "doesn't respond", "frozen"
</example>

## MANDATORY: Step 4. Classify Severity

| Severity | Criteria | Examples |
|----------|----------|----------|
| CRITICAL | Data loss, crash, security issue | "crashed and lost my work", "data was deleted" |
| HIGH | Major feature broken | "can't save", "login doesn't work" |
| MEDIUM | Feature degraded but usable | "slow to load", "wrong icon displayed" |
| LOW | Cosmetic, minor annoyance | "button slightly misaligned" |

## MANDATORY: Step 5. Extract Time Windows

For each identified issue:
1. Find the segment(s) where the user describes the issue
2. Note the segment start/end times in seconds
3. Expand window by 5 seconds on each side to capture context
4. Keywords for trace filtering come from the user's description

## MANDATORY: Output Format

Return a JSON object with this exact structure:

```json
{
  "session_info": {},
  "issues": [
    {
      "id": "ISS-XXX",
      "type": "bug_report|unexpected_behavior",
      "severity": "critical|high|medium|low",
      "time_range_sec": {
        "start": [start],
        "end": [end]
      },
      "description": "[issue_description]",
      "keywords": ["[issue]", "[keywords]"],
      "user_quotes": [
        "[user_quotes_extracted_from_the_transcript]"
      ]
    }
  ]
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Sequential identifier (ISS-001, ISS-002, ...) |
| `type` | enum | `bug_report` or `unexpected_behavior` |
| `severity` | enum | `critical`, `high`, `medium`, or `low` |
| `time_range_sec` | object | Start and end times in seconds from session start |
| `description` | string | Concise summary of the issue (one sentence) |
| `keywords` | array | Terms to search for in trace events |
| `user_quotes` | array | Exact phrases from transcript supporting this issue |

## MANDATORY: Error Handling

### No Transcript Available

If `transcribe segments` returns empty or fails:

```json
{
  "session_info": {...},
  "issues": [],
  "error": "no_voice_recording",
  "fallback_suggestion": "Analyze using screenshots and trace events only"
}
```

### No Issues Found

If transcript exists but contains no bug reports or problems:

```json
{
  "session_info": {...},
  "issues": [],
  "note": "Transcript contains no reported issues. Session may be a feature demonstration rather than bug report."
}
```

## Important Notes

1. **Preserve User Intent**: Use their exact words in `user_quotes` - don't paraphrase
2. **Time Window Buffer**: Add 5 seconds before/after the mentioned time to catch setup and aftermath
3. **Keyword Selection**: Extract nouns and verbs that would appear in function/class names
4. **Conservative Classification**: When unsure between severities, choose the lower one
5. **One Issue Per Problem**: Don't combine multiple distinct problems into one issue
