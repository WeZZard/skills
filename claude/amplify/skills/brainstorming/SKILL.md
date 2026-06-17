---
name: brainstorming
description: <EXTREMELY_IMPORTANT>You MUST use brainstorming when the user wants to explore ideas, discuss approaches, research a topic, or has been stuck on a problem. Always brainstorm before beginning implementation.</EXTREMELY_IMPORTANT>
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs through natural collaborative dialogue, and progressively disclose the structure the plan will later formalize — so entering plan mode formalizes what you already discussed instead of introducing new structure.

A good brainstorm diverges before it converges: expose a lot of choices first, let the purpose sharpen as the user reacts to those choices, then connect the surviving options into a coherent design. That convergence is exactly the design components and task graph that the amplify:write-plan skill will formalize — preview them as you go.

## The Process

The three stages below are not strictly sequential. Diverge runs first, seeded by the user's request; clarification is driven by the user reacting to the options you exposed — so Diverge and Clarify interleave. Connect follows once a direction is firm.

**Stage 1 — Diverge: expose choices (seeded by the request)**

- Seed divergence from context: check the current project state (files, docs, recent commits) and recall the goal, purpose, and design principles.
- Then, starting from the user's request, name the candidate option space before narrowing: approaches, technologies, references, prior art.
- Study each option in an isolated subagent to keep this conversation's context clean. You **MUST** spawn one `Explore` subagent per candidate option, in parallel (single message, multiple tool calls). Each subagent studies its one option — feasibility, trade-offs, references, risks — uses `WebSearch` to ground it in current fact, applies the Validating Information rules below, and returns a **compact brief**: what it is, pros and cons, key references, and the main risk. Keep only the briefs in this thread, not the raw research. Batch the subagents when there are many options.
- Present the synthesized options as the way to draw out purpose, explaining each with the user's strengths and weaknesses in mind: "here are the possibilities — which pull on you, and why?" Concrete choices elicit purpose better than abstract questions.
- Commit to nothing yet. This is the raw-materials stage.

**Stage 2 — Clarify: purpose sharpens (reaction-driven)**

- Clarification is driven by the user reacting to and selecting among the Stage 1 options — so Stage 1 and Stage 2 interleave.
- Ask questions one at a time with the **AskUserQuestion** tool; prefer multiple choice; one question per message.
- Anchor questions to the options on the table (which option, and why) rather than asking abstractly.
- As the direction emerges, pin down the user stories (as a [role], I want [capability], so that [benefit]), the constraints, and the success criteria. These anchor every design component downstream.

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

## Key Principles

- **Diverge before converging** - Expose many choices before narrowing.
- **Options as the elicitation device** - Draw out purpose by having the user react to concrete choices, not abstract questions.
- **Study options in isolation** - Delegate each option's research to its own subagent and keep only the brief, so divergence keeps the context clean.
- **Purpose anchors the design** - User stories, constraints, and success criteria anchor every component downstream.
- **Progressive disclosure** - Preview the plan's design components and task graph as you converge, so plan mode formalizes rather than surprises.
- **One question at a time** - Don't overwhelm with multiple questions.
- **Multiple choice preferred** - Easier to answer than open-ended when possible.
- **YAGNI ruthlessly** - Remove unnecessary features from all designs.
- **Ground Truth First** - Use web search/fetch to validate facts; do not rely on stale internal knowledge.
- **Verify Validity** - Check source, date, and time of external info before using it.
- **Guardrails** - Never present assumptions as facts; validate before concluding.
- **Incremental validation** - Present design in sections, validate each.
- **Be flexible** - Go back and clarify when something doesn't make sense.
