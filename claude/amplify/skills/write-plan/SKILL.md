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

1. You **MUST** set **$AMPLIFY_COMPUTER_USE_AVAILABLE** to `true` if all of the following conditions were met:
    1. The host machine is running macOS.
    2. The computer-use MCP is available
    3. Claude Code version is above v2.1.85+
    4. Claude Code is running in an INTERACTIVE session — never headless/CI.
2. You **MUST** set **$AMPLIFY_COMPUTER_USE_AVAILABLE** to `false` if any of the previous conditions were not met.

**Computer-Use-CUA:**

1. You **MUST** set **$AMPLIFY_CUA_AVAILABLE** to `true` if all of the following conditions were met:
    1. The `cua-driver` CLI is installed (`command -v cua-driver` succeeds on macOS/Linux; `where cua-driver` on Windows).
    2. The `cua-driver` MCP server is registered and reachable as `cua-driver`.
    3. A logged-in GUI desktop session is reachable where the `cua-driver` daemon runs — a local desktop login (macOS Aqua/WindowServer; Windows interactive session, not Session 0; Linux user session) or a cua-sandbox/Lume VM.
2. You **MUST** set **$AMPLIFY_CUA_AVAILABLE** to `false` if any of the previous conditions were not met.

**Browser-Use:**

1. You **MUST** set **$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE** to `true` if the chrome-devtools MCP is available, else set `false`.
2. You **MUST** set **$AMPLIFY_PLAYWRIGHT_AVAILABLE** to `true` if the Playwright MCP is available, else set `false`.

**External Agents:**

1. You **MUST** set **$AMPLIFY_CODEX_AVAILABLE** to `true` if the Codex CLI is checked available, else set `false`.
2. You **MUST** set **$AMPLIFY_KIMI_AVAILABLE** to `true` if the Kimi CLI is checked available, else set `false`.
    <EXAMPLE_COMMANDS>
    macOS/BSD/UNIX/Linux: `command -v codex`
    macOS/BSD/UNIX/Linux: `command -v kimi`
    </EXAMPLE_COMMANDS>
3. You **MUST** set `$AMPLIFY_USE_CODEX_APPROVED` to `false` when `$AMPLIFY_CODEX_AVAILABLE` is `false` and `$AMPLIFY_USE_CODEX_APPROVED` happened to be `true`. You **MUST** prompt user about this change (Codex is no longer available in this session since the executable cannot be found.) in the assistant message.
4. You **MUST** set `$AMPLIFY_USE_KIMI_APPROVED` to `false` when `$AMPLIFY_KIMI_AVAILABLE` is `false` and `$AMPLIFY_USE_KIMI_APPROVED` happened to be `true`. You **MUST** prompt user about this change (Kimi is no longer available in this session since the executable cannot be found.) in the assistant message.

---

## Resolve the Open Assumptions

Assume the user has zero context for the codebase and questionable taste. Document everything they need to know:

1. You **MUST** verify the assumptions the plan based on before writing the **$SESSION_PLAN_FILE** according to **Appendix B: Identify Assumptions**.
2. You **MUST** spawn blind subagents to verify the open assumptions whenever possible.
3. You **MUST** use **AskUserQuestion** tool to task for human verification for the open assumptions according to **Appendix C: Identify Human Checkpoints**, which classifies each checkpoint as silent or askable. For the askable gate categories (subjective, financial, security-sensitive), you **MUST** ask them through the **Agent Autonomy Request** section, which owns those gate decisions.

---

## Agent Autonomy Request

This section covers two kinds of autonomy decisions made once per session: which external-agent CLIs the agent may run on your task, and which gated-action categories (subjective, financial, security-sensitive) the agent may perform automatically instead of stopping for a human (see **Appendix C: Identify Human Checkpoints**).

The five session flags governing these decisions are all tri-state: unset = never asked, `true` = agent proceeds automatically (human gate: No), `false` = keep a human gate (human gate: Yes):

- `$AMPLIFY_USE_CODEX_APPROVED` — agent may invoke the Codex CLI.
- `$AMPLIFY_USE_KIMI_APPROVED` — agent may invoke the Kimi CLI.
- `$AMPLIFY_SUBJECTIVE_JUDGMENT_APPROVED` — agent may make subjective judgments (UX, aesthetics) automatically.
- `$AMPLIFY_FINANCIAL_AUTHORIZATION_APPROVED` — agent may perform paid actions (money / credits) automatically.
- `$AMPLIFY_SECURITY_SENSITIVE_ACTION_APPROVED` — agent may perform security-sensitive actions automatically.

