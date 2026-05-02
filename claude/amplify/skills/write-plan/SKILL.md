---
name: write-plan
description:  <MANDATORY>You MUST use write-plan when write or update the Claude Code session plan file.</MANDATORY>
---

# Write / Update Plan

**Announce at start:** "I'm using the write-plan skill to plan."

## Operating Assumptions

Assume the user has zero context for the codebase and questionable taste. Document everything they need to know:

- Exact files to touch (code, tests, docs).
- You **MUST** identify hypotheses and define verification approaches, listing what evidence supports each hypothesis.
- You **MUST** identify human verification needs, documenting how to verify them and **prioritize the relevant tasks** in the plan.
- **Testing strategy:**
  - **Unit tests:** When you add or change behavior, plan unit tests in the same slice—cover the happy path and material edge cases; name exact test files in the plan.
  - **Integration tests:** When multiple units/modules are orchestrated (collaborating classes/functions, boundaries, I/O), plan integration tests that exercise those interactions.
  - **End-to-end tests:** When the workflow is connected and you must prove the full path, plan E2E (or equivalent) coverage at the appropriate layer for your stack.
  - **Regression (bug-fix plans):** When the plan fixes a reported issue, plan a failing reproducer (or automated regression) **before** any fix task; fix tasks depend on it.
  - Not every plan needs every layer—match scope; if a layer is skipped, state why briefly.

Assume they are a skilled user but new to our toolset and domain.

---

## SECTION 1: Write a Plan

Follow these steps **in order** when creating a new plan from scratch. Do NOT skip steps.

### Step 1.1 — Assess Component Readiness

Before writing anything, review the **Component Templates** in Appendix A. For each component template, determine:

1. Whether it applies to this plan (does the change involve project structure, tech stack, architecture, algorithm design, etc.?).
2. Whether you have sufficient evidence (from prior exploration, user input, or tool output) to produce solid content for that component — or whether you would be guessing.

Do NOT produce visible output for this step. This is a silent self-assessment. Proceed directly to Step 1.2 with your assessment.

### Step 1.2 — Confidence Gate: Fill Knowledge Gaps

For every component where **Confident? = No**, you MUST do one or both of the following before proceeding:

**(a) Ask the user questions.** Surface specific unknowns as questions. Do NOT guess.

**(b) Explore the codebase (or run commands / web searches).** Gather the missing ground truth. After exploration, re-evaluate confidence.

You MUST NOT proceed to write the plan file while any component you intend to include has **Confident? = No**.

**Escape hatch:** If after reasonable exploration and user interaction a component remains uncertain, you **MUST**:

- Explicitly mark it as a **hypothesis** (see Appendix B: Hypotheses & Human Verification (Reference)).
- Add a verification task in the plan to resolve it before dependent work begins.

### Step 1.3 — Draft the Plan

Only after all included components pass the confidence gate (or are explicitly marked as hypotheses with verification tasks), write the plan file.

- Use the **Plan File Template** from Appendix A.
- Use the relevant **Component Templates** from Appendix A for each included component.
- Follow the **Testing strategy principles**, **Plan Design Principles**, and **Task Design Principles** from Appendix A.

### Step 1.4 — Self-Check

After drafting, verify the plan against:

1. **Hypothesis identification** (Appendix B) — Are there any ungrounded claims that should be marked as hypotheses?
2. **Human verification identification** (Appendix B) — Does any part of the plan require human verification? If so, is it documented and prioritized?
3. **Plan design principles** (Appendix A) — Exact file paths? Complete code? Exact commands?
4. **Task design principles** (Appendix A) — One aspect per task? Hypothesis dependency order correct?
5. **Testing strategy** (Appendix A) — Does the plan include the right mix of unit/integration/E2E for the scope, with rationale if a layer is intentionally omitted?
6. **Bug-fix ordering** — If this plan fixes a bug/issue, is there a regression/reproducer task **before** implementation tasks?
7. **Verification as specification** (Appendix A, Verification template) — For the risk level of this plan, are automated tests in **Verification** documented with enough **spec-style** detail (layers, **Specifies**, GWT/AAA or equivalent, edges where needed, reproducer label for bug-fix; optional **Coverage map** for large scope) that an agent could implement and audit against them without guessing?

If the self-check reveals gaps, loop back to Step 1.2 or fix the draft before presenting to the user.

---

## SECTION 2: Update a Plan

Follow these steps **in order** when modifying an existing plan. Do NOT skip steps.

### Step 2.1 — Identify the Delta

Determine what changed since the plan was last written:

- New user input or feedback
- Exploration results (code reading, command output, web search)
- Hypothesis validated or invalidated
- Scope change
- Testing or verification scope changed (new boundary, bug reproducer, added/removed E2E, etc.)

### Step 2.2 — Scope the Update

