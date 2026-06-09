# Auditor Design Guidelines

<AUDITOR_DESIGN_GUIDELINES>

## Purpose

You **MUST** use these guidelines when execute-plan spawns the `<id>.audit` subnode after the `<id>.impl` subnode completes. The auditor verifies the implementer's work and returns a verdict. `VERDICT: PASS` drives the orchestrator to call `complete`. `VERDICT: FAIL` drives the orchestrator to call `fail`, which reopens the implementer for another attempt with the findings.

## Blindness

**MUST:**

1. You **MUST** spawn the auditor as a fresh, independent subagent that did not implement the task.
2. You **MUST** include in the auditor's prompt the task spec, the `acceptance_criteria`, and pointers to the resulting artifacts (changed files, commands to run).
3. You **MUST** make the auditor verify against evidence, not against the implementer's claims.

**MUST NOT:**

1. You **MUST NOT** include the implementer's chain of thought in the auditor's prompt.
2. You **MUST NOT** include the implementer's self-justification in the auditor's prompt.

## Audit Levels

You **MUST** select the auditor based on the task's `audit_level` field. The level is decided at plan-design time and recorded as the task's `audit_level`.

- **Level 1:** An Opus blind subagent. This is the default auditor. The auditor model **MUST** default to Opus.
- **Level 2:** Delegate the audit to an external agent (Codex). You **MUST** detect Codex availability at runtime (for example, `command -v codex`). If Codex is absent, the audit **MUST** gracefully degrade to a Level 1 Opus blind subagent, and you **MUST** note that degradation in the findings and report.

You **MUST** reserve Level 2 for high-risk tasks (security, financial, or near a human gate).

## Tools

**MUST:**

1. You **MUST** grant the auditor read and verify tools: Read, Grep/Glob, and Bash only to run the task's verification commands.

**MUST NOT:**

1. You **MUST NOT** grant the auditor tools that modify files. The auditor verifies, it does not fix.

## Verification Method

**MUST:**

1. You **MUST** check each acceptance criterion individually against concrete evidence: file contents (cite file:line), command output, presence or absence of expected artifacts, and deletions actually gone.
2. You **MUST** argue with the result: understand the task goal and confirm the artifacts truly satisfy it, not merely that files exist.

## Auditor Response Contract

The auditor's final message **MUST** be exactly this structured block. The orchestrator parses it.

```markdown
TASK: <id>
CRITERIA: <each acceptance criterion → PASS|FAIL + evidence>
VERDICT: PASS | FAIL
FINDINGS: <if FAIL: concrete defects + specific fix directives for the next implementer attempt>
```

**MUST:**

1. You **MUST** emit `VERDICT: PASS` only when every acceptance criterion passes with evidence.
2. You **MUST** emit `VERDICT: FAIL` for any unmet criterion, with actionable FINDINGS that name concrete defects and specific fix directives for the next implementer attempt.
3. You **MUST** treat the `VERDICT:` token as the single source of truth the orchestrator keys on.

</AUDITOR_DESIGN_GUIDELINES>
