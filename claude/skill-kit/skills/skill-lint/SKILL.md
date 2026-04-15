---
name: skill-lint
description: Audit skill/prompt files for structural issues and JSON schema format coherence issues. Requires --agent parameter to select LLM backend (codex, gemini, copilot, claude, cursor, kimi) for semantic analysis.
---

# Skill Lint

## Overview

Audit skill/prompt files for structural issues, step continuity, cross-reference integrity, and JSON schema format coherence. Uses a two-phase approach: automated deterministic checks followed by LLM semantic analysis dispatched to the agent specified by `--agent`.

**This is a rigid skill. Follow it exactly.**

**Usage:** `/skill-lint --agent <agent> <path>`

**`--agent` is required.** One of: `codex`, `gemini`, `copilot`, `claude`, `cursor`, `kimi`.

If `--agent` is omitted, announce: "Error: `--agent` is required. Usage: `/skill-lint --agent <codex|gemini|copilot|claude|cursor|kimi> <path>`" and stop.

**Announce at start:** "I'm using the skill-lint skill to audit [path] with [agent] as the LLM backend."

## The Process

### Step 1: Accept and Resolve Input Path

The skill accepts a directory or file path as its argument.

1. If **directory**: Use Glob to find `SKILL.md`, `*.md`, and other prompt definition files. Identify the skill structure (frontmatter, steps, JSON blocks).
2. If **file**: Read the single file directly.
3. Use **Explore subagents** to gather context needed for linting — read referenced files, check if cross-referenced tools/skills exist, understand the skill's domain.

You MUST read every file before linting it. Do NOT work from memory or assumptions.

### Step 2: Phase 1 — Automated Deterministic Checks

Use Grep, Glob, and regex directly (no subagents) to verify mechanically checkable properties. These produce definitive pass/fail results.

#### Category A: Frontmatter Validation

- `name` field exists and is non-empty
- `description` field exists and is non-empty
- `name` matches the parent directory name (e.g., `skill-lint/SKILL.md` → `name: skill-lint`)
- No unknown frontmatter fields beyond `name` and `description`

#### Category B: Step Continuity

- Step numbers are sequential (no gaps: Step 1, Step 3 without Step 2)
- Sub-step numbers are sequential within their parent (1.1, 1.2, 1.3 — no gaps)
- Every step referenced elsewhere in the document (e.g., "see Step 3") actually exists
- No orphan sub-steps (e.g., Step 2.1 without a Step 2 header)

#### Category C: Cross-Reference Integrity

- Tool names referenced (e.g., "use the **Read** tool") match known Claude Code tools: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `Agent`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `EnterPlanMode`, `ExitPlanMode`, `TaskCreate`, `TaskUpdate`, `NotebookEdit`, `Skill`, `SendMessage`, `ToolSearch`
- Skill names referenced (e.g., "invoke `amplify:write-plan`") follow valid `plugin:skill` format
- No obvious typos in tool/skill references

### Step 3: Phase 2 — LLM Semantic Checks

Dispatch semantic analysis to the agent specified by `--agent`. The checks are split into 5 groups, each with its own prompt template in the `prompts/` directory adjacent to this SKILL.md.

#### Check Groups

| Group | Prompt Template | Categories |
|-------|----------------|------------|
| 1 | `prompts/agent1-must-consistency.md` | D: MUST/MUST NOT Consistency |
| 2 | `prompts/agent2-numeric-ungrounded.md` | E1: Numeric as String + E2: Ungrounded Fields |
| 3 | `prompts/agent3-format-constraints.md` | E3: Non-Interpretation Fields Without Format Constraints |
| 4 | `prompts/agent4-field-names.md` | E4: Inconsistent Field Names Across Schemas |
| 5 | `prompts/agent5-enums-freetext.md` | E5: Open-Ended Enums + E6: Structured Data as Free-Text |

Each agent MUST return findings as a JSON array with fields: **category**, **field_path**, **current_text**, **issue**, **suggested_fix**, **severity**.

#### When `--agent claude`

Launch **5 internal Claude Code subagents in a single message** for maximum parallelism. Each subagent receives the full file content and the check instructions from the corresponding prompt template.

| Subagent | Prompt Template | Model | Rationale |
|----------|----------------|-------|-----------|
| 1 | `agent1-must-consistency.md` | Sonnet | Needs full-file reasoning to detect contradictions and redundancy across distant sections |
| 2 | `agent2-numeric-ungrounded.md` | Haiku | Pattern-matching with clear heuristics; high-volume, low-complexity |
| 3 | `agent3-format-constraints.md` | Sonnet | Requires understanding of verbatim-transfer semantics and domain context |
| 4 | `agent4-field-names.md` | Sonnet | Cross-schema semantic similarity analysis; needs nuanced judgment |
| 5 | `agent5-enums-freetext.md` | Haiku | Pattern-based detection with clear signals |

