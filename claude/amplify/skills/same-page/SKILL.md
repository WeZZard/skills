---
name: same-page
description: <EXTREMELY_IMPORTANT>You MUST use same-page when the user asks you to explain, clarify, or justify your previous messages.</EXTREMELY_IMPORTANT>
---

# Same Page

## Overview

Re-explain your previous message in plain language so the user fully understands it.
Lead with a one-sentence answer, explain it through a concrete example the reader can
picture, show one ASCII diagram, and end with a compact summary table. Keep the
evidence-and-confidence discipline throughout, but express it **compactly and inline**
inside the explanation — not as heavy per-claim blocks.

**Announce at start:** the equivalent, in the user's language, of "Let me make sure we're on the same page."

## The Standard Shape

Use this shape every time. Trim it proportionally for a short prior message — a one-line
point may need only the one-sentence version plus a small diagram — but do not invent a
different structure.

1. **Announce line** (above).
2. **## The one-sentence version** — the single plainest sentence that captures the answer. No jargon.
3. **## The plain story** (name the heading to fit the topic) — explain the reasoning in
   plain, literal language, walking through a concrete example or scenario the reader can
   picture. Prefer ordinary words over technical terms; when a technical term is
   unavoidable, define it in the same sentence. State things directly. Carry the evidence
   inline here (see **Evidence and Confidence**).
4. **One ASCII diagram** — exactly one compact picture that reflects the real names and
   flow from the thread or codebase, with a one-line caption stating what to take away.
5. **## Bottom line** — a compact summary table (the cases, the options, the before/after —
   whatever the message is about), then a one-line confidence note and any open question.

## Evidence and Confidence

Every material claim must be supportable, expressed compactly inside the story rather than
as a separate block:

- Cite a concrete artifact for each substantive claim: `file:line`, command output, URL, or a doc quote.
- Tag confidence inline where it matters: `(High — verified at loop-resume.mjs:96)`.
- **High** — directly verified against source code, documentation, or runtime output.
- **Medium** — inferred from strong patterns or partial evidence; likely but not proven.
- **Low** — general knowledge, analogy, or assumption; could be wrong.
- If you cannot find evidence for something you said before, say so and retract or downgrade it.
- Re-read source files and re-run commands as needed. Do not rely on memory of earlier tool calls.

## The ASCII Diagram

- Include **exactly one** (a small set only when true parallelism requires it).
- It MUST use the real names and flow from the discussion — not a generic stock picture.
- Keep it compact: aim under ~20 lines and ~72 columns for terminal readability.
- Pick the form that fits the content:
  - flow / sequence (boxes and arrows) for control or data flow;
  - tree or indented hierarchy for nesting or ownership;
  - layer / stack blocks for layers, stacks, or phases;
  - before/after sketch for a state change;
  - labeled graph (nodes + edges) for loose relationships.

## Key Principles

- **Plain language first** — ordinary words, short sentences, a concrete example; define any unavoidable jargon in place.
- **Literal, not figurative** — state things directly; avoid metaphors and analogies when a literal explanation works.
- **One-sentence answer up front** — the reader should get the gist from the very first line.
- **Evidence over assertion** — compact inline citations and confidence, but never hand-waving.
- **Honesty over completeness** — prefer an explicit Low confidence over implied certainty.
- **One strong picture** — a single diagram that clarifies structure; skip decoration.
- **Proportional length** — trim the shape for a short message; do not pad.
- **Re-verify, don't recall** — re-read files and re-run checks rather than trusting memory of earlier tool output.
