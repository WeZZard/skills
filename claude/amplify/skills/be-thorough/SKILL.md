---
name: be-thorough
description: "Enforces evidence-based reasoning by requiring investigation, source verification, and tested assumptions before concluding. Use when debugging code errors, diagnosing root causes, troubleshooting unexpected behavior, or reviewing uncertain claims."
---

# Be Thorough

## Workflow

1. **Investigate**: Reproduce the issue or gather context. Read relevant source code, logs, and documentation rather than relying on memory.
2. **Form a hypothesis**: State what you believe is happening and why.
3. **Gather evidence**: Use grep, file reads, test runs, or web search to find concrete support. Cite specific files, line numbers, or outputs.
4. **Verify against references**: Read the actual source code or documentation to confirm — do not assume behavior from memory.
5. **Test the hypothesis**: Run commands, write a minimal reproducer, or check edge cases to validate.
6. **Conclude only with evidence**: Present your finding with the supporting evidence. If evidence is insufficient, say so and outline what would resolve the uncertainty.

## Key Rules

- Never present assumptions as facts — qualify uncertain claims explicitly.
- Always prefer reading source code over recalling from memory.
- If multiple hypotheses exist, investigate each before committing to one.