#### When `--agent` is an external agent

For each of the 5 check groups:

1. Read the prompt template file from `prompts/`.
2. Substitute `{FILE_CONTENT}` with the actual content of the file being linted.
3. Write the composed prompt to a temporary file.
4. Invoke the external agent via a **background Bash call** (`run_in_background: true`, no timeout).

Launch all **5 background Bash calls in a single message** for maximum parallelism. Wait for all 5 to complete (you will be notified automatically).

**CLI invocation patterns:**

| Agent | Command |
|-------|---------|
| `codex` | `codex exec -q "$(cat <prompt_file>)"` |
| `gemini` | `gemini -p "$(cat <prompt_file>)" --sandbox` |
| `copilot` | `gh copilot explain "$(cat <prompt_file>)"` |
| `cursor` | `cursor agent "$(cat <prompt_file>)" --print` |
| `kimi` | `kimi "$(cat <prompt_file>)"` |

After all 5 complete, parse each result's stdout as a JSON array. If an agent wraps the JSON in markdown fences or prose, extract the JSON array from the output.

#### Category Reference

The full category definitions are in the prompt template files. For quick reference:

- **D: MUST/MUST NOT Consistency** — contradictory, vague, or redundant MUST rules
- **E1: Numeric as String** (High) — numeric placeholders wrapped in quotes
- **E2: Ungrounded Fields** (Medium) — generic placeholders without source attribution
- **E3: Missing Format Constraints** (Medium) — verbatim-transfer fields lacking format specs
- **E4: Inconsistent Field Names** (High) — same concept, different names across schemas
- **E5: Open-Ended Enums** (Low) — unclosed enumeration lists
- **E6: Structured Data as Free-Text** (High) — multiple sub-values crammed into one string field

### Step 4: Compile Report

Merge Phase 1 and Phase 2 results into a single report using this exact format:

```
## Skill Lint Report: [path]

**Files analyzed:** [count]
**Issues found:** [count] ([N] automated, [M] semantic)
**LLM backend:** [agent name]

### Phase 1: Automated Checks

| # | Category | File | Location | Status | Detail |
|---|----------|------|----------|--------|--------|
| 1 | Frontmatter | SKILL.md | line 1-3 | FAIL | Missing `name` field |

### Phase 2: Semantic Checks

| # | Category | File | Field/Location | Severity | Detail |
|---|----------|------|----------------|----------|--------|
| 1 | E1: Numeric as String | SKILL.md | .count | High | ... |

### Finding Details

**Finding [N]: [Category]**
- **File:** [path]
- **Location:** [line range or field path]
- **Current text:** [exact current value]
- **Issue:** [one-line explanation]
- **Suggested fix:** [concrete replacement]
```

If no issues are found for a category, omit that category from the report. If no issues are found at all, say so explicitly.

### Step 5: Severity Classification

Use this default severity table:

| Category | Default Severity | Rationale |
|----------|-----------------|-----------|
| A: Frontmatter Validation | High | Plugin discovery fails without correct frontmatter |
| B: Step Continuity | Medium | Confuses the agent following the skill |
| C: Cross-Reference Integrity | High | Agent attempts to use non-existent tools/skills |
| D: MUST/MUST NOT Consistency | Medium | Contradictory rules cause unpredictable behavior |
| E1: Numeric Quoted as String | High | Causes type errors in downstream consumers |
| E2: Ungrounded Fields | Medium | Causes hallucinated values |
| E3: Missing Format Constraints | Medium | Causes format drift across runs |
| E4: Inconsistent Field Names | High | Causes integration failures |
| E5: Open-Ended Enums | Low | Causes unpredictable but non-breaking values |
| E6: Structured Data as Free-Text | High | Causes parsing failures downstream |

## Remember

- Read the actual files. Do NOT work from memory or assumptions.
- Check EVERY field in EVERY schema. Do NOT sample.
- Report exact field paths using dot notation.
- If no issues are found for a category, omit that category from the report.
- If no issues are found at all, say so explicitly.
- Do NOT suggest fixes that change the semantic meaning of a field.
- When in doubt about whether something is an issue, report it with Low severity rather than omitting.
- Phase 1 checks are definitive (pass/fail). Phase 2 checks are advisory (may need human judgment).
