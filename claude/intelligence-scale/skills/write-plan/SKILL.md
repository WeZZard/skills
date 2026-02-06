---
name: write-plan
description:  You MUST invoke this skill before update the plan file of the Claude Code session.
---

# Update Plan

**Announce at start:** "I'm using the write-plan skill to plan."

## Operating assumptions

Assume the user has zero context for the codebase and questionable taste. Document everything they need to know:

- Exact files to touch (code, tests, docs).
- You SHALL recognize hypotheses and define verification approaches, listing what evidence supports each hypothesis.
- You SHALL recognize human verification needs, documenting how to verify them and **prioritize the relevant tasks** in the plan.
- How to test it. What evidence do the user need to confirm it works?

Assume they are a skilled user but new to our toolset and domain.

## MANDATORY: Plan File Template

You SHALL create plan file with the following template by following the guidance in the HTML comments.

```markdown
# Plan of [Feature Name]

> **For Claude:**
> MANDATORY SUB-SKILL: You SHALL use intelligence-scale:execute-plan to execut this plan.
> MANDATORY SUB-SKILL: You SHALL use intelligence-scale:review to review the result after the plan was executed.

**Goal:** <!-- One sentence describing what this plan achieves. Write in line. -->

<!-- Explain why we are here -->

---

<!-- Freeform plan contents. -->

---

## Tasks

<!-- You SHALL always list the tasks.

**DO** output with one of the following forms:

- Workflow diagram with ordered task number and name if non-linear and graph-level dependencies are appeared.
- Ordered list or cascaded ordered list with task number and name if linear/tree dependencies are appeared. DO NOT connect list items with `|` in this case.

**DO NOT** illustrate with any of the following forms:

- Unordered list
- Dedicated text descriptions
-->

## Verification

<!-- You SHALL always list the verification steps. -->

```

## MANDATORY: Plan File Component Templates

You SHALL ALWAYS use the following plan file component templates to generate relevant contents in the plan file.

**Project Structure:**

You SHALL use the following template when the project structure changes if additions, removals or changes are introduced to the project structure.

```markdown
## Project Structure

<!-- 
You SHALL illustrate the project structure before AND after the changes.
You SHALL NOT just illustrate the project structure before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- box-drawing characters used by UNIX command `tree`

**DO NOT** illustrate with any of the following forms:

- Diagrams
- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

**Tech Stack:**

You SHALL use the following template when the tech stack changes if additions, removals or changes are introduced to the tech stack.

```markdown
## Tech Stack

<!--
You SHALL illustrate the tech stack before AND after the changes.
You SHALL NOT just illustrate the tech stack before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams
- Ordered list

**DO NOT** illustrate with any of the following forms:

- Unordered list
- Table
- Dedicated text descriptions
-->
```

**Architecture:**

You SHALL use the following template when the architecture changes if additions, removals or changes are introduced to the architecture.

```markdown
## Architecture

<!--
You SHALL illustrate the architecture before AND after the changes.
You SHALL NOT just illustrate the architecture before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams

**DO NOT** illustrate with any of the following forms:

- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

**Algorithm Design:**

You SHALL use the following template when the algorithm design if new algorithms are introduced or changes are introduced to existing algorithm designs.

```markdown
## Algorithm Design

<!--

**DO** illustrate with one of the following forms:

- Diagrams

**DO NOT** illustrate with any of the following forms:

- Dedicated text descriptions

Formulae are allowed if can be expressed in markdown.
-->
```

**Verification:**

You SHALL use the following template when the plan involves codes, configurations or prompts addition, removal and changes.

