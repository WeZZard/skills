# Design Philosophy Highlights — Interactive Workflow Diagram

## Overview

Replace the static Design Philosophy section on the plugin detail page with an interactive visualization. A single rounded rectangle represents the Claude Code workflow. Events sit on its edges, grouped by category. When a user clicks a design-philosophy button, two things happen:

1. **Additions** attach to specific event points on the rectangle, showing what that philosophy contributes to the workflow.
2. **Highlight content** appears in the center of the rectangle — the key artifact or concept the philosophy introduces.

This creates an implicit before/after comparison: the bare rectangle is vanilla Claude Code; the additions are what Intelligence Scale brings.

---

## The Workflow Rectangle

```
              ●                     ●
         SessionStart          UserPromptSubmit
    ┌─────────┼─────────────────────┼─────────┐
    │         │                     │         │
    │         ▼                     ▼         │
    │                                         │
    │                                         ● PreToolUse
    │                                         │
    ● SubagentStop                            │
    │                                         │
    │         (center area                    ● PostToolUse
    │          for highlight                  │
    │          content)                       │
    │                                         │
    ● SubagentSpawn                           │
    │                                         ● PostToolUseFailure
    │                                         │
    │         ▲                     ▲         │
    │         │                     │         │
    └─────────┼─────────────────────┼─────────┘
              ●                     ●
         ExitPlanMode          EnterPlanMode
```

### Edge Grouping

| Edge | Events | Rationale |
|------|--------|-----------|
| **Top** | SessionStart, UserPromptSubmit | Session and prompt entry points |
| **Right** | PreToolUse, PostToolUse, PostToolUseFailure | Tool execution lifecycle |
| **Bottom** | ExitPlanMode, EnterPlanMode | Plan mode transitions |
| **Left** | SubagentStop, SubagentSpawn | Subagent lifecycle |

Each edge justifies its events independently. The right edge distributes 3 events at 1/4, 1/2, and 3/4 of the edge height. The left edge distributes 2 events at 1/3 and 2/3. They do **not** align horizontally with each other. No events sit on corners.

### Two Layers of Content

**Layer 1 — Additions (on the edges):** When a philosophy is selected, labeled callouts appear at specific event points. These represent hooks, skills, or tools that the philosophy adds to the workflow.

**Layer 2 — Highlight (in the center):** The rectangle's interior shows the key artifact of the selected philosophy — a plan template, a comparison table, a recovery flowchart, etc.

### Design Principles

1. **Before/after comparison.** The bare rectangle is "before" (vanilla Claude Code). Additions show "after" (with Intelligence Scale). This makes the value proposition immediately visible.

2. **Visual diff.** Rather than highlighting existing elements, we show what each philosophy *adds*. This is more intuitive than dimming/brightening.

3. **LLM-friendly.** An LLM performs worse when it only sees the "before" state. By showing the base workflow alongside text that explains how the philosophy acts on it, both humans and LLMs can better imagine the outcome.

---

## Discovered Workflow Components

### Hooks (from hooks.json)

| ID | Hook Type | Trigger | Effect |
|----|-----------|---------|--------|
| `session-start` | SessionStart | startup, resume, clear, compact | Injects using-skills content |
| `post-plan-mode` | PostToolUse | EnterPlanMode tool | Reminds to use write-plan skill |
| `post-plan-agent` | SubagentStop | Plan subagent completes | Reminds to use write-plan skill |
| `post-tool-error` | PostToolUseFailure | Any tool failure | Suggests recover-from-errors skill |
| `user-prompt` | UserPromptSubmit | Every user prompt | Reminds to spawn subagents |

### Skills

| ID | Skill Name | Purpose |
|----|------------|---------|
| `using-skills` | using-skills | Skill discovery and invocation rules |
| `brainstorming` | brainstorming | Idea exploration and design |
| `write-plan` | write-plan | Creates structured plan file |
| `execute-plan` | execute-plan | Executes plan with parallelism |
| `audit-plan` | audit-plan | Verifies plan execution |
| `recover-from-errors` | recover-from-errors | Handles error recovery |

### Actions/Tools (Claude Code built-in)