Determine which plan components are affected by the delta. List them explicitly.

### Step 2.3 — Confidence Gate

Apply the same confidence gate as Step 1.2, but **only for the affected components**. Unaffected components keep their existing content.

### Step 2.4 — Apply Updates

Modify only the affected sections. Preserve unaffected sections exactly as they are.

### Step 2.5 — Re-Check Consistency

Ensure the updated plan is internally consistent:

- Task dependencies still hold after the change.
- Verification steps still cover the modified scope.
- Hypothesis markers are updated if any hypothesis was resolved.
- Human verification gates are updated if scope changed.
- Testing strategy still matches the delta (unit/integration/E2E/regression-first for bug-fix); update tasks and Verification if not.
- **Verification as specification:** If verification scope changed, do spec-style fields (layers, Specifies, GWT/AAA, coverage map, reproducer) still match the new scope and depth-for-risk?

---

## Appendix A: Plan File Template & Evaluation Principles (Reference)

This appendix contains the **reference material** used during SECTION 1 and SECTION 2. It is NOT a workflow — it is consulted during the drafting and self-check steps.

### Plan File Template

**MUST:**

You **MUST** make the plan contents focus on current task.
You **MUST** create plan files from this template and follow the guidance in the HTML comments.
You **MUST** keep the plan consistent with what you and the user agreed on.
You **MUST** structure the plan body according to **The Pyramid Principle**.
You **MUST** apply the standards reflected in the writing references below to the natural language you use for the plan.

<WRITING_REFERENCES>
English: The Elements of Style by E. B. White and William Strunk Jr.
Chinese: 語文常談 by 呂叔湘
Japanese: 日本語の作文技術 by 本多勝一, 文章読本 by 谷崎潤一郎, 理科系の作文技術 by 木下是雄
</WRITING_REFERENCES>

**MUST NOT:**

You **MUST NOT** miss points in the plan to be written.

```markdown
# Plan of [Feature Name]

> **For Claude:**
>
> MANDATORY SUB-SKILL: You **MUST** use amplify:execute-plan to execut this plan.
>
> MANDATORY SUB-SKILL: You **MUST** use amplify:audit-plan to audit the result after the plan has completed execution.

**Goal:** <!-- One sentence describing what this plan achieves. Write in line. -->

<!-- Explain why we are here -->

---

<!-- Freeform plan contents. -->

---

## Tasks

<!-- You **MUST** always list the tasks.

**DO** output with one of the following forms:

- Workflow diagram with ordered task number and name if non-linear and graph-level dependencies are appeared. DO NOT output Mermaid syntax.
- Ordered list or cascaded ordered list with task number and name if linear/tree dependencies are appeared. DO NOT connect list items with `|` in this case.

**DO NOT** illustrate with any of the following forms:

- Unordered list
- Dedicated text descriptions
-->

## Verification

<!-- You **MUST** always list the verification steps. -->

```

### Component Templates

You **MUST** use the following component templates to generate relevant contents in the plan file when the corresponding component is included.

**Project Structure:**

You **MUST** use this template when additions, removals, or changes are introduced to the project structure.

```markdown
## Project Structure

<!-- 
You **MUST** illustrate the project structure before AND after the changes.
You **MUST** NOT just illustrate the project structure before OR after the changes and illustrate another with text descriptions.

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

You **MUST** use this template when additions, removals, or changes are introduced to the tech stack.

```markdown
## Tech Stack

<!--
You **MUST** illustrate the tech stack before AND after the changes.
You **MUST** NOT just illustrate the tech stack before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.
- Ordered list

**DO NOT** illustrate with any of the following forms:

- Unordered list
- Table
- Dedicated text descriptions
-->
```

**Architecture:**

You **MUST** use this template when additions, removals, or changes are introduced to the architecture.

```markdown
## Architecture

<!--
You **MUST** illustrate the architecture before AND after the changes.
You **MUST** NOT just illustrate the architecture before OR after the changes and illustrate another with text descriptions.

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.

**DO NOT** illustrate with any of the following forms:

- Ordered list
- Unordered list
- Table
- Dedicated text descriptions
-->
```

**Algorithm Design:**

You **MUST** use this template when new algorithms are introduced or changes are introduced to existing algorithm designs.

```markdown
## Algorithm Design

<!--

**DO** illustrate with one of the following forms:

- Diagrams, DO NOT output Mermaid syntax.

**DO NOT** illustrate with any of the following forms:

- Dedicated text descriptions

Formulae are allowed if can be expressed in markdown.
-->
```

**Verification:**

You **MUST** use this template when the plan involves code, configuration, or prompt additions, removals, and changes.

```markdown
## Verification
<!--
You **MUST** present testing in the following format. Multiple test files CAN be involved in the **Test Cases** section. Multiple test cases CAN be involved under one test file item in the test file list. At least, but not limited to, one key assertion CAN be involved under each test case sub list.

