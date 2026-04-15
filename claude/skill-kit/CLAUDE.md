# skill-kit

Tools for auditing and improving Claude Code skill definitions.

## Skills

### skill-lint

Audit skill/prompt files for structural issues, step continuity, cross-reference integrity, and JSON schema format coherence. Uses a two-phase approach: automated deterministic checks followed by LLM semantic analysis via parallel subagents.

**Usage:** `/skill-lint <path>` — pass a directory or file path to audit.
