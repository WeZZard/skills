---
name: skill-lint
description: Audit skill/prompt files for structural issues and JSON schema format coherence issues. Accepts a directory or file path, runs automated deterministic checks and LLM semantic analysis via parallel subagents.
---

# Skill Lint

## Overview

Audit skill/prompt files for structural issues, step continuity, cross-reference integrity, and JSON schema format coherence. Uses a two-phase approach: automated deterministic checks followed by LLM semantic analysis via 5 parallel subagents.

**This is a rigid skill. Follow it exactly.**

**Announce at start:** "I'm using the skill-lint skill to audit [path]."

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

### Step 3: Phase 2 — LLM Semantic Checks via 5 Parallel Subagents

Launch **5 subagents in a single message** for maximum parallelism. Each agent receives the full file content and its specific check instructions.

#### Subagent Design

| Agent | Categories | Model | Rationale |
|-------|-----------|-------|-----------|
| Agent 1 | D: MUST/MUST NOT Consistency | Sonnet | Needs full-file reasoning to detect contradictions and redundancy across distant sections |
| Agent 2 | E1: Numeric as String + E2: Ungrounded Fields | Haiku | Pattern-matching with clear heuristics; high-volume, low-complexity |
| Agent 3 | E3: Non-Interpretation Fields Without Format Constraints | Sonnet | Requires understanding of verbatim-transfer semantics and domain context |
| Agent 4 | E4: Inconsistent Field Names Across Schemas | Sonnet | Cross-schema semantic similarity analysis; needs nuanced judgment |
| Agent 5 | E5: Open-Ended Enums + E6: Structured Data as Free-Text | Haiku | Pattern-based detection with clear signals |

Each agent MUST return findings as a structured list with: **category**, **field path**, **current text**, **issue**, **suggested fix**, **severity**.

#### Category D: MUST/MUST NOT Consistency (Agent 1, Sonnet)

- No contradictory MUST rules (e.g., "MUST use subagents" and "MUST NOT use subagents" for the same context)
- MUST rules have actionable criteria (not vague like "MUST be good")
- MUST rules are not redundant (same rule stated differently in multiple places)

#### Category E1: Numeric Fields Quoted as Strings (Agent 2, Haiku) — High Severity

Detect placeholders that describe numeric values but are wrapped in quotes, causing type confusion.

**Detection heuristic:** Placeholder contains "number"/"count"/"total"/"amount"/"index"/"size"/"length"/"percentage"/"score"/"duration" and is wrapped in quotes.

**Before:** `"count": "[number of items]"`
**After:** `"count": "[integer: number of items]"`

#### Category E2: Ungrounded Fields (Agent 2, Haiku) — Medium Severity

Detect generic placeholders with no source attribution.

**Detection heuristic:** Generic placeholder (`[value]`, `[name]`, `[identifier]`) with no source attribution ("from X", "per Y", "as returned by Z").

**Before:** `"source_id": "[identifier]"`
**After:** `"source_id": "[identifier from /sources API response]"`

#### Category E3: Non-Interpretation Fields Without Format Constraints (Agent 3, Sonnet) — Medium Severity

Detect verbatim-transfer fields lacking MUST rules or format examples.

**Patterns to check:**
- Register/argument values → should say "copied verbatim"
- CLI commands → "literal command"
- File paths → specify "absolute/relative"
- Identifiers → specify "source-level/mangled"

**Before:** `"register_value": "[the register value]"`
**After:** `"register_value": "[hex string, e.g. '0x1A2B3C4D', MUST copy verbatim from tool output]"`

#### Category E4: Inconsistent Field Names Across Schemas (Agent 4, Sonnet) — High Severity

Detect the same concept using different field names across schemas (semantic similarity, not just string match).

**Before:** `"function"` in one schema vs `"function_signature"` in another; `"file"` + line combined vs separated
**After:** Unified naming across all schemas

#### Category E5: Open-Ended Enums (Agent 5, Haiku) — Low Severity

Detect unclosed enumeration lists.

**Detection heuristic:** "etc.", "and so on", "such as", "e.g." with open lists, or arrays ending with `"..."`.

**Before:** `"status": "[e.g. active, inactive, etc.]"`
**After:** `"status": "active | inactive | suspended | archived"`

#### Category E6: Structured Data Serialized as Free-Text (Agent 5, Haiku) — High Severity

Detect single string fields whose placeholder implies multiple sub-values.

**Detection heuristic:** Single string field whose placeholder contains commas listing distinct attributes, or "and" joining different data types.

**Before:** `"location": "[city, state, and zip code]"`
**After:** Decompose into `"city"`, `"state"`, `"zip_code"`

### Step 4: Compile Report

Merge Phase 1 and Phase 2 results into a single report using this exact format:

```
## Skill Lint Report: [path]

**Files analyzed:** [count]
**Issues found:** [count] ([N] automated, [M] semantic)

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
