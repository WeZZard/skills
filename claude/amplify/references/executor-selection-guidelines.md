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

Built-in Claude subagent, read-only by construction (no Edit/Write).

**When to Use:**

1. **Implementation stage:** not usable.
2. **Auditing stage:** not usable.

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

## subagent(amplify:kimi-driver)

You **MUST NOT** select `amplify:kimi-driver` unless `kimi` installed (`$AMPLIFY_KIMI_AVAILABLE` == `true`) and user approval (`$AMPLIFY_USE_KIMI_APPROVED` == `true`).

**When to Use:**

1. **Implementation stage:**
    1. Building things with image understanding.
2. **Auditing stage:**
    1. Auditing with image understanding.

## MCP-use Drivers

### subagent(amplify:chrome-devtools-driver)

You **MUST NOT** select `amplify:chrome-devtools-driver` unless the chrome-devtools MCP is available in this session (`$AMPLIFY_CHROME_DEVTOOLS_AVAILABLE` == `true`).

**When to Use:** the work is driving or observing a running web application (Chromium) rather than editing files.

### subagent(amplify:playwright-driver)

You **MUST NOT** select `amplify:playwright-driver` unless the Playwright MCP is available in this session (`$AMPLIFY_PLAYWRIGHT_AVAILABLE` == `true`).

**When to Use:** the work is driving or observing a running web application across Chromium, Firefox, or WebKit rather than editing files.

### subagent(amplify:computer-use)

You **MUST NOT** select `amplify:computer-use` unless computer-use capability is available in this session (`$AMPLIFY_COMPUTER_USE_AVAILABLE` == `true`)

**When to Use:** the work is driving an on-screen GUI application.

</EXECUTOR_SELECTION_GUIDELINES>
