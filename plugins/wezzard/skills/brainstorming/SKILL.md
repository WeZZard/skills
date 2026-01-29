---
name: brainstorming
description: You SHALL use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## The Process

**Understanding the Idea:**

- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring Approaches:**

- Propose 2-3 different approaches with trade-offs
- Use `WebSearch` to gather ground truth on relevant technologies, especially for rapidly changing libraries or APIs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Validating Information:**

- **Check Sources:** Verify the credibility of sources found via web search.
- **Check Recency:** Explicitly check the date and time of information. Discard outdated info.
- **Resolve Conflicts:** When findings contradict, reason about the conflict based on source authority and recency.
- **No Hallucinations:** Do not jump to conclusions without validation. If uncertain, verify with a search or ask the user.

**Presenting the Design:**

- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Update the Plan:**

If you are in plan mode, you SHALL use the wezzard:update-plan skill update the plan file.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Ground Truth First** - Use web search/fetch to validate facts; do not rely on stale internal knowledge
- **Verify Validity** - Check source, date, and time of external info before using it
- **Guardrails** - Never present assumptions as facts; validate before concluding
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design in sections, validate each
- **Be flexible** - Go back and clarify when something doesn't make sense
