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

## Executor Selection

You **MUST** choose `audit.executor` per `${CLAUDE_PLUGIN_ROOT}/references/executor-selection-guidelines.md`. When the executor is a built-in subagent, grant its tools to fit the task:

### Built-tin Agents Model-Tier Selection

You **MUST** choose the model tier from the task's actual complexity. You **MUST NOT** default to a single tier for every task.

- **Haiku:** Use for trivial mechanical edits—a single tiny edit, a rename, a one-line config change.
- **Sonnet:** Use for normal implementation—multi-file or multi-step changes with ordinary logic.
- **Opus:** Use for reasoning-heavy tasks of bounded scope—intricate logic, cross-cutting design, or subtle correctness concerns.
- **Fable:** Use for the most demanding tasks of large or long-horizon scope—multi-step agentic work, deep cross-system reasoning, or high-stakes correctness; the most capable tier, and the most costly.

## Tools

The Agent tool can set only `model` at spawn, not `tools`/`mcpServers`. Therefore:

**MUST:**

1. For a built-in executor (no custom agent file), you **MUST** spawn it read-only: Read, Grep, Glob, Bash (Bash for the task's verification commands only).
2. For a driver executor (`subagent(amplify:<name>)`), you **MUST** rely on that driver file's frontmatter for tools/MCP and pass only `model` plus the prompt.

**MUST NOT:**

1. You **MUST NOT** grant any auditor tools that modify files. The auditor verifies, it does not fix.
2. You **MUST NOT** attempt to set tools or mcpServers at spawn — they are ignored.

## Spawning Prompt Template

You **MUST** replace every `<...>` placeholder.

**Shared blind-audit prompt body:**

<AUDITOR_SPAWNINING_PROMPT_TEMPLATE>

````markdown
## Goal

You are a BLIND AUDITOR for task <id>.
You did not implement it.
Verify against evidence, not against any claim.
Do not modify files.

TASK GOAL: <task name / one-line goal>
ARTIFACTS TO INSPECT: <changed files / globs>

**ACCEPTANCE CRITERIA:**

<ACCEPTANCE_CRITERIA>
- <criterion 1>
- <criterion 2>
</ACCEPTANCE_CRITERIA>

## Verification Method

**MUST:**

1. You **MUST** check each acceptance criterion individually against concrete evidence: file contents (cite file:line), command output, presence or absence of expected artifacts, and deletions actually gone.
2. You **MUST** argue with the result: understand the task goal and confirm the artifacts truly satisfy it, not merely that files exist.

## Response

You **MUST** return **EXACTLY** this block as your final message, with no extra commentary:

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

````

</AUDITOR_SPAWNINING_PROMPT_TEMPLATE>

This blind-audit prompt body is the auditor's prompt. `execute-plan` spawns the chosen `audit.executor` with it under the single spawn strategy in its scheduling loop; this file does not restate how to spawn.

</AUDITOR_DESIGN_GUIDELINES>
