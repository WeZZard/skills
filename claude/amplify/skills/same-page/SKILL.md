---
name: same-page
description: You MUST invoke this skill when the user asks you to explain, clarify, or justify your previous message. Produces an adaptively structured explanation with evidence, confidence, and ASCII art—format is chosen per message, not fixed.
---

# Same Page

## Overview

Re-explain your previous message so the user fully understands your reasoning. Every run must still deliver **evidence with confidence** and **at least one ASCII visualization** — but the **shape of the explanation** (sections, order, density, diagram style) is **designed for that specific message**, not copied from a single template.

**Announce at start:** "Let me make sure we're on the same page."

## The Process

### Step 1: Identify What to Explain

1. Look at your most recent substantive message (skip tool-call-only turns).
2. Extract the **key claims** — decisions made, facts stated, recommendations given.
3. If the message is long, group claims into themes (2-5 is typical; fewer if the thread is narrow).

### Step 2: Design the Explanation Format

Before writing the body, decide **how** to present the explanation. Pick a layout that matches the prior message’s shape and the user’s likely mental model.

**Consider:**

| Signal in the prior message | Favor this shape |
| ---------------------------- | ---------------- |
| Single decision or one main thesis | One narrative arc → evidence blocks in reading order → one central diagram |
| Several independent claims | Per-claim mini-sections, or a compact evidence table with a row per claim |
| Comparison or trade-offs | Lead with a comparison table (ASCII) or side-by-side blocks, then supporting evidence |
| Process, pipeline, or causality | Sequence or flow diagram first, then cite evidence per stage |
| Heavy uncertainty or mixed confidence | Open with a confidence overview (e.g. bullet summary of High/Medium/Low counts), then drill down |
| Debugging / root-cause narrative | Timeline or chain diagram, evidence ordered as discovery happened |

**You MUST briefly state your format choice** (one or two sentences): what structure you picked and why it fits this message. Place it right after the announce line or as a short `## How I'll explain this` section.

**Rules:**

- Do not default to a rigid "### Claim / Evidence / Confidence" block for every run unless that block is the best fit.
- You may combine patterns (e.g. a small table plus one flow diagram).
- Keep total length proportional to complexity: a short prior message may need a short same-page reply.

### Step 3: Evidence and Confidence

Whatever layout you chose, each material claim must still be **supportable**. Express evidence and confidence in a way that fits your format:

- **Minimum per claim:** identifiable claim, concrete evidence (file, line, URL, command output, doc quote), and a **High | Medium | Low** confidence with a one-line **basis** (why that level).
- **Presentation options** (mix as needed):
  - Repeated blocks (when claims are few and heavy).
  - A markdown table: Claim | Evidence | Confidence | Basis.
  - Inline badges after a sentence: `(High — verified in src/foo.ts)`.
  - A "confidence map" section listing only Low/Medium items first, then details.

**Confidence definitions (unchanged):**

- **High** — Directly verified against source code, documentation, or runtime output.
- **Medium** — Inferred from strong patterns, conventions, or partial evidence. Likely correct but not conclusively verified.
- **Low** — Based on general knowledge, analogy, or assumptions. Could be wrong.

**Rules:**

- You MUST cite specific artifacts for substantive claims. No hand-waving.
- If you cannot find evidence for something you said before, say so and retract or downgrade it.
- Re-read source files and re-run commands as needed. Do not rely on memory of earlier tool calls.

### Step 4: Visual Explanation (ASCII)

Include **at least one** ASCII art diagram (or a small set of related mini-diagrams if the format you designed needs it). **Choose the visual style dynamically:**

| Prior message suggests | Visual style |
| ---------------------- | ------------ |
| Control or data flow | Flow / sequence (boxes and arrows) |
| Nesting, ownership, taxonomy | Tree or indented hierarchy |
| Layers, stacks, phases | Layer / stack blocks |
| Options, criteria, scores | Comparison table or matrix |
| State or transitions | State-style or before/after sketch |
| Relationships without strict order | Simple labeled graph (nodes + edges) |

**Rules:**

- The diagram MUST reflect the actual discussion and names from the codebase or thread — not a generic stock picture.
- Prefer one strong diagram over many weak ones unless parallelism truly requires multiples.
- Keep each diagram compact (aim under ~20 lines, under ~72 columns) for terminal readability.
- Add a one-line caption: what the reader should take away.

### Step 5: Close

End in a way that matches your format: a short synthesis, a checklist of caveats, or a "what to verify next" — whichever fits. Call out low-confidence areas and open questions explicitly.

## Key Principles

- **Format follows content** — Design the explanation shape after you understand the prior message; do not force one template.
- **Evidence over assertion** — Layout is flexible; evidentiary discipline is not.
- **Honesty over completeness** — Prefer explicit Low confidence over implied certainty.
- **Visual over verbal where it helps** — Use ASCII where a picture clarifies structure; skip decoration.
- **Concise over exhaustive** — Match depth to stakes; avoid padding.
- **Re-verify, don't recall** — Re-read files and re-run checks rather than trusting memory of earlier tool output.