| ID | Action |
|----|--------|
| `enter-plan-mode` | EnterPlanMode tool |
| `exit-plan-mode` | ExitPlanMode tool |
| `spawn-subagent` | Task tool (spawn subagent) |

---

## Philosophy-to-Event Mapping

| Philosophy | Events Highlighted | Center Highlight |
|---|---|---|
| Addressing the Review Burden | EnterPlanMode, ExitPlanMode, PostToolUse | Comparison: traditional plan vs structured plan |
| Polished Plan Structure | EnterPlanMode, ExitPlanMode, SubagentStop | Plan file template with before/after |
| Maximizing Task Parallelism | UserPromptSubmit, SubagentSpawn, SubagentStop | Sequential vs parallel task execution |
| Error Recovery | PostToolUseFailure | Recovery procedure (check plan → realign → retry) |
| Plan Execution Audit | PostToolUse | Audit report table (Task, Status, Evidence) |

---

## Configuration Structure

### TOML Schema

```toml
# claude/intelligence-scale/website.toml

[workflow_diagram]
base_description = "The standard Claude Code agent loop: prompt → think → act → respond"

[[philosophy.sections]]
id = "plan-structure"
title = "Polished Plan Structure"
content = "Intelligence Scale uses a refined plan structure..."

# Additions attach to named events on the rectangle edges
[[philosophy.sections.additions]]
id = "enter-plan-hook"
event = "PostToolUse"
type = "hook"
label = "PostToolUse Hook"
description = "Triggers when EnterPlanMode is used"
effect = "Injects reminder to use write-plan skill"

[[philosophy.sections.additions]]
id = "plan-agent-hook"
event = "SubagentStop"
type = "hook"
label = "SubagentStop Hook"
description = "Triggers when Plan subagent completes"
effect = "Ensures plan file is properly structured"

# Center highlight content
[philosophy.sections.highlight]
type = "template"
title = "Plan File Template"

content = """
# Plan: [Feature Name]

**Goal:** One sentence describing what this plan achieves.

## Tasks
1. Task with exact file paths
2. Task with verification steps

## Verification
- Automated: `npm run test`
- Manual: Visual inspection required

## Human Verification Gate
**Criterion:** "Description of what needs validation"
**Category:** Subjective Judgment
"""

# Optional before/after comparison
[philosophy.sections.highlight.comparison]
before_label = "Typical AI Plan"
before = """
- Do thing 1
- Do thing 2
- Test it
"""
after_label = "Intelligence Scale Plan"
after = """
1. **Create component** (file: src/Component.tsx)
   - Exact code provided
   - Verification: `npm run typecheck`

2. **Human Verification Gate**
   - Criterion: "UI looks correct"
   - Category: Subjective Judgment
"""
```

### TypeScript Interface

```typescript
type WorkflowEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "EnterPlanMode"
  | "ExitPlanMode"
  | "SubagentSpawn"
  | "SubagentStop";

interface PhilosophySection {
  id: string;
  title: string;
  content: string;

  // Additions attach to named events on the rectangle edges
  additions: Array<{
    id: string;
    event: WorkflowEvent;
    type: "hook" | "skill" | "tool";
    label: string;
    description: string;
    effect: string;
  }>;

  // Center highlight content
  highlight: {
    type: "template" | "diagram" | "code" | "comparison" | "table";
    title: string;
    content: string;
    comparison?: {
      before_label: string;
      before: string;
      after_label: string;
      after: string;
    };
  };
}
```

---

## Human-LLM Collaboration Workflow

### Problem

- LLM evaluation may not detect all elements that need to be highlighted.
- Plugin content and skill implementations change over time.
- We need a robust process: LLM suggests first, human edits second, edits persist until explicit regeneration.

### Solution: Two-Phase Configuration

1. **LLM generates suggestions** on explicit command only.
2. **Human reviews and edits** the TOML configuration.
3. **Edits persist** — subsequent builds use the human-curated values without calling the LLM.

```
  npm run generate:workflow -- --regenerate=plan-structure
       │
       ▼
  LLM analyzes skill content
       │
       ▼
  Writes suggestions to: suggestions/plan-structure.json
  (suggested_additions, suggested_highlight, reasoning)
       │
       ▼
  Human reviews suggestions, edits website.toml
       │
       ▼
  Subsequent builds read website.toml directly (no LLM call)
```

