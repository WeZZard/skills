# Executor Selection Guidelines

<EXECUTOR_SELECTION_GUIDELINES>

## Built-in Agents

### subagent(general-purpose)

Built-in Claude subagent with the standard tool set.

**When to Use:**

1. **Implementation stage:**
    1. The default implementer — ordinary work like editing files, running commands, and multi-step logic.
2. **Auditing stage:**
    1. Audit tasks purely invoke tools and compile the tool results.
    2. The fallback blind auditor when no external agent is installed and approved.

### subagent(explore)

Built-in Claude subagent, read-only by construction (no Edit/Write), with Read/Grep/Glob/Bash.

**When to Use:**

1. **Implementation stage:** not usable (cannot edit files).
2. **Auditing stage:** A read-only blind auditor — well-suited to **Technical Execution** (read the changed files and run the task's verification commands via Bash) where no semantic/external judgment is needed.

### subagent(plan)

Built-in Claude subagent, read-only and planning-oriented.

**When to Use:**

1. **Implementation stage:** not usable.
2. **Auditing stage:** not usable.

## External Agent Drivers

### subagent(amplify:codex-driver)

You **MUST NOT** select `amplify:codex-driver` unless `codex` installed (`$AMPLIFY_CODEX_AVAILABLE` == `true`) and user approval (`$AMPLIFY_USE_CODEX_APPROVED` = `true`).

**When to Use:**

1. **Implementation stage:**
    1. Building complex modules.
    2. Involving image generation.
2. **Auditing stage:**
    1. Auditing code edits not limited to compiling tool results but contain semantics understanding.

**How to Use:**

1. You **MUST** prepend the special control-line template. You **MUST** compose its spawning prompt in this exact shape, with the `ROLE` line prepended above the `---` separator and the task or audit prompt below it:

    ```text
    ROLE: audit | impl
    ---
    <the task or audit prompt for Codex>
    ```

2. **Choose `ROLE`.** Set it from the stage: `audit` for an auditing-stage selection, `impl` for an implementation-stage selection; the driver maps the role to Codex's sandbox internally (see `${CLAUDE_PLUGIN_ROOT}/agents/codex-driver.md`). If omitted or invalid, the driver falls back to `audit` (read-only). There is no model line — Codex runs its own single model.

## subagent(amplify:kimi-driver)

You **MUST NOT** select `amplify:kimi-driver` unless `kimi` installed (`$AMPLIFY_KIMI_AVAILABLE` == `true`) and user approval (`$AMPLIFY_USE_KIMI_APPROVED` == `true`).

**When to Use:**

1. **Implementation stage:**
    1. Building things with image understanding.
2. **Auditing stage:**
    1. Auditing with image understanding.

**How to Use:**

1. You **MUST** prepend the special control-line template. You **MUST** compose its spawning prompt in this exact shape, with the `ROLE` line prepended above the `---` separator and the task or audit prompt below it:

    ```text
    ROLE: audit | impl
    ---
    <the task or audit prompt for Kimi>
    ```

2. **Choose `ROLE`.** Set it from the stage: `audit` for an auditing-stage selection, `impl` for an implementation-stage selection; the driver maps the role to Kimi's permissions internally (see `${CLAUDE_PLUGIN_ROOT}/agents/kimi-driver.md`). If omitted or invalid, the driver falls back to `audit` (read-only). There is no model line — Kimi runs its own single model.

## MCP-use Agents

### subagent(amplify:browser-use-chrome-devtools)

You **MUST NOT** select `amplify:browser-use-chrome-devtools` unless the chrome-devtools MCP is available in this session (`$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE` == `true`).

**When to Use:** the work is driving or observing a running web application (Chromium) rather than editing files.

**Resource:** **Exclusive** — the engine serializes it to one at a time per host (prefer a concurrency-safe subagent when you need parallelism).

### subagent(amplify:browser-use-playwright)

You **MUST NOT** select `amplify:browser-use-playwright` unless the Playwright MCP is available in this session (`$AMPLIFY_PLAYWRIGHT_AVAILABLE` == `true`).

**When to Use:** the work is driving or observing a running web application across Chromium, Firefox, or WebKit rather than editing files.

**Resource:** **Concurrency-safe** — runs isolated, so several can run in parallel.

### subagent(amplify:computer-use)

You **MUST NOT** select `amplify:computer-use` unless computer-use capability is available in this session (`$AMPLIFY_COMPUTER_USE_AVAILABLE` == `true`)

**When to Use:** the work is driving an on-screen GUI application.

**Resource:** **Exclusive** — the engine serializes it to one at a time per host (prefer a concurrency-safe subagent when you need parallelism).

## Runtime Roles

### subagent(amplify:audit-resolver)

A fixed runtime role, **not** author-selectable in a plan. `execute-plan` spawns it for each `<id>.resolve` subnode after the implementer completes; it inspects the diff and returns the auditor panel (see `${CLAUDE_PLUGIN_ROOT}/agents/audit-resolver.md`). It is blind, read-only, and takes no exclusive resource.

**When to Use:** never use it as an executor.

</EXECUTOR_SELECTION_GUIDELINES>