**MUST:**

1. You **MUST** ask all applicable rows whose flag is unset in one batched **AskUserQuestion** call.

**MUST NOT:**

1. You **MUST NOT** re-ask any flag that is already set (applies to all five flags).
2. You **MUST NOT** show the Subjective row unless any of the following conditions hold:
    1. Subjective judgment in the plan can be delegated to computer-use and the computer-use is available (`$AMPLIFY_COMPUTER_USE_AVAILABLE` or `$AMPLIFY_CUA_AVAILABLE` is `true`).
    2. Subjective judgment in the plan can be delegated to browser-use and the browser-use is available (`$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE` or `$AMPLIFY_PLAYWRIGHT_AVAILABLE` is `true`).

**Process:**

1. You **MUST** ask the user one batched **AskUserQuestion** call containing only the applicable rows whose flag is unset:
    - **Q1 — External agents** (show if `$AMPLIFY_CODEX_AVAILABLE` or `$AMPLIFY_KIMI_AVAILABLE` is `true` and the corresponding approved flag is unset): "Which external agents may be used to implement this plan?" (multi-select: Codex / Kimi). Set the value (`true`/`false`) of `$AMPLIFY_USE_CODEX_APPROVED` and `$AMPLIFY_USE_KIMI_APPROVED` based on whether the corresponding option is selected.
    - **Q2 — Subjective** (show only if: (1) subjective judgment can be delegated to computer-use and the computer-use is available OR it can be delegated to browser-use and the browser-use is available; (2) `$AMPLIFY_SUBJECTIVE_JUDGMENT_APPROVED` is unset): "May the agent make subjective judgments (UX, aesthetics) automatically?" — `(•) Keep a human gate  ( ) Let the agent judge automatically`. Approved → `$AMPLIFY_SUBJECTIVE_JUDGMENT_APPROVED` = `true`; dismissed or kept gate → `false`.
    - **Q3 — Financial** (show if `$AMPLIFY_FINANCIAL_AUTHORIZATION_APPROVED` is unset): "May the agent perform paid actions (money / credits) automatically?" — `(•) Keep a human gate  ( ) Let the agent proceed automatically`. Approved → `$AMPLIFY_FINANCIAL_AUTHORIZATION_APPROVED` = `true`; dismissed or kept gate → `false`.
    - **Q4 — Security** (show if `$AMPLIFY_SECURITY_SENSITIVE_ACTION_APPROVED` is unset): "May the agent perform security-sensitive actions automatically?" — `(•) Keep a human gate  ( ) Let the agent proceed automatically`. Approved → `$AMPLIFY_SECURITY_SENSITIVE_ACTION_APPROVED` = `true`; dismissed or kept gate → `false`.
2. You **MUST** record each outcome after the call: approved → flag = `true` (human gate: No); dismissed or kept gate → flag = `false` (human gate: Yes).

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
You **MUST NOT** include HTML comment blocks (<!-- HTML comments -->) inside the plan file unless it is an intent HTML comment.

---

## Plan Design and Coverage Audit

Run this after the plan file is written or updated, before the plan is handed back for human review (**ExitPlanMode**).

**When to run:**

1. You **MUST** run the design audit when the plan has a **Design**.
2. You **MUST** run the coverage audit when the plan includes **Verifications** in the **Design**.
3. You **MUST** skip this section only when the plan has none of the two.

### Auditing the Design

**Spawn the Design Auditors:**

1. You **MUST** read the plan's **Rationale** and its **Design** to develop the audit points yourself before spawning any auditor. Develop as many points as apply, each naming a design element and covering one of:
   - **alignment** — does the element deliver what the **Rationale** claims it serves; does any purpose element have no design behind it; does any element serve no purpose;
   - **soundness** — does the element carry a flaw or risk that defeats the purpose: an unhandled state, a race or ordering hazard, an unbounded resource, a violated invariant, a scalability limit, or an ill-fitting pattern;
   - **feasibility** — can the element actually be built within the real constraints: does it depend on a capability the stack or platform lacks, an interface that does not exist, or work that exceeds the stated budget.
   Adopt a refutation stance: for each element, ask what a skeptic who did not write this design would challenge. You **MUST NOT** develop a generic point not anchored to this design and purpose.
