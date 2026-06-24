---
name: brainstorming
description: <EXTREMELY_IMPORTANT>You MUST use brainstorming when the user wants to explore ideas, discuss approaches, research a topic, or has been stuck on a problem. Always brainstorm before beginning implementation.</EXTREMELY_IMPORTANT>
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs through natural collaborative dialogue, and progressively disclose the structure the plan will later formalize — so entering plan mode formalizes what you already discussed instead of introducing new structure.

A good brainstorm diverges before it converges: expose a lot of choices first, let the purpose sharpen as the user reacts to those choices, then connect the surviving options into a coherent design. That convergence is exactly the design components and task graph that the amplify:write-plan skill will formalize — preview them as you go.

Diverge in your analysis, converge in your voice: study many options internally, then lead with the single recommendation you judge most correct and the reasoning behind it. Use options as a way to think, not as the default way to reply. Present a menu of choices only when the decision is genuinely the user's to make — a matter of taste, scope, budget, or risk tolerance — not when it is an engineering question you can reason to a defensible answer.

## The Process

The three stages below are not strictly sequential. Diverge runs first, seeded by the user's request; clarification is driven by the user reacting to the options you exposed — so Diverge and Clarify interleave. Connect follows once a direction is firm.

**Stage 1 — Diverge: expose choices (seeded by the request)**

- Seed divergence from context: check the current project state (files, docs, recent commits) and recall the goal, purpose, and design principles.
- Then, starting from the user's request, name the candidate option space before narrowing: approaches, technologies, references, prior art.
- Study each option in an isolated subagent to keep this conversation's context clean. You **MUST** spawn one `Explore` subagent per candidate option, in parallel (single message, multiple tool calls). Each subagent studies its one option — feasibility, trade-offs, references, risks — uses `WebSearch` to ground it in current fact, applies the Validating Information rules below, and returns a **compact brief**: what it is, pros and cons, key references, and the main risk. Keep only the briefs in this thread, not the raw research. Batch the subagents when there are many options.
- Synthesize the options, then form a ranked judgment: lead with the recommendation you judge most correct, its reasoning, and the strongest alternative as supporting context. Use the options to inform the user, not as a menu that hands the decision back to them; present a "which do you prefer, and why?" choice only for a genuinely user-owned fork.
- Form a leading recommendation and hold it loosely — update it as evidence arrives. Withholding all judgment is not neutrality; it pushes the decision back onto the user, who came to you for it.

**Stage 2 — Clarify: purpose sharpens (reaction-driven)**

- Clarification is driven by the user reacting to and selecting among the Stage 1 options — so Stage 1 and Stage 2 interleave.
- Ask a question only when the answer would change what you build and you cannot settle it from the code, the evidence, or a sensible default. Otherwise state your assumption and your recommendation, and proceed.
- When you do ask, ask one clear question — prefer multiple choice for a genuinely user-owned fork — and never ask the user to choose an architecture you can reason out yourself. Anchor it to the options on the table (which option, and why) rather than asking abstractly.
- As the direction emerges, pin down the desired outcome — user stories (as a [role], I want [capability], so that [benefit]), a user story map, or another outcome form you invent when those do not fit — the budget, the constraints, and the success criteria. These anchor every design component downstream.

**Validating Information** (applies throughout Diverge and Clarify)

- **Check sources:** verify the credibility of sources found via web search.
- **Check recency:** explicitly check the date of information; discard outdated info.
- **Resolve conflicts:** when findings contradict, reason from source authority and recency.
- **No hallucinations:** do not conclude without validation; if uncertain, verify with a search or ask the user.

**Stage 3 — Connect: the convergence is the design**

- Once a direction is firm, connect the surviving options to the clarified purpose and to each other. This convergence is the design.
- Present it in small sections (200–300 words), checking after each whether it looks right so far.
- Organize the design by the same components the plan uses, picking only the ones this work touches (MECE). Read `${CLAUDE_PLUGIN_ROOT}/references/plan-design-guidelines.md` for the component set and when each applies — for example User Story Map, User Stories, Architecture, Algorithm Design, Data Structure, User Interface, User Interaction, Business, and Verification.
- As the design firms up, sketch the task shape too: the discrete steps and their dependencies. See `${CLAUDE_PLUGIN_ROOT}/references/task-design-guidelines.md` for the task-list and execution-graph shape the plan will use.

**Fidelity boundary**

- Here you **name** the relevant components and discuss them in prose, and you **sketch** the task steps and dependencies.
- You **defer** to write-plan the rigorous artifacts: the box-drawing diagrams, the before/after comparison pairs, the formal execution diagram, and the traced acceptance criteria.
- write-plan formalizes the components and task graph you already discussed — a formalization, not a new structure.

**Update the Plan and Review the Plan**

1. You **MUST** call **EnterPlanMode** to enter plan mode.
2. Use the amplify:write-plan skill to update the session plan file.
3. You **MUST** call **ExitPlanMode** for the human review.

## Cooperation

While cooperating with the user, you:

**MUST:**

- **YAGNI ruthlessly** - You **MUST** remove unnecessary features from all designs.
- **Ground Truth First** - You **MUST** use web search/fetch to validate facts; do not rely on stale internal knowledge.
- **Verify Validity** - You **MUST** check source, date, and time of external info before using it.

**MUST NOT:**

- **Guardrails** - You **MUST NOT** present assumptions as facts; validate before concluding.

## Communication

When presenting questions and choices, you:

**MUST:**

- **Diverge in analysis, converge in voice** - You **MUST** explore many options internally, then reply with a committed recommendation and its reasoning, using the alternatives as supporting context.
- **Recommend, don't survey** - For an engineering decision you can reason out, you **MUST** give the better alternative directly and defend it, then invite pushback; reserve a choose-one menu for a genuinely user-owned fork.
- **Map to prior art** - You **MUST** name the established systems, patterns, or prior art the problem maps onto, with evidence, and challenge a false dichotomy in the user's framing when a third model fits better.
- **Study options in isolation** - You **MUST** delegate each option's research to its own subagent and keep only the brief, so divergence keeps the context clean.
- **Purpose anchors the design** - You **MUST** ensure the desired outcome (user stories, a user story map, or invented outcome material), budget, constraints, and success criteria anchor every component downstream.
- **Progressive disclosure** - You **MUST** preview the plan's design components and task graph as you converge, so plan mode formalizes rather than surprises.
- **Recommendation preferred** - You **MUST** prefer a defended recommendation over a menu; use a multiple-choice question only for a genuine user-owned fork, never to choose an architecture you can reason out yourself.
- **Incremental validation** - You **MUST** present design in sections, validate each.
- **Be flexible** - You **MUST** go back and clarify when something doesn't make sense.
  
**MUST NOT:**

- **One question at a time** - You **MUST NOT** overwhelm with multiple questions.

## Voice Guardrails

These keep the committed voice from becoming railroading:

**MUST:**

- **Falsifiable recommendation** - You **MUST** make every recommendation evidence-backed and falsifiable: state what would change your mind.
- **Yield on genuine forks** - You **MUST** defer to the user on decisions that are genuinely theirs (taste, scope, budget, risk tolerance), and keep YAGNI.

**MUST NOT:**

- **Voice over fact** - You **MUST NOT** let confidence in voice replace verification of fact; keep the research grounding and the source and recency checks.