### File Structure

```
claude/intelligence-scale/
├── website.toml                    # Human-editable config (source of truth)
├── suggestions/                    # LLM-generated suggestions (for review)
│   ├── plan-structure.json
│   ├── error-recovery.json
│   └── ...
└── ...

website/src/content/generated/
└── workflow/
    └── intelligence-scale.json     # Final merged output for Astro
```

---

## Implementation Approach

### SVG Rendering

The diagram is a static SVG rendered at build time. All elements are always in the DOM. Dynamic behavior is achieved through CSS class toggling, not DOM insertion/removal.

```html
<svg class="workflow-diagram" viewBox="0 0 800 500">
  <!-- The rectangle -->
  <rect class="workflow-rect" x="50" y="50" width="700" height="400" rx="20" />

  <!-- Event markers on edges -->
  <!-- Top edge -->
  <g class="event-marker" data-event="SessionStart">
    <circle cx="250" cy="50" r="6" />
    <text x="250" y="40">SessionStart</text>
  </g>
  <g class="event-marker" data-event="UserPromptSubmit">
    <circle cx="550" cy="50" r="6" />
    <text x="550" y="40">UserPromptSubmit</text>
  </g>

  <!-- Right edge: 3 events at 1/4, 1/2, 3/4 -->
  <g class="event-marker" data-event="PreToolUse">
    <circle cx="750" cy="150" r="6" />
  </g>
  <g class="event-marker" data-event="PostToolUse">
    <circle cx="750" cy="250" r="6" />
  </g>
  <g class="event-marker" data-event="PostToolUseFailure">
    <circle cx="750" cy="350" r="6" />
  </g>

  <!-- Left edge: 2 events at 1/3, 2/3 -->
  <g class="event-marker" data-event="SubagentStop">
    <circle cx="50" cy="183" r="6" />
  </g>
  <g class="event-marker" data-event="SubagentSpawn">
    <circle cx="50" cy="317" r="6" />
  </g>

  <!-- Bottom edge -->
  <g class="event-marker" data-event="ExitPlanMode">
    <circle cx="250" cy="450" r="6" />
  </g>
  <g class="event-marker" data-event="EnterPlanMode">
    <circle cx="550" cy="450" r="6" />
  </g>

  <!-- Additions (hidden by default, shown per philosophy) -->
  <g class="addition" data-philosophy="plan-structure" data-event="PostToolUse">
    <rect class="addition-box" />
    <text>PostToolUse Hook: write-plan reminder</text>
  </g>

  <!-- Center highlight area -->
  <foreignObject x="150" y="120" width="500" height="260" class="highlight-center">
    <!-- HTML content rendered here -->
  </foreignObject>
</svg>
```

### CSS State Management

```css
/* Default: additions hidden */
.addition {
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.3s, transform 0.3s;
}

/* When philosophy is selected, show its additions */
.workflow-diagram[data-active="plan-structure"] .addition[data-philosophy="plan-structure"] {
  opacity: 1;
  transform: translateY(0);
}

/* Event markers glow when their philosophy is active */
.workflow-diagram[data-active="plan-structure"] .event-marker[data-event="PostToolUse"] circle {
  fill: var(--color-accent);
  filter: drop-shadow(0 0 4px var(--color-accent));
}

/* Highlight panels */
.highlight-panel { display: none; }
.highlight-panel.is-active {
  display: block;
  animation: fadeIn 0.3s ease;
}
```

### Progressive Enhancement

- **No JS**: Base diagram visible, all highlight panels shown stacked.
- **With JS**: Interactive philosophy buttons, animated transitions, event marker glow.

---

## Open Questions

1. **Highlight content types**: What types of content should the center highlight support? (template, diagram, code, comparison, table)
2. **Animation**: How elaborate should the transitions be when switching philosophies?
3. **Mobile**: How should the layout adapt on smaller screens?

---

## Next Steps

1. [ ] Finalize TOML configuration schema
2. [ ] Create sample configuration for one philosophy (Polished Plan Structure)
3. [ ] Implement SVG diagram component
4. [ ] Implement philosophy button navigation
5. [ ] Add CSS transitions and animations
6. [ ] Test with all five philosophies
7. [ ] Add LLM suggestion generation script