2. You **MUST** spawn one blind auditor per point, in parallel, under the same blindness and read-only discipline as the coverage auditors above (its prompt carries only the plan file path and its one point; you **MUST NOT** pass your own reasoning; it reads the plan and the repository read-only and changes nothing). Each auditor judges the Design against its one point and returns exactly:

   ```text
   VERDICT: PASS | RISK | FAIL
   EVIDENCE: <design element(s) + reasoning, 1–2 lines>
   GAP: <one line: what must change, or none>
   ```

   Use `FAIL` when the element cannot meet its point unconditionally, `RISK` when a latent flaw defeats the purpose only under adverse conditions, and `PASS` otherwise. These per-point verdicts feed the design-audit table and the hard-block loop in **Act on the results** below.

**Act on the results:**

1. You **MUST** collect the design-audit verdicts into a design-audit table and show both to the user:

    ```
    Point                          Kind          Verdict   Gap
    P1 <names a design element>    alignment     PASS      —
    P2 <names a design element>    soundness     RISK      add a cap sized to the story's limit
    P3 <names a design element>    feasibility   FAIL      depends on a capability the stack lacks
    ```

2. You **MUST** treat any `RISK` or `FAIL` as a design gap and resolve it only by editing the **Design** — redesign the element, or add an explicit bound/mitigation and update the **Rationale** — never by overriding the verdict. Then re-develop the points when the Design's shape changed, or otherwise re-run only the affected point.
4. You **MUST** repeat until every design-audit row reads `PASS`. Only then is the plan ready for human review.

**MUST NOT:**

1. You **MUST NOT** let an auditor edit the plan or the repository; auditors only read and report.

### Auditing the Coverage

**Spawn the Coverage Auditors:**

1. You **MUST** enumerate the audit units from the written plan:
    - one unit per **user story** in the **User Stories** list;
    - one **reverse** unit for the whole **Tasks** section;
    - one **journey** unit for the whole **User Story Map** (when the plan has one).
2. You **MUST** spawn one `subagent(general-purpose)` per unit, in the background, in parallel (single message, multiple tool calls).
3. You **MUST** spawn coverage auditor subagents by using the prompt template in **Appendix D: Plan Audit Prompt Templates**.
4. You **MUST** keep each auditor blind. Its prompt contains only the plan file path and the one unit it checks. You **MUST NOT** pass this conversation, your own reasoning, or any story-to-task mapping you already have in mind.
5. You **MUST** tell each auditor to read the plan file (and the repository read-only to confirm referenced paths exist) and to change nothing.

**Act on the results:**

1. You **MUST** collect the coverage verdicts into a coverage table and show both to the user:

    ```
    Story / Task / Step      Verdict    Built by   Proven by   Gap
    1. <story>               MET        T2, T5     V1          —
    2. <story>               PARTIAL    T3         —           benefit "…" not delivered; no E2E case
    3. <story>               MISSED     none       none        no task builds <capability>
    T7 <task>                ORPHAN     —          —           serves no story
    Step "<step>"            GAP        —          —           no story under this step
    ```

2. You **MUST** treat any `MISSED`, `PARTIAL`, `ORPHAN`, or `GAP` as a coverage gap and fix the plan: add the missing task or verification case, attach the orphan task to a story or remove it, or add the missing story. Then re-spawn only the coverage auditors whose units you changed.
3. You **MUST** repeat until every coverage row reads `MET` / `SERVES` / `HAS STORY`. Only then is the plan ready for human review.

**MUST NOT:**

1. You **MUST NOT** delete or weaken a user story just to clear a gap. Resolve a gap by building it, or ask the user.
2. You **MUST NOT** let an auditor edit the plan or the repository; auditors only read and report.

---

## Appendix A: Plan Format (Reference)

```markdown
# [Plan Title]

> **For Claude:**
>
> <EXTREMELY_IMPORTANT>
>
> You **MUST** use amplify:execute-plan to execute this plan.
>
> </EXTREMELY_IMPORTANT>

**Goal:** <!-- One sentence describing what this plan achieves. Write in line. -->

## Rationale

<!-- Explain why we are here and why the design takes this approach: the problem this plan addresses, and how each major design choice serves the purpose and why this approach over the obvious alternative. The Design Audit develops its alignment points against this section. -->

---

## Design

<!-- Structured contents to articulate the design.

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

```

---

## Appendix B: Identify Assumptions (Reference)

This appendix contains the **identification criteria** used during the self-check steps in SECTION 1 and SECTION 2. It is NOT a workflow — it is consulted during confidence gating and self-checks.

**Any points from reasoning but without ground truths get from web search, web fetch, successful build, tests and user verification are assumptions.**

You **MUST** ALWAYS not jump to conclusion when any assumptions are not validated in the plan.

## Appendix C: Identify Human Checkpoints (Reference)

You **MUST** identify which part of the plan requires human checkpoint with the following criteria.