You **MUST** map automated tests to layers: **Unit**, **Integration**, **E2E**, or **Regression** (bug reproducer). Tag each file or group in **Test Cases**, or summarize under **Automated test layers:** below.

You **MUST** treat each test case (or test file for small plans) as a specification: include **Specifies** (one line: what behavior or requirement this case locks in); short **Given / When / Then** or **Arrange / Act / Assert** where useful (especially integration/E2E); list **Edge / negative** cases when not obvious from names. Depth **MUST** scale with plan risk—do not require full GWT for trivial refactors.

For large scopes, you **MAY** add a **Coverage map** (requirement, user story, or risk → test file or case id).

For bug-fix plans, the first automated case **MUST** be labeled **Reproducer** (expected failure before fix, pass after).
-->

**Verification Approach:** [Automate | Manual | Hybrid: automate and manual]

**Verification Steps:**

<!-- For manual verifications: Present the reason why the following steps **MUST** be verified manually. -->

<!--
1. Step 1
2. Step 2
3. Step 2
-->

<!-- AUTOMATE VERIFICATION BEGIN: Present the following contents when the automate verification approach is involved -->

**Automated test layers (optional if each file is tagged in Test Cases):** [e.g. Unit: [unit_test_file]; Integration: [integration_test_file]]

**Coverage map (optional, large scopes):** [e.g. REQ-1 → [test_file] case A; risk: [risk description] → [workflow_test_file]]

**Testing System:** [the system used for testing, only applicable for automate the testing approach]

**Test Cases:**

<!-- You **MUST** present the test cases with the following nested list format. You **MAY** place spec metadata on lines under each ADD|MODIFY entry, e.g. **Test layer:**, **Specifies:**, **Given / When / Then:** or **Arrange / Act / Assert:**, **Reproducer:** yes | no, **Edge / negative:** ...
1. ADD|MODIFY: [test_filename_1]
    <!-- **Test layer:** Unit | Integration | E2E | Regression -->
    <!-- **Specifies:** <one-line spec hook> | **Reproducer:** yes (bug-fix first case only) -->
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

You **MUST** use this template when any part of the plan requires human verification based on the criteria in Appendix B.

```markdown
## Human Verification Gate
<!--
You **MUST** present the human verification requirements in following format.
-->

**Criterion:** "<description of what needs validation>"
**Category:** "<one of: No Computer Use | Subjective Judgment | Financial/Credit Authorization | Security Sensitive>"
**Reason:** "<cite which IS item from the category definition below this matches>"
```

### Testing strategy principles

- **Unit:** Plan production code and unit tests together; include happy path and edge cases; use exact paths for both.
- **Integration:** Plan integration tests when components are orchestrated across boundaries (modules, processes, DB, network, etc.).
- **E2E:** Plan E2E (or stack-appropriate) tests when the full workflow must be proven after wiring.
- **Bug-fix / issue-fix:** You **MUST** schedule a regression reproducer (failing test or minimal repro) before tasks that apply the fix; ordering must be explicit in **Tasks**.
- **TDD:** Prefer **DRY, YAGNI, TDD**—state in the plan whether the slice is test-first (red→green) or test co-located with implementation if either pattern applies.

### Plan Design Principles

**DO:**

- You **MUST** use exact file paths.
- You **MUST** provide complete code in the plan (avoid vague steps).
- You **MUST** include exact commands with expected output.
- You **MUST** DRY, YAGNI, TDD (see **Testing strategy principles** for how tests and tasks align).

**DO NOT:**

### Task Design Principles

- You **MUST** make each task concentrate on one aspect of the task and aware of context window size.
- You **MUST** not put too many actions into one task.
- You **MUST** slice big tasks into smaller ones to maintain context effectiveness.
- You **MUST** identify which task requires human verification and prioritize it to the plan start.
- You **MUST** identify hypotheses in the plan and organize the task with the dependency order.
- You **MUST** order tasks to match the testing strategy (e.g., reproducer before fix for bugs; integration/E2E after their prerequisites unless the plan documents a different dependency).

---

## Appendix B: Hypotheses & Human Verification (Reference)

This appendix contains the **identification criteria** used during the self-check steps in SECTION 1 and SECTION 2. It is NOT a workflow — it is consulted during confidence gating and self-checks.

### Identify Hypotheses in The Plan

**Any points from reasoning but without ground truths get from web search, web fetch, successful build, tests and user verification are hypotheses.**

You **MUST** ALWAYS not jump to conclusion when any hypotheses are not validated in the plan.

### Identify Human Verification

You **MUST** identify which part of the plan requires human verification with the following criteria.

**Before applying these criteria, you **MUST** explore this computer to find available tools to determine actual capabilities.** Do not assume limitations — verify them.

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