```markdown
## Verification
<!--
You SHALL present testing in the following format. Multiple test files CAN be involved in the **Test Cases** sesion. Multiple test cases CAN be involved under one test file item in the test file list. At lest, but not limited to, one key assertion CAN be involved under each test case sub list.
-->

**Verification Approach:** [Automate | Manual | Hybrid: automate and manual]

**Veritication Steps:**

<!--
1. Step 1
2. Step 2
3. Step 2
-->

<!-- AUTOMATE VERIFICATION BEGIN: Present the following contents when the automate verification approach is invovled -->

**Testing Framework:** [the framework used for testing, only applicable for automate the testing approach]

**Test Cases:**

<!-- You SHALL present the test cases with the following nested list format.
1. ADD|MODIFY: [test_filename_1]
    1. ADD|MODIFY: [test_case_1]: [test_filename_1_test_case_1_description]
        1. ADD|MODIFY: [key assertion 1]
        2. ADD|MODIFY: [key assertion 2]
        3. ADD|MODIFY: [key assertion 3]
2. ADD|MODIFY: [test_filename_2]
    1. ADD|MODIFY: [test_case_2]: [test_filename_2_test_case_2_description]
        1. ADD|MODIFY: [key assertion 1]
        2. ADD|MODIFY: [key assertion 2]
        3. DELETE: [key assertion 3]
    2. DELETE: [test_case_3]: [test_filename_2_test_case_3_description]
3. DELETE: [test_filename_3]
-->

**Testing Steps:**

<!-- AUTOMATE VERIFICATION END -->

```

**Human Verification Gate:**

You shall use the following template when any part of the plan requires human verification based on the human verification criteria mentioned below.

```markdown
## Human Verification Gate
<!--
You SHALL present the human verification requirements in following format.
-->

**Criterion:** "<description of what needs validation>"
**Category:** "<one of: No Computer Use | Subjective Judgment | Financial/Credit Authorization | Security Sensitive>"
**Reason:** "<cite which IS item from the category definition below this matches>"
```

## MANDATORY: Plan Design Principles

**DO:**

- You SHALL use exact file paths.
- You SHALL provide complete code in the plan (avoid vague steps).
- You SHALL include exact commands with expected output.
- You SHALL DRY, YAGNI, TDD.

**DO NOT:**

## MANDATORY: Task Design Principles

You SHALL make each task concentrate on one aspect of the task and aware of context window size.
You SHALL not put too many actions into one task.
You SHALL slice big tasks into smaller ones to maintain context effectiveness.
You SHALL recognize which task requires human verification and prioritize it to the plan start.
You SHALL recognize hypotheses in the plan and organize the task with the dependency order.

## MANDATORY: Recognize Hypotheses in The Plan

**Any points from reasoning but without ground truths from web search, web fetch, successful build and tests are hypotheses.**

You SHALL ALWAYS not jump to conclusion when any hypotheses are not validate in the plan.

## MANDATORY: Recognize Human Verification

You SHALL recognize which part of the plan requires human verification with the following criteria.

**Before applying these criteria, you SHALL explore this computer to find available tools to determine actual capabilities.** Do not assume limitations — verify them.

**No Computer Use** — Agent lacks computer use capability

IS: Visual inspection, UI appearance, animations, layout verification, screenshot comparison, GUI element positioning, physical hardware state
IS NOT: Programmatic UI testing with assertions (e.g., XCTest, Playwright), accessibility audits via CLI tools, automated screenshot diffing invoked through shell commands

**Subjective Judgment** — Requires human opinion or preference

IS: User experience quality, design aesthetics, "feels right" assessments, intuitive vs confusing evaluation
IS NOT: Test pass/fail results, performance benchmarks, code coverage metrics, linting results

**Financial/Credit Authorization** — Action costs money or consumes paid credits

IS: Cloud service charges, paid API calls (e.g., OpenAI, AWS), purchasing resources, consuming metered quotas, subscription activations
IS NOT: Free-tier usage, local compute resources, development sandboxes with no billing

**Security Sensitive** - Affects real credentials or production access

IS: Production credentials, live auth tokens, real user sessions, access control changes in production
IS NOT: Test credentials, mock auth, local dev tokens, sandboxed security testing
