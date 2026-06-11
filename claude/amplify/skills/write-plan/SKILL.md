---
name: write-plan
description:  <MANDATORY>You MUST use write-plan when write or update the plan.</MANDATORY>
---

# Write / Update Plan

**Announce at start:** "I'm using the write-plan skill to plan."

## Variables

You **MUST** set **$SESSION_PLAN_FILE** to the Claude Code session plan file mentioned in the latest **EnterPlanMode** tool response.

---

## Capability Checks

**Computer-Use:**

You **MUST** set **$AMPLIFY_COMPUTER_USE_AVAILABLE** to `true` if the comptuer-use MCP is available.

**Browser-Use:**

You **MUST** set **$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE** to `true` if the chrome-devtools MCP is available.

You **MUST** set **$AMPLIFY_PLAYWRIGHT_AVAILABLE** to `true` if the Playwright MCP is available.

**External Agents:**

You **MUST** set **$AMPLIFY_CODEX_AVAILABLE** to `true` if the Codex CLI is checked available.

You **MUST** set **$AMPLIFY_KIMI_AVAILABLE** to `true` if the Kimi CLI is checked available.

<EXAMPLE_COMMANDS>
macOS/Unix/Linux: `command -v codex`
macOS/Unix/Linux: `command -v kimi`
</EXAMPLE_COMMANDS>

---

## Resolve the Open Assumptions

Assume the user has zero context for the codebase and questionable taste. Document everything they need to know:

1. You **MUST** verify the assumptions the plan based on before writing the **$SESSION_PLAN_FILE** according to **Appendix B: Identify Assumptions**.
2. You **MUST** spawn blind subagents to verify the open assumptions whenever possible.
3. You **MUST** use **AskUserQuestion** tool to task for human verification for the open assumptions according to **Appendix C: Identify Human Checkpoints**.

---

## Approve External Agents

An external-agent executor runs a third-party CLI on your task.
You **MUST** detect which are installed and get the user's approval before using them in task execution.

1. Detect and set flags:
    - `$AMPLIFY_CODEX_AVAILABLE` = `true` iff `command -v codex` succeeds.
    - `$AMPLIFY_KIMI_AVAILABLE` = `true` iff `command -v kimi` succeeds.
2. You **MUST** ask the user a multiple-choice question with the **AskUserQuestion** tool for approval.
3. You **MUST** record the set of approved external agents:
    - `$AMPLIFY_USE_CODEX_APPROVED` = `true` iff using codex is approved.
    - `$AMPLIFY_USE_KIMI_APPROVED` = `true` iff using kimi is approved.

---

## Communications and Outputs

When design/update/write the **$SESSION_PLAN_FILE**:

**MUST:**

1. You **MUST** make the **$SESSION_PLAN_FILE** focus on current task.
2. You **MUST** use exact file paths in the **$SESSION_PLAN_FILE**.
3. You **MUST** DRY, YAGNI.
4. You **MUST** assume it is a skilled user but new to our toolset and domain.
5. You **MUST** make the **$SESSION_PLAN_FILE** to follow the template in **Appendix A: Plan Format** and the guidelines in the HTML comments.
6. You **MUST** keep the contents in the **$SESSION_PLAN_FILE** consistent with what you and the user agreed on.
7. You **MUST** apply the standards reflected in the **writing references** below to the natural language you use for the **$SESSION_PLAN_FILE**.

<WRITING_REFERENCES>
English: The Elements of Style by E. B. White and William Strunk Jr.
Chinese: 語文常談 by 呂叔湘
Japanese: 日本語の作文技術 by 本多勝一, 文章読本 by 谷崎潤一郎, 理科系の作文技術 by 木下是雄
</WRITING_REFERENCES>

**MUST NOT:**

You **MUST NOT** miss points in the **$SESSION_PLAN_FILE** to be written.

---

## Appendix A: Plan Format (Reference)

````markdown
# [Plan Title]

> **For Claude:**
>
> <EXTREMELY_IMPORTANT>
>
> You **MUST** use amplify:execute-plan to execute this plan.
>
> </EXTREMELY_IMPORTANT>

**Goal:** <!-- One sentence describing what this plan achieves. Write in line. -->

<!-- Explain why we are here -->

---

## Design

<!-- Freeform contents to articulate the design.

**MUST:**

You **MUST** read ${CLAUDE_PLUGIN_ROOT}/references/plan-design-guidelines.md and follow the steps mentioned in this document to present the plan's design.

**MUST NOT:**

You **MUST NOT** invent contents beyond the guidelines in ${CLAUDE_PLUGIN_ROOT}/references/plan-design-guidelines.md

-->

---

## Tasks

<!-- Tasks that implement the design.

**MUST:**

1. You **MUST** read ${CLAUDE_PLUGIN_ROOT}/references/task-design-guidelines.md and follow the steps mentioned in this document to design the tasks that implement the plan's design.
2. You **MUST** ensure contents in **Tasks** section align to the latest design each time you update the plan file.

**MUST NOT:**

You **MUST NOT** invent contents beyond the guidelines in ${CLAUDE_PLUGIN_ROOT}/references/task-design-guidelines.md

-->

````

---

## Appendix B: Identify Assumptions (Reference)

This appendix contains the **identification criteria** used during the self-check steps in SECTION 1 and SECTION 2. It is NOT a workflow — it is consulted during confidence gating and self-checks.

**Any points from reasoning but without ground truths get from web search, web fetch, successful build, tests and user verification are assumptions.**

You **MUST** ALWAYS not jump to conclusion when any assumptions are not validated in the plan.

## Appendix C: Identify Human Checkpoints (Reference)

You **MUST** identify which part of the plan requires human checkpoint with the following criteria.

**Before applying these criteria, you **MUST** explore this computer to find available tools to determine actual capabilities.** Do not assume limitations — verify them.

**No Computer Use** — Agent lacks computer use capability such that it cannot verify an assumption, built feature or fixed code.

IS: **$AMPLIFY_COMPUTER_USE_AVAILABLE** is `true`
IS NOT: **$AMPLIFY_COMPUTER_USE_AVAILABLE** is `false`

**Subjective Judgment** — Requires human opinion or preference

IS: User experience quality, design aesthetics, "feels right" assessments, intuitive vs confusing evaluation
IS NOT: Test pass/fail results, performance benchmarks, code coverage metrics, linting results

**Financial/Credit Authorization** — Action costs money or consumes paid credits

IS: Cloud service charges, paid API calls (e.g., OpenAI, AWS), purchasing resources, consuming metered quotas, subscription activations
IS NOT: Free-tier usage, local compute resources, development sandboxes with no billing

**Security Sensitive** - Affects real credentials or production access

IS: Production credentials, live auth tokens, real user sessions, access control changes in production
IS NOT: Test credentials, mock auth, local dev tokens, sandboxed security testing