**Before applying these criteria, you **MUST** explore this computer to find available tools to determine actual capabilities.** Do not assume limitations — verify them.

**No Browser-use** — Agent lacks browser-use capability such that it cannot continue the action.

IS: **$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE** is `false` and **$AMPLIFY_PLAYWRIGHT_AVAILABLE** is `false` (browser-use absent; the limitation applies).
IS NOT: **$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE** is `true` or **$AMPLIFY_PLAYWRIGHT_AVAILABLE** is `true`.
**Agent Autonomy Request:** Silent — never raise a question; the affected check silently falls back to a Manual / human gate.

**No Computer-use** — Agent lacks computer-use capability such that it cannot continue the action.

IS: **$AMPLIFY_COMPUTER_USE_AVAILABLE** is `false` and **$AMPLIFY_CUA_AVAILABLE** is `false` (computer-use absent; the limitation applies).
IS NOT: **$AMPLIFY_COMPUTER_USE_AVAILABLE** is `true` or **$AMPLIFY_CUA_AVAILABLE** is `true`.
**Agent Autonomy Request:** Silent — never raise a question; the affected check silently falls back to a Manual / human gate.

**Subjective Judgment** — Requires human opinion or preference

IS: User experience quality, design aesthetics, "feels right" assessments, intuitive vs confusing evaluation
IS NOT: Test pass/fail results, performance benchmarks, code coverage metrics, linting results
**Agent Autonomy Request:** Askable, but only when any of the following conditions hold:
    1. Subjective judgment in the plan can be delegated to computer-use AND the computer-use is available (`$AMPLIFY_COMPUTER_USE_AVAILABLE` or `$AMPLIFY_CUA_AVAILABLE` is `true`)
    2. Subjective judgment in the plan can be delegated to browser-use AND browser-use is available (`$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE` or `$AMPLIFY_PLAYWRIGHT_AVAILABLE` is `true`); otherwise silent.

**Financial/Credit Authorization** — Action costs money or consumes paid credits

IS: Cloud service charges, paid API calls (e.g., OpenAI, AWS), purchasing resources, consuming metered quotas, subscription activations
IS NOT: Free-tier usage, local compute resources, development sandboxes with no billing
**Agent Autonomy Request:** Always askable.

**Security Sensitive** - Affects real credentials or production access

IS: Production credentials, live auth tokens, real user sessions, access control changes in production
IS NOT: Test credentials, mock auth, local dev tokens, sandboxed security testing
**Agent Autonomy Request:** Always askable.

## Appendix D: Plan Audit Prompt Templates

**Per-story auditor prompt:**

<PLAN_STORY_AUDIT_PROMPT>

```markdown
PLAN FILE: <absolute path to $SESSION_PLAN_FILE>
STORY: <one user story, verbatim: "As a <role>, I want <capability>, so that <benefit>">

You are a blind auditor. Read ONLY the plan file. Change nothing.
Do not assume any task implements this story — find the evidence yourself.

For this one story, check:
1. Built — does at least one task build this story's capability? Cite task ids.
2. Benefit — do those tasks deliver the "so that <benefit>" part, not just the capability? Name any benefit no task delivers.
3. Proven — does at least one Verification case prove this story works end to end? Cite the case id.

Return exactly:
VERDICT: MET | PARTIAL | MISSED
BUILT-BY: <task ids, or none>
PROVEN-BY: <verification case ids, or none>
GAP: <one line naming the missing piece, or none>
```

</PLAN_STORY_AUDIT_PROMPT>

**Reverse auditor prompt:**

<PLAN_REVERSE_AUDIT_PROMPT>

```markdown
PLAN FILE: <absolute path to $SESSION_PLAN_FILE>

You are a blind auditor. Read ONLY the plan file. Change nothing.
For every task in the Tasks section, name the user story it serves.
A task may serve no story only if the plan gives an explicit non-story reason (for example a required setup or refactor step).

Return one line per task:
<task id>: SERVES <story number> | ORPHAN (<why no story>)
```

</PLAN_REVERSE_AUDIT_PROMPT>

**Journey auditor prompt:**

<PLAN_JOURNEY_AUDIT_PROMPT>

```markdown
PLAN FILE: <absolute path to $SESSION_PLAN_FILE>

You are a blind auditor. Read ONLY the plan file's User Story Map. Change nothing.
For every Activity and every Step in the map, check that at least one Story sits under it.

Return one line per Activity/Step:
<activity or step name>: HAS STORY | GAP (no story under it)
```

</PLAN_JOURNEY_AUDIT_PROMPT>