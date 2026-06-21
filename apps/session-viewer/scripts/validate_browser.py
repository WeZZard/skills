from __future__ import annotations

import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time

from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from playwright.sync_api import Page, expect, sync_playwright


VIEWPORTS = [
    ("studio-native", 5120, 2880, 1),
    ("studio-effective", 2560, 1440, 2),
    ("desktop", 1440, 900, 1),
    ("mobile", 390, 844, 2),
]

EXPECTED_ATTACHMENT_TYPES = {
    "hook_success",
    "hook_additional_context",
    "deferred_tools_delta",
    "task_reminder",
    "todo_reminder",
    "queued_command",
    "command_permissions",
    "edited_text_file",
    "plan_mode",
    "plan_mode_exit",
    "mcp_instructions_delta",
    "agent_listing_delta",
    "plan_mode_reentry",
    "file",
    "date_change",
    "nested_memory",
    "hook_non_blocking_error",
    "auto_mode",
    "auto_mode_exit",
    "plan_file_reference",
    "invoked_skills",
    "compact_file_reference",
    "task_status",
    "ultra_effort_enter",
    "goal_status",
    "hook_blocking_error",
    "skill_listing",
    "experimental_attachment",
}

EXPECTED_ATTACHMENT_BADGES = {
    "HOOK SUCCESS",
    "HOOK CONTEXT",
    "TOOLS DELTA",
    "TASK REMINDER",
    "TODO REMINDER",
    "QUEUED COMMAND",
    "COMMAND PERMISSIONS",
    "EDITED FILE",
    "PLAN MODE",
    "PLAN MODE EXIT",
    "MCP INSTRUCTIONS",
    "AGENTS DELTA",
    "PLAN MODE REENTRY",
    "FILE",
    "DATE CHANGE",
    "NESTED MEMORY",
    "HOOK WARNING",
    "AUTO MODE",
    "AUTO MODE EXIT",
    "PLAN FILE",
    "INVOKED SKILLS",
    "FILE REFERENCE",
    "TASK STATUS",
    "ULTRA EFFORT",
    "GOAL STATUS",
    "HOOK BLOCKED",
    "SKILL LISTING",
    "ATTACHMENT",
}

STORY_MANIFEST: dict[str, dict[str, Any]] = {
    "reader.default": {
        "description": "Waterfall remains available and selecting message cards does not open the floating detail UI.",
        "requiredEvidence": ["dom_assertion", "screenshot"],
    },
    "left_nav.tabs": {
        "description": "Waterfall left rail defaults to message navigation and exposes the agent tree through a single drawer button.",
        "requiredEvidence": ["dom_assertion", "interaction", "geometry"],
    },
    "reader.subagent_panels": {
        "description": "Waterfall layout opens, selects, scrolls, resizes, and closes subagent panels.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "focus.layout_metrics": {
        "description": "Waterfall layout uses golden-section width constraints and clamps divider resizing.",
        "requiredEvidence": ["dom_assertion", "interaction", "geometry"],
    },
    "graph.dom_svg": {
        "description": "Timeline is the default and uses virtualized HTML/SVG rather than canvas.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.spawn_edges": {
        "description": "Parent task/tool timeline blocks expose spawned subagent connectors.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.multiselect": {
        "description": "Timeline blocks support multiple selection.",
        "requiredEvidence": ["interaction"],
    },
    "overview.header_stability": {
        "description": "Timeline keeps a stable pinned agent header above blocks while scrolling.",
        "requiredEvidence": ["dom_assertion", "interaction", "performance"],
    },
    "overview.scroll_blocks": {
        "description": "Timeline continues to show message blocks while scrolling down and uses full type labels.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "overview.track_alignment": {
        "description": "Timeline centers limited track sets and opens overflowing track sets with the main agent visible.",
        "requiredEvidence": ["geometry"],
    },
    "overview.problem_badge": {
        "description": "Timeline problem badges render outside message box borders without being cropped.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "ui.no_conversation_search": {
        "description": "Conversation search and left Problems list remain absent while dashboard search remains.",
        "requiredEvidence": ["dom_assertion"],
    },
    "ui.top_navigation": {
        "description": "Header navigation removes unnecessary controls and keeps Sessions, Backward/Forward, path, branch, Timeline/Waterfall, and Copy link centered in the header.",
        "requiredEvidence": ["dom_assertion", "geometry"],
    },
    "ui.layering": {
        "description": "Window-level overlays from the header and message detail dock render above and clear container-scoped timeline content.",
        "requiredEvidence": ["dom_assertion", "geometry"],
    },
    "timeline.detail_tabs": {
        "description": "Message detail windows show a badge row with Contents/Metadata/Raw tabs, move message text into Contents, show raw JSONL in Raw, and badge Metadata on errors.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "nav.return_forward": {
        "description": "Backward and Forward restore in-app transcript focus in both directions.",
        "requiredEvidence": ["interaction"],
    },
    "visual.studio": {
        "description": "Studio Display viewports show readable reader and timeline layouts without overlap.",
        "requiredEvidence": ["screenshot", "geometry"],
    },
    "perf.large_session": {
        "description": "Large timeline sessions render with bounded DOM and no browser health failures.",
        "requiredEvidence": ["performance", "console_network", "dom_assertion"],
    },
    "dashboard.tabs": {
        "description": "Dashboard exposes Claude Code and OpenCode tabs with one active session list.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "dashboard.independent_controls": {
        "description": "Claude and OpenCode dashboard controls keep independent URL-scoped values.",
        "requiredEvidence": ["interaction"],
    },
    "source.claude_config": {
        "description": "Claude source selection reads from the selected config/projects source.",
        "requiredEvidence": ["dom_assertion"],
    },
    "source.opencode_data": {
        "description": "OpenCode source selection reads from the selected data directory containing opencode.db.",
        "requiredEvidence": ["dom_assertion"],
    },
    "source.url_scoped": {
        "description": "Source choices are carried by the URL and are not persisted in browser storage.",
        "requiredEvidence": ["dom_assertion"],
    },
    "source.invalid_state": {
        "description": "Invalid source paths show clear non-crashing source states instead of falling back silently.",
        "requiredEvidence": ["dom_assertion"],
    },
    "opencode.readable_transcript": {
        "description": "OpenCode text, reasoning, tools, patches, files, compaction, and steps render readably.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "conversation.shared_layout": {
        "description": "Claude and OpenCode sessions share the same Timeline/Waterfall conversation workbench.",
        "requiredEvidence": ["dom_assertion"],
    },
    "nav.deep_links_back": {
        "description": "Agent-qualified conversation links and Sessions navigation preserve source scope.",
        "requiredEvidence": ["interaction"],
    },
    "compat.api_cli": {
        "description": "Agent-aware APIs work while legacy Claude APIs remain compatible.",
        "requiredEvidence": ["dom_assertion"],
    },
    "audit.studio_native": {
        "description": "New dashboard and OpenCode stories emit browser evidence at Apple Studio Display native resolution.",
        "requiredEvidence": ["screenshot", "geometry"],
    },
}

ALLOWED_SOURCES = {"playwright", "cdp"}
ALLOWED_KINDS = {"dom_assertion", "interaction", "screenshot", "geometry", "performance", "console_network"}
STORY_EVIDENCE: dict[str, list[dict[str, Any]]] = {story_id: [] for story_id in STORY_MANIFEST}
RUN_METADATA: dict[str, Any] = {}


def record(
    page: Page,
    story_id: str,
    *,
    kind: str,
    flow: str,
    viewport: str = "setup",
    selector: str = "",
    assertion: str,
    source: str = "playwright",
    artifact: str | None = None,
) -> None:
    if story_id not in STORY_EVIDENCE:
        raise KeyError(story_id)
    if source not in ALLOWED_SOURCES:
        raise AssertionError(f"{story_id}: invalid source {source}")
    if kind not in ALLOWED_KINDS:
        raise AssertionError(f"{story_id}: invalid evidence kind {kind}")
    item = {
        "storyId": story_id,
        "source": source,
        "kind": kind,
        "flow": flow,
        "viewport": viewport,
        "url": page.url,
        "hash": page.evaluate("location.hash"),
        "selector": selector,
        "assertion": assertion,
        "artifact": artifact,
    }
    if item not in STORY_EVIDENCE[story_id]:
        STORY_EVIDENCE[story_id].append(item)


def write_story_report(path: Path) -> None:
    failures: list[str] = []
    for story_id, manifest in STORY_MANIFEST.items():
        evidence = STORY_EVIDENCE[story_id]
        kinds = {item["kind"] for item in evidence}
        sources = {item["source"] for item in evidence}
        missing = set(manifest["requiredEvidence"]) - kinds
        if not evidence:
            failures.append(f"{story_id}: missing browser evidence")
        if missing:
            failures.append(f"{story_id}: missing evidence kinds {sorted(missing)}")
        if not sources <= ALLOWED_SOURCES:
            failures.append(f"{story_id}: non-browser evidence source {sorted(sources)}")
        for item in evidence:
            artifact = item.get("artifact")
            if artifact and not Path(artifact).exists():
                failures.append(f"{story_id}: missing artifact {artifact}")
    report = {
        "schemaVersion": 3,
        "runMetadata": RUN_METADATA,
        "storyManifest": STORY_MANIFEST,
        "stories": [
            {
                "id": story_id,
                "description": STORY_MANIFEST[story_id]["description"],
                "requiredEvidence": STORY_MANIFEST[story_id]["requiredEvidence"],
                "evidence": STORY_EVIDENCE[story_id],
                "status": "verified" if not any(f.startswith(f"{story_id}:") for f in failures) else "missing",
            }
            for story_id in STORY_MANIFEST
        ],
        "failures": failures,
    }
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if failures:
        raise AssertionError("browser story evidence failures:\n" + "\n".join(failures))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def write_jsonl(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def user_event(uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "sessionId": session,
        "agentId": agent_id,
        "isSidechain": bool(agent_id),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def assistant_text_event(uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "agentId": agent_id,
        "isSidechain": bool(agent_id),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "content": [{"type": "text", "text": text}],
        },
    }


def assistant_reasoning_event(uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "agentId": agent_id,
        "isSidechain": bool(agent_id),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "content": [{"type": "thinking", "thinking": text}],
        },
    }


def assistant_tool(uuid: str, session: str, tool_id: str, agent_id: str, *, index: int, sidechain: str | None = None) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "agentId": sidechain,
        "isSidechain": bool(sidechain),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": "Task",
                    "input": {"description": f"Spawn {agent_id}", "subagent_type": "general"},
                }
            ],
        },
    }


def assistant_bash_tool(uuid: str, session: str, tool_id: str, *, index: int) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": "Bash",
                    "input": {"command": "uv run pytest", "description": "Run fixture tests"},
                }
            ],
        },
    }


def tool_result(
    uuid: str,
    session: str,
    tool_id: str,
    text: str,
    *,
    index: int,
    agent_id: str | None = None,
    sidechain: str | None = None,
    is_error: bool = False,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "user",
        "uuid": uuid,
        "sessionId": session,
        "agentId": sidechain,
        "isSidechain": bool(sidechain),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": is_error}],
        },
    }
    if agent_id:
        event["toolUseResult"] = {"agentId": agent_id}
    return event


def attachment_event(uuid: str, session: str, *, index: int, attachment: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "attachment",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "attachment": attachment,
    }


def build_large_fixture(projects_dir: Path) -> str:
    project = projects_dir / "-tmp-project"
    session = "dual-layout-stress"
    subagents = project / session / "subagents"

    root_children = [f"agent-{index:03d}" for index in range(1, 19)]
    nested_children = [f"agent-{index:03d}" for index in range(19, 48)]
    deep_children = [f"agent-{index:03d}" for index in range(48, 65)]

    hook_additional_context = "\n".join(
        [
            "# Using Amplify Skills",
            "<EXTREMELY_IMPORTANT>",
            "Support every claim with local evidence and keep the active plan updated.",
            "Review the generated browser evidence before reporting completion.",
            "</EXTREMELY_IMPORTANT>",
        ]
        + [f"Context rule {index}: preserve semantic attachment sections for reviewers." for index in range(1, 18)]
        + ["FINAL CONTEXT MARKER"]
    )
    hook_success_stdout = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": hook_additional_context,
            },
            "diagnostics": {"source": "fixture", "status": "ok"},
        }
    )
    tool_names = [
        "CronCreate",
        "CronDelete",
        "CronList",
        "DesignSync",
        "NotebookRead",
        "NotebookWrite",
        "WebFetch",
        "WebSearch",
        "XcodeBuild",
        "XcodeTest",
    ]
    agent_types = [
        "amplify:audit-resolver",
        "amplify:browser-use-chrome-devtools",
        "amplify:browser-use-playwright",
        "amplify:plan-file-editor",
        "amplify:subagent-designer",
        "claude",
        "Plan",
        "Review",
        "Scout",
    ]
    mcp_blocks = [
        "## cua-driver\ncua-driver: cross-platform background computer-use automation.",
        "## figma\nUse Figma tooling for write actions inside the active design file.",
        "## github\nRead repository issues and pull requests through the connected GitHub app.",
        "## playwright\nDrive browser verification through Playwright and collect screenshots.",
        "## x-docs\nResolve local documentation snippets before using broad search.",
        "## xmcp\nInspect tool metadata and server health.",
        "## linear\nCoordinate issue references and project status.",
        "## gmail\nSearch mail only when the user explicitly asks for mailbox context.",
        "## notion\nResolve connected notes only when workspace context is requested.",
    ]
    skill_names = [
        "linear-cli",
        "product-planning",
        "done",
        "next",
        "standup",
        "browser-audit",
        "test-fixtures",
        "release-notes",
        "repo-scout",
        "design-review",
    ]
    skill_content = "\n".join(
        f"- {name}: {name.replace('-', ' ')} workflow guidance for this validation fixture."
        for name in skill_names
    )
    plan_content = "# Demo Plan\n\n" + "\n".join(
        f"{index}. Verify attachment card behavior for semantic fields."
        for index in range(1, 18)
    )
    invoked_skill_content = "\n".join(
        [f"Instruction line {index}: keep extracted content readable in the card body." for index in range(1, 14)]
        + ["FULL SKILL CONTENT MARKER"]
    )

    attachment_payloads = [
        (
            "root-startup-hook",
            {
                "type": "hook_success",
                "hookEvent": "SessionStart",
                "hookName": "SessionStart:startup",
                "exitCode": 0,
                "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
                "durationMs": 384,
                "stdout": hook_success_stdout,
            },
        ),
        (
            "root-hook-context",
            {
                "type": "hook_additional_context",
                "hookEvent": "UserPromptSubmit",
                "hookName": "UserPromptSubmit",
                "content": [hook_additional_context],
            },
        ),
        (
            "root-deferred-tools",
            {
                "type": "deferred_tools_delta",
                "addedNames": tool_names,
                "removedNames": ["LegacyTodoWrite", "OldNotebookEdit"],
                "readdedNames": ["WebSearch"],
                "pendingMcpServers": ["figma", "x-docs"],
                "addedLines": [f"{name}: available from fixture tooling" for name in tool_names],
            },
        ),
        (
            "root-agent-listing",
            {
                "type": "agent_listing_delta",
                "addedTypes": agent_types,
                "removedTypes": ["legacy-browser-agent", "legacy-plan-agent"],
                "addedLines": [f"{name}: handles a focused validation responsibility" for name in agent_types],
                "isInitial": False,
                "showConcurrencyNote": True,
            },
        ),
        (
            "root-mcp-instructions",
            {
                "type": "mcp_instructions_delta",
                "addedNames": ["cua-driver", "figma", "github", "playwright", "x-docs", "xmcp", "linear", "gmail", "notion"],
                "removedNames": ["deprecated-browser"],
                "addedBlocks": mcp_blocks,
            },
        ),
        (
            "root-skill-listing",
            {
                "type": "skill_listing",
                "skillCount": len(skill_names),
                "names": skill_names,
                "content": skill_content,
            },
        ),
        (
            "root-task-reminder",
            {
                "type": "task_reminder",
                "itemCount": 3,
                "content": ["Read the plan", "Implement semantic cards", "Run browser validation"],
            },
        ),
        (
            "root-todo-reminder",
            {
                "type": "todo_reminder",
                "itemCount": 2,
                "content": ["Review truncated sections", "Audit Raw tab completeness"],
            },
        ),
        (
            "root-queued-command",
            {
                "type": "queued_command",
                "prompt": "The computer-use MCP is now online. Resume the paused browser verification.",
                "commandMode": "prompt",
                "source_uuid": "root-queued-command-source",
                "origin": "plugin",
            },
        ),
        (
            "root-command-permissions",
            {
                "type": "command_permissions",
                "allowedTools": ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(node --check:*)"],
            },
        ),
        (
            "root-edited-text-file",
            {
                "type": "edited_text_file",
                "filename": "/tmp/project/CLAUDE.md",
                "snippet": "1\t# CLAUDE.md\n2\tUse semantic cards for attachment output.\n3\tKeep raw payloads available.",
            },
        ),
        (
            "root-plan-mode",
            {
                "type": "plan_mode",
                "reminderType": "full",
                "isSubAgent": False,
                "planFilePath": "/tmp/project/.plan/demo/index.md",
                "planExists": False,
            },
        ),
        (
            "root-plan-mode-exit",
            {
                "type": "plan_mode_exit",
                "planFilePath": "/tmp/project/.plan/demo/index.md",
                "planExists": False,
            },
        ),
        (
            "root-plan-mode-reentry",
            {
                "type": "plan_mode_reentry",
                "planFilePath": "/tmp/project/.plan/demo/index.md",
            },
        ),
        (
            "root-file-attachment",
            {
                "type": "file",
                "filename": "/tmp/project/config/session-viewer.json",
                "displayPath": "config/session-viewer.json",
                "content": {
                    "type": "text",
                    "file": {
                        "filePath": "/tmp/project/config/session-viewer.json",
                        "content": '{\n  "attachmentCards": "semantic",\n  "rawPayload": true\n}',
                        "numLines": 4,
                        "startLine": 1,
                        "totalLines": 4,
                    },
                },
            },
        ),
        (
            "root-date-change",
            {
                "type": "date_change",
                "newDate": "2026-06-14",
            },
        ),
        (
            "root-nested-memory",
            {
                "type": "nested_memory",
                "path": "/tmp/project/CLAUDE.md",
                "displayPath": "../CLAUDE.md",
                "content": {
                    "path": "/tmp/project/CLAUDE.md",
                    "type": "Project",
                    "content": "# CLAUDE.md\n\nUse local evidence and preserve user-authored changes.",
                    "contentDiffersFromDisk": False,
                },
            },
        ),
        (
            "root-hook-non-blocking-error",
            {
                "type": "hook_non_blocking_error",
                "hookEvent": "Stop",
                "hookName": "Stop:review-gate",
                "toolUseID": "toolu-warning",
                "exitCode": 127,
                "durationMs": 10,
                "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs",
                "stdout": "",
                "stderr": "Failed with non-blocking status code: /bin/sh: node: command not found",
            },
        ),
        (
            "root-auto-mode",
            {
                "type": "auto_mode",
            },
        ),
        (
            "root-auto-mode-exit",
            {
                "type": "auto_mode_exit",
            },
        ),
        (
            "root-plan-file-reference",
            {
                "type": "plan_file_reference",
                "planFilePath": "/tmp/project/.plan/demo/index.md",
                "planContent": plan_content,
            },
        ),
        (
            "root-invoked-skills",
            {
                "type": "invoked_skills",
                "skills": [
                    {
                        "name": "amplify:brainstorming",
                        "path": "plugin:amplify:brainstorming",
                        "content": invoked_skill_content,
                    },
                    {
                        "name": "browser:control-in-app-browser",
                        "path": "plugin:browser:control-in-app-browser",
                        "content": "Open local URLs and verify interactions with screenshots.",
                    },
                ],
            },
        ),
        (
            "root-compact-file-reference",
            {
                "type": "compact_file_reference",
                "filename": "/tmp/project/tests/session-viewer.test.mjs",
                "displayPath": "tests/session-viewer.test.mjs",
            },
        ),
        (
            "root-task-status",
            {
                "type": "task_status",
                "taskId": "af0f7940a364ab246",
                "taskType": "local_agent",
                "description": "Implement semantic attachment card extractor",
                "status": "completed",
                "deltaSummary": None,
                "outputFilePath": "/private/tmp/claude-501/task.output",
            },
        ),
        (
            "root-ultra-effort-enter",
            {
                "type": "ultra_effort_enter",
                "reminderType": "full",
            },
        ),
        (
            "root-goal-status",
            {
                "type": "goal_status",
                "met": False,
                "sentinel": True,
                "condition": "Run compile, tests, linter, and browser verification before marking complete.",
                "reason": "Browser validation has not completed yet.",
                "iterations": 3,
                "durationMs": 525000,
                "tokens": 242943,
            },
        ),
        (
            "root-hook-blocking-error",
            {
                "type": "hook_blocking_error",
                "hookEvent": "Stop",
                "hookName": "Stop:loop-resume",
                "toolUseID": "toolu-blocked",
                "blockingError": {
                    "blockingError": "amplify:execute-plan loop has ready work but no subagents in flight",
                    "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/loop-resume.mjs",
                },
            },
        ),
        (
            "root-unknown-attachment",
            {
                "type": "experimental_attachment",
                "content": "Unknown attachment content should remain readable through the fallback card.",
            },
        ),
    ]
    root_events: list[dict[str, Any]] = [
        user_event("root-title", session, "Dual layout stress session", index=0),
        assistant_text_event("root-assistant-text", session, "Assistant text fixture response", index=1),
        assistant_reasoning_event("root-assistant-reasoning", session, "Reason through the fixture coverage before acting.", index=2),
        assistant_bash_tool("root-bash-tool", session, "toolu_bash_fixture", index=3),
        tool_result("root-bash-result", session, "toolu_bash_fixture", "All fixture tests passed.", index=4),
    ]
    root_events.extend(
        attachment_event(uuid, session, index=index, attachment=payload)
        for index, (uuid, payload) in enumerate(attachment_payloads, start=len(root_events))
    )
    cursor = len(root_events)
    for child in root_children:
        tool_id = f"toolu_{child}"
        root_events.append(assistant_tool(f"spawn-{child}", session, tool_id, child, index=cursor))
        cursor += 1
        root_events.append(tool_result(f"result-{child}", session, tool_id, f"{child} complete", index=cursor, agent_id=child))
        cursor += 1
    while len(root_events) < 1127:
        root_events.append(user_event(f"root-{len(root_events)}", session, f"Root transcript message {len(root_events):04d}", index=len(root_events)))
    write_jsonl(project / f"{session}.jsonl", root_events)

    child_map: dict[str, list[str]] = {"agent-018": nested_children, "agent-047": deep_children}
    for index in range(1, 65):
        agent = f"agent-{index:03d}"
        events = [user_event(f"{agent}-title", session, f"Subagent {agent} goal", index=0, agent_id=agent)]
        cursor = 1
        for child in child_map.get(agent, []):
            tool_id = f"toolu_{child}"
            events.append(assistant_tool(f"spawn-{agent}-{child}", session, tool_id, child, index=cursor, sidechain=agent))
            cursor += 1
            events.append(tool_result(f"result-{agent}-{child}", session, tool_id, f"{child} complete", index=cursor, agent_id=child, sidechain=agent))
            cursor += 1
        if index in {7, 18, 47, 52}:
            error_id = f"toolu_error_{agent}"
            events.append(assistant_tool(f"err-call-{agent}", session, error_id, agent, index=cursor, sidechain=agent))
            cursor += 1
            events.append(
                tool_result(
                    f"err-result-{agent}",
                    session,
                    error_id,
                    f"Error: {agent} failed while sampling output",
                    index=cursor,
                    sidechain=agent,
                    is_error=True,
                )
            )
            cursor += 1
        while len(events) < 305:
            events.append(user_event(f"{agent}-{len(events)}", session, f"{agent} transcript message {len(events):04d}", index=len(events), agent_id=agent))
        write_jsonl(subagents / f"agent-{agent}.jsonl", events)
    return session


def build_limited_fixture(projects_dir: Path) -> str:
    project = projects_dir / "-tmp-limited-project"
    session = "centered-timeline"
    subagents = project / session / "subagents"
    root_events: list[dict[str, Any]] = [
        user_event("limited-title", session, "Centered timeline session", index=0)
    ]
    cursor = 1
    for agent in ["agent-001", "agent-002"]:
        tool_id = f"toolu_{agent}"
        root_events.append(assistant_tool(f"spawn-{agent}", session, tool_id, agent, index=cursor))
        cursor += 1
        root_events.append(tool_result(f"result-{agent}", session, tool_id, f"{agent} complete", index=cursor, agent_id=agent))
        cursor += 1
    while len(root_events) < 24:
        root_events.append(
            user_event(
                f"limited-root-{len(root_events)}",
                session,
                f"Limited main transcript message {len(root_events):02d}",
                index=len(root_events),
            )
        )
    write_jsonl(project / f"{session}.jsonl", root_events)

    for agent in ["agent-001", "agent-002"]:
        events = [
            user_event(f"{agent}-title", session, f"{agent} limited goal", index=0, agent_id=agent)
        ]
        while len(events) < 12:
            events.append(
                user_event(
                    f"{agent}-{len(events)}",
                    session,
                    f"{agent} limited transcript message {len(events):02d}",
                    index=len(events),
                    agent_id=agent,
                )
            )
        write_jsonl(subagents / f"agent-{agent}.jsonl", events)
    return session


def build_opencode_fixture(data_dir: Path) -> str:
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "opencode.db"
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(
            """
            create table session (
                id text primary key,
                project_id text,
                parent_id text,
                slug text,
                directory text,
                title text,
                version text,
                time_created integer,
                time_updated integer,
                path text,
                agent text,
                model text,
                cost real,
                input_tokens integer,
                output_tokens integer
            );
            create table message (
                id text primary key,
                session_id text not null,
                time_created integer,
                time_updated integer,
                data text
            );
            create table part (
                id text primary key,
                message_id text not null,
                session_id text not null,
                time_created integer,
                time_updated integer,
                data text
            );
            """
        )
        session_id = "ses_browser_opencode"
        connection.execute(
            """
            insert into session (
                id, project_id, slug, directory, title, version, time_created,
                time_updated, path, agent, model, input_tokens, output_tokens
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                "proj_browser",
                "opencode-browser-smoke",
                "/tmp/opencode-project",
                "OpenCode browser smoke",
                "1.17.9",
                1760000100000,
                1760000109000,
                "/tmp/opencode-project",
                "build",
                json.dumps({"id": "gpt-5.5", "providerID": "openai"}),
                128,
                256,
            ),
        )
        connection.execute(
            """
            insert into session (
                id, project_id, parent_id, slug, directory, title, version,
                time_created, time_updated, path, agent, model, input_tokens, output_tokens
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "ses_browser_opencode_child",
                "proj_browser",
                session_id,
                "opencode-browser-child",
                "/tmp/opencode-project",
                "OpenCode browser child",
                "1.17.9",
                1760000102500,
                1760000105000,
                "/tmp/opencode-project",
                "reviewer",
                json.dumps({"id": "gpt-5.5", "providerID": "openai"}),
                32,
                64,
            ),
        )
        messages = [
            (
                "oc_msg_user",
                session_id,
                1760000100001,
                1760000100001,
                {"role": "user", "agent": "build", "modelID": "gpt-5.5", "providerID": "openai"},
            ),
            (
                "oc_msg_assistant",
                session_id,
                1760000101000,
                1760000108000,
                {"role": "assistant", "agent": "build", "modelID": "gpt-5.5", "providerID": "openai", "finish": "stop"},
            ),
            (
                "oc_msg_child",
                "ses_browser_opencode_child",
                1760000103000,
                1760000104000,
                {"role": "assistant", "agent": "reviewer", "modelID": "gpt-5.5", "providerID": "openai", "finish": "stop"},
            ),
        ]
        connection.executemany(
            "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
            [(mid, sid, created, updated, json.dumps(data)) for mid, sid, created, updated, data in messages],
        )
        parts = [
            ("oc_user_text", "oc_msg_user", 1760000100001, {"type": "text", "text": "OpenCode browser smoke prompt"}),
            ("oc_reasoning", "oc_msg_assistant", 1760000101000, {"type": "reasoning", "text": "Inspect the OpenCode database."}),
            (
                "oc_tool",
                "oc_msg_assistant",
                1760000102000,
                {
                    "type": "tool",
                    "tool": "read",
                    "callID": "call_read_browser",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "app/main.py"},
                        "output": "FastAPI route output",
                        "title": "Read app/main.py",
                    },
                },
            ),
            (
                "oc_task",
                "oc_msg_assistant",
                1760000102400,
                {
                    "type": "tool",
                    "tool": "task",
                    "callID": "call_task_browser",
                    "state": {
                        "status": "completed",
                        "input": {"description": "OpenCode child browser review"},
                        "output": "child complete",
                        "title": "Run reviewer",
                    },
                },
            ),
            (
                "oc_patch",
                "oc_msg_assistant",
                1760000103000,
                {"type": "patch", "patch": "--- a/app/main.py\n+++ b/app/main.py\n@@\n+OpenCode support"},
            ),
            (
                "oc_file",
                "oc_msg_assistant",
                1760000104000,
                {"type": "file", "path": "app/main.py", "content": "from fastapi import FastAPI"},
            ),
            ("oc_compaction", "oc_msg_assistant", 1760000105000, {"type": "compaction", "summary": "Compacted OpenCode context"}),
            ("oc_step_start", "oc_msg_assistant", 1760000106000, {"type": "step-start", "title": "OpenCode parse"}),
            ("oc_step_finish", "oc_msg_assistant", 1760000107000, {"type": "step-finish", "title": "OpenCode parse", "status": "completed"}),
            ("oc_child_text", "oc_msg_child", 1760000103100, {"type": "text", "text": "OpenCode child browser transcript"}),
        ]
        connection.executemany(
            "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
            [(pid, mid, session_id, created, created, json.dumps(data)) for pid, mid, created, data in parts],
        )
        connection.commit()
        return session_id
    finally:
        connection.close()


def start_server(projects_dir: Path, port: int, opencode_data_dir: Path | None = None) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["CLAUDE_PROJECTS_DIR"] = str(projects_dir)
    if opencode_data_dir is not None:
        env["OPENCODE_DATA_DIR"] = str(opencode_data_dir)
    return subprocess.Popen(
        ["uv", "run", "python", "-m", "app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def wait_for_server(base_url: str) -> None:
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if httpx.get(f"{base_url}/api/sessions", timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"server did not start: {base_url}")


def launch_verified_browser(playwright):
    try:
        browser = playwright.chromium.launch(channel="chrome")
        return browser, "chrome"
    except Exception:
        browser = playwright.chromium.launch()
        return browser, "chromium"


def assert_no_horizontal_overflow(page: Page) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1")
    assert not overflow, "page has horizontal document overflow"


def assert_interactive_dom_health(page: Page) -> None:
    issues = page.evaluate(
        """() => {
            const visible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const accessibleName = (element) => (
                element.getAttribute('aria-label') ||
                element.innerText ||
                element.value ||
                element.getAttribute('placeholder') ||
                element.getAttribute('title') ||
                ''
            ).replace(/\\s+/g, ' ').trim();
            const selector = (element) => {
                if (element.id) return `#${element.id}`;
                if (element.dataset?.action) return `[data-action="${element.dataset.action}"]`;
                if (element.dataset?.testid) return `[data-testid="${element.dataset.testid}"]`;
                return element.tagName.toLowerCase();
            };
            const issues = [];
            const ids = new Map();
            document.querySelectorAll('[id]').forEach((element) => {
                ids.set(element.id, (ids.get(element.id) || 0) + 1);
            });
            ids.forEach((count, id) => {
                if (count > 1) issues.push(`duplicate id #${id}`);
            });
            document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], [role="option"], [role="separator"][tabindex], [tabindex]:not([tabindex="-1"])').forEach((element) => {
                if (!visible(element)) return;
                const rect = element.getBoundingClientRect();
                if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width < 1 || rect.height < 1) {
                    issues.push(`invalid box ${selector(element)}`);
                }
                if (!accessibleName(element)) {
                    issues.push(`missing accessible name ${selector(element)}`);
                }
                if (element.matches('button') && !element.matches('.timeline-block') && element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible') {
                    issues.push(`button text overflows ${selector(element)}`);
                }
            });
            return issues;
        }"""
    )
    assert not issues, "interactive DOM health issues:\n" + "\n".join(issues)


def focus_layout_metrics(page: Page) -> dict[str, float]:
    metrics = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.layoutMetrics()")
    assert metrics and metrics["layoutWidth"] > 0, metrics
    tolerance = max(2.0, metrics["layoutWidth"] * 0.001)
    expected_max = metrics["layoutWidth"] * metrics["goldenSection"]
    expected_min = metrics["layoutWidth"] * metrics["goldenRemainder"]
    expected_stream_width = min(metrics["mainMaxWidth"], metrics["mainContentWidth"])
    expected_left = metrics["mainContentLeft"] + (metrics["mainContentWidth"] - expected_stream_width) / 2
    assert abs(metrics["mainMaxWidth"] - expected_max) <= tolerance, metrics
    assert abs(metrics["mainMinWidth"] - expected_min) <= tolerance, metrics
    assert abs(metrics["mainStreamWidth"] - expected_stream_width) <= tolerance, metrics
    assert abs(metrics["mainStreamExpectedWidth"] - expected_stream_width) <= tolerance, metrics
    assert abs(metrics["mainStreamLeft"] - expected_left) <= tolerance, metrics
    assert abs(metrics["mainStreamCenterDelta"]) <= tolerance, metrics
    assert not metrics["mainStreamClippedLeft"], metrics
    assert not metrics["mainStreamClippedRight"], metrics
    if metrics["openPanelCount"] > 0 and metrics["rackWidth"] > 0:
        assert metrics["mainContentWidth"] + tolerance >= metrics["mainMinWidth"], metrics
        assert metrics["rackFlexDirection"] == "row-reverse", metrics
    return metrics


def assert_timeline_detail_top_right(page: Page, expected_count: int | None = None) -> dict[str, Any]:
    placement = page.evaluate(
        """() => {
            const dock = document.querySelector('[data-testid="timeline-detail-dock"]');
            const viewport = document.querySelector('[data-testid="overview-timeline"]');
            const windows = Array.from(document.querySelectorAll('[data-testid="timeline-detail-panel"]'));
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            const dockRect = dock ? rect(dock) : null;
            const viewportRect = viewport ? rect(viewport) : null;
            const windowRects = windows.map(rect);
            const dockStyles = dock ? getComputedStyle(dock) : null;
            const dockPaddingRight = dockStyles ? Number.parseFloat(dockStyles.paddingRight) || 0 : 0;
            const dockPaddingBottom = dockStyles ? Number.parseFloat(dockStyles.paddingBottom) || 0 : 0;
            const dockTopOffset = dockStyles ? Number.parseFloat(dockStyles.getPropertyValue('--timeline-detail-top-offset')) || 0 : 0;
            const timelineLabelBottom = Math.max(
                ...Array.from(document.querySelectorAll('[data-testid="timeline-track-label"]')).map((node) => rect(node).bottom)
            );
            return {
                visible: Boolean(dock && !dock.classList.contains('hidden') && windows.length),
                count: windows.length,
                dock: dockRect,
                viewport: viewportRect,
                windows: windowRects,
                dockPaddingRight,
                dockPaddingBottom,
                dockTopOffset,
                firstAnchoredRight: dockRect && windowRects[0] ? Math.abs(windowRects[0].right - (dockRect.right - dockPaddingRight)) : null,
                topDelta: dockRect && viewportRect ? Math.abs(dockRect.top - (viewportRect.top + dockTopOffset)) : null,
                timelineHeaderClearance: dockRect ? dockRect.top - timelineLabelBottom : null,
                dockRightDelta: dockRect && viewportRect ? Math.abs(dockRect.right - viewportRect.right) : null,
                windowRightDelta: windowRects[0] && viewportRect ? Math.abs(windowRects[0].right - (viewportRect.right - 24)) : null,
                shadowBleedRight: dockRect && windowRects[0] ? dockRect.right - windowRects[0].right : null,
                shadowBleedBottom: dockRect && windowRects[0] ? dockRect.bottom - windowRects[0].bottom : null,
                secondIsLeftOfFirst: windowRects.length < 2 ? true : windowRects[1].right <= windowRects[0].left + 1,
                secondSameRow: windowRects.length < 2 ? true : Math.abs(windowRects[1].top - windowRects[0].top) <= 1.5,
            };
        }"""
    )
    assert placement["visible"], placement
    if expected_count is not None:
        assert placement["count"] == expected_count, placement
    assert placement["topDelta"] <= 3, placement
    assert placement["timelineHeaderClearance"] >= 12, placement
    assert placement["dockRightDelta"] >= 80, placement
    assert placement["windowRightDelta"] <= 3, placement
    assert placement["firstAnchoredRight"] <= 3, placement
    assert placement["shadowBleedRight"] >= 80, placement
    assert placement["shadowBleedBottom"] >= 80, placement
    assert placement["secondIsLeftOfFirst"], placement
    if placement["count"] == 2:
        assert placement["secondSameRow"], placement
    return placement


def assert_agent_sidebar_inserted(page: Page) -> dict[str, Any]:
    geometry = page.evaluate(
        """() => {
            const workbench = document.querySelector('[data-testid="conversation-workbench"]');
            const drawer = document.querySelector('[data-testid="agent-tree-drawer"]');
            const rail = document.querySelector('.left-rail');
            const transcript = document.querySelector('[data-testid="transcript-root"]');
            const firstMessageItem = document.querySelector('[data-testid="message-index"] .message-index-item');
            const firstToggle = document.querySelector('[data-testid="subagent-toggle"]');
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            return {
                workbenchState: workbench?.dataset.agentTreeOpen || '',
                drawerVisible: Boolean(drawer && !drawer.classList.contains('hidden')),
                drawerPosition: drawer ? getComputedStyle(drawer).position : '',
                drawer: drawer ? rect(drawer) : null,
                rail: rail ? rect(rail) : null,
                transcript: transcript ? rect(transcript) : null,
                navFontSize: firstMessageItem ? getComputedStyle(firstMessageItem).fontSize : '',
                previewFontSize: firstMessageItem?.querySelector('.message-preview')
                    ? getComputedStyle(firstMessageItem.querySelector('.message-preview')).fontSize
                    : '',
                toggleText: firstToggle?.innerText.trim() || '',
                toggleIconCount: firstToggle?.querySelectorAll('.agent-tree-pin-icon').length || 0,
                toggleWidth: firstToggle ? rect(firstToggle).width : 0,
            };
        }"""
    )
    assert geometry["workbenchState"] == "true", geometry
    assert geometry["drawerVisible"], geometry
    assert geometry["drawerPosition"] != "fixed", geometry
    assert geometry["drawer"]["left"] <= 1, geometry
    assert abs(geometry["drawer"]["right"] - geometry["rail"]["left"]) <= 2, geometry
    assert abs(geometry["rail"]["right"] - geometry["transcript"]["left"]) <= 2, geometry
    assert abs(geometry["drawer"]["top"] - geometry["rail"]["top"]) <= 2, geometry
    assert geometry["navFontSize"] == "12px", geometry
    assert geometry["previewFontSize"] == "12px", geometry
    assert geometry["toggleText"] == "", geometry
    assert geometry["toggleIconCount"] == 1, geometry
    assert geometry["toggleWidth"] <= 34, geometry
    return geometry


def assert_message_index_item_presentation(page: Page, require_problem: bool = False) -> dict[str, Any]:
    presentation = page.evaluate(
        """() => {
            const first = document.querySelector('[data-testid="message-index"] .message-index-item');
            const time = first?.querySelector('.message-index-time');
            const problemItem = document.querySelector('[data-testid="message-index"] .message-index-item.has-problem');
            const problem = problemItem?.querySelector('.message-index-problem');
            const dot = problem?.querySelector('.message-index-problem-dot');
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            return {
                first: first ? rect(first) : null,
                time: time ? rect(time) : null,
                timeTextAlign: time ? getComputedStyle(time).textAlign : '',
                timeJustifySelf: time ? getComputedStyle(time).justifySelf : '',
                timeRightGap: first && time ? first.getBoundingClientRect().right - time.getBoundingClientRect().right : null,
                problemExists: Boolean(problem),
                problemText: problem?.innerText.trim() || '',
                problemColor: problem ? getComputedStyle(problem).color : '',
                problemDotWidth: dot ? rect(dot).width : 0,
                problemDotColor: dot ? getComputedStyle(dot).backgroundColor : '',
                problemBoxShadow: problemItem ? getComputedStyle(problemItem).boxShadow : '',
            };
        }"""
    )
    assert presentation["first"] and presentation["time"], presentation
    assert presentation["timeTextAlign"] == "right", presentation
    assert presentation["timeJustifySelf"] == "end", presentation
    assert 0 <= presentation["timeRightGap"] <= 12, presentation
    if require_problem:
        assert presentation["problemExists"], presentation
    if presentation["problemExists"]:
        assert "problem" in presentation["problemText"], presentation
        assert presentation["problemDotWidth"] >= 5, presentation
        assert presentation["problemBoxShadow"] == "none", presentation
    return presentation


def select_problem_track_from_agent_sidebar(page: Page) -> dict[str, Any]:
    result = page.evaluate(
        """() => {
            const capsule = window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0 && !item.rawOnly);
            if (!capsule) return { clicked: false, reason: 'no-problem-capsule' };
            const selector = `[data-action="select-track"][data-track-id="${CSS.escape(capsule.trackId)}"]`;
            const button = document.querySelector(selector);
            if (!button) return { clicked: false, reason: 'missing-track-button', trackId: capsule.trackId };
            button.click();
            return {
                clicked: true,
                trackId: capsule.trackId,
                capsuleKey: capsule.key,
                problemCount: capsule.problemCount,
            };
        }"""
    )
    assert result["clicked"], result
    page.wait_for_timeout(180)
    return result


def dashboard_url(base_url: str, **params: str) -> str:
    query = urlencode({key: value for key, value in params.items() if value})
    return f"{base_url}?{query}" if query else base_url


def validate_dashboard(
    page: Page,
    base_url: str,
    *,
    projects_dir: Path,
    opencode_data_dir: Path,
    viewport: str = "setup",
    screenshot_dir: Path | None = None,
) -> None:
    page.goto(dashboard_url(base_url, claude_home=str(projects_dir), opencode_data_dir=str(opencode_data_dir)))
    expect(page.get_by_role("heading", name="Session Viewer")).to_be_visible()
    expect(page.get_by_test_id("tab-claude")).to_be_visible()
    expect(page.get_by_test_id("tab-opencode")).to_be_visible()
    expect(page.get_by_test_id("tab-claude")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_test_id("claude-panel")).to_be_visible()
    expect(page.get_by_test_id("opencode-panel")).to_be_hidden()
    expect(page.get_by_test_id("session-search")).to_be_visible()
    expect(page.get_by_test_id("directory-filter")).to_be_visible()
    expect(page.get_by_test_id("claude-source-path")).to_have_value(str(projects_dir))
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    record(
        page,
        "dashboard.tabs",
        kind="dom_assertion",
        flow="dashboard.initial_tabs",
        viewport=viewport,
        selector="[data-testid='tab-claude'], [data-testid='tab-opencode']",
        assertion="Claude and OpenCode tabs are visible and Claude is active by default",
    )
    record(
        page,
        "source.claude_config",
        kind="dom_assertion",
        flow="dashboard.claude_source",
        viewport=viewport,
        selector="[data-testid='claude-source-path']",
        assertion="Claude source path accepts the direct projects directory fixture and lists Claude sessions",
    )

    page.get_by_test_id("session-search").fill("stress")
    page.get_by_test_id("directory-filter").fill("/tmp/project")
    page.get_by_test_id("claude-search-button").click()
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    assert "claude_q=stress" in page.url, page.url
    assert "claude_directory=%2Ftmp%2Fproject" in page.url, page.url
    record(
        page,
        "ui.no_conversation_search",
        kind="interaction",
        flow="dashboard.search_retained",
        viewport=viewport,
        selector="[data-testid='session-search']",
        assertion="dashboard search input and submit button filter and preserve session results",
    )

    page.get_by_test_id("tab-opencode").click()
    expect(page.get_by_test_id("tab-opencode")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_test_id("opencode-panel")).to_be_visible()
    expect(page.get_by_test_id("claude-panel")).to_be_hidden()
    expect(page.get_by_test_id("opencode-source-path")).to_have_value(str(opencode_data_dir))
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    expect(page.get_by_text("OpenCode browser smoke")).to_be_visible()
    record(
        page,
        "dashboard.tabs",
        kind="interaction",
        flow="dashboard.switch_to_opencode",
        viewport=viewport,
        selector="[data-testid='tab-opencode']",
        assertion="switching to the OpenCode tab shows OpenCode sessions and hides the Claude panel",
    )
    record(
        page,
        "source.opencode_data",
        kind="dom_assertion",
        flow="dashboard.opencode_source",
        viewport=viewport,
        selector="[data-testid='opencode-source-path']",
        assertion="OpenCode source path points at a directory containing opencode.db and lists OpenCode sessions",
    )

    page.get_by_test_id("opencode-session-search").fill("browser")
    page.get_by_test_id("opencode-directory-filter").fill("opencode-project")
    page.get_by_test_id("opencode-search-button").click()
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    assert "opencode_q=browser" in page.url, page.url
    assert "claude_q=stress" in page.url, page.url
    record(
        page,
        "dashboard.independent_controls",
        kind="interaction",
        flow="dashboard.independent_search",
        viewport=viewport,
        selector="[data-testid='opencode-session-search']",
        assertion="OpenCode search submission preserves Claude query parameters and scopes results to the active tab",
    )

    page.reload(wait_until="networkidle")
    expect(page.get_by_test_id("opencode-source-path")).to_have_value(str(opencode_data_dir))
    storage_keys = page.evaluate("Object.keys(localStorage).filter((key) => key.toLowerCase().includes('source') || key.toLowerCase().includes('opencode') || key.toLowerCase().includes('claude'))")
    assert storage_keys == [], storage_keys
    record(
        page,
        "source.url_scoped",
        kind="dom_assertion",
        flow="dashboard.url_scoped_sources",
        viewport=viewport,
        selector="location.href",
        assertion="source values survive reload through URL parameters and do not create source-specific localStorage keys",
    )

    page.goto(dashboard_url(base_url, tab="opencode", opencode_data_dir=str(opencode_data_dir / "missing")))
    expect(page.get_by_test_id("source-empty-state")).to_be_visible()
    expect(page.get_by_text("No readable OpenCode database")).to_be_visible()
    page.goto(dashboard_url(base_url, tab="claude", claude_home=str(projects_dir / "missing")))
    expect(page.get_by_test_id("source-empty-state")).to_be_visible()
    expect(page.get_by_text("No readable Claude projects directory")).to_be_visible()
    record(
        page,
        "source.invalid_state",
        kind="dom_assertion",
        flow="dashboard.invalid_sources",
        viewport=viewport,
        selector="[data-testid='source-empty-state']",
        assertion="invalid Claude and OpenCode source paths render explicit empty states without using default fallbacks",
    )

    if viewport == "studio-native" and screenshot_dir is not None:
        page.goto(dashboard_url(base_url, claude_home=str(projects_dir), opencode_data_dir=str(opencode_data_dir)), wait_until="networkidle")
        assert_no_horizontal_overflow(page)
        screenshot = screenshot_dir / "studio-native-dashboard.png"
        page.screenshot(path=screenshot, full_page=False)
        assert screenshot.stat().st_size > 1000
        record(
            page,
            "audit.studio_native",
            kind="screenshot",
            flow="dashboard.studio_native_screenshot",
            viewport=viewport,
            selector="screenshot",
            assertion="dashboard screenshot captured at Studio Display native viewport",
            artifact=str(screenshot),
        )
        record(
            page,
            "audit.studio_native",
            kind="geometry",
            flow="dashboard.studio_native_geometry",
            viewport=viewport,
            selector="document",
            assertion="dashboard has no document-level horizontal overflow at Studio Display native viewport",
        )


def validate_opencode_conversation(
    page: Page,
    url: str,
    *,
    viewport: str,
    screenshot_dir: Path,
) -> None:
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("conversation-workbench")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible()
    assert page.get_by_test_id("timeline-block").count() > 0
    back_href = page.locator(".back-link").get_attribute("href") or ""
    assert "tab=opencode" in back_href and "opencode_data_dir=" in back_href, back_href
    assert_no_horizontal_overflow(page)
    record(
        page,
        "conversation.shared_layout",
        kind="dom_assertion",
        flow="opencode.timeline_shared_workbench",
        viewport=viewport,
        selector="[data-testid='conversation-workbench']",
        assertion="OpenCode conversation opens in the same Timeline workbench used by Claude sessions",
    )
    record(
        page,
        "nav.deep_links_back",
        kind="interaction",
        flow="opencode.source_scoped_back_link",
        viewport=viewport,
        selector=".back-link",
        assertion="OpenCode conversation Sessions link preserves tab and data-dir query parameters",
    )

    page.locator("#readerLayoutBtn").click()
    expect(page.get_by_test_id("reader-layout")).to_be_visible()
    expect(page.locator(".reader-part .part-text", has_text="OpenCode browser smoke prompt").first).to_be_visible()
    expect(page.get_by_test_id("tool-call").first).to_be_visible()
    expect(page.get_by_test_id("tool-result").first).to_be_visible()
    labels = page.locator(".reader-part .part-header strong").all_inner_texts()
    normalized = {label.strip().lower() for label in labels}
    expected_labels = {
        "reasoning",
        "read",
        "tool result",
        "patch",
        "file",
        "compaction",
        "step start",
        "step finish",
    }
    assert expected_labels <= normalized, normalized
    opencode_tool_fields = page.evaluate(
        """() => Array.from(document.querySelectorAll('.reader-part.tool .tool-payload-field dt'))
            .map((item) => item.innerText.trim())"""
    )
    assert "File Path" in opencode_tool_fields, opencode_tool_fields
    record(
        page,
        "opencode.readable_transcript",
        kind="dom_assertion",
        flow="opencode.waterfall_parts",
        viewport=viewport,
        selector=".reader-part",
        assertion="OpenCode text, reasoning, structured read tool fields, result, patch, file, compaction, and step parts render with readable labels",
    )

    page.locator("#graphLayoutBtn").click()
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible()
    page.get_by_test_id("timeline-block").first.click()
    expect(page.get_by_test_id("timeline-detail-panel")).to_be_visible()
    record(
        page,
        "opencode.readable_transcript",
        kind="interaction",
        flow="opencode.timeline_detail",
        viewport=viewport,
        selector="[data-testid='timeline-block']",
        assertion="OpenCode timeline blocks open the shared detail panel for the same normalized messages",
    )

    page.locator("#readerLayoutBtn").click()
    expect(page.get_by_test_id("reader-layout")).to_be_visible()
    page.locator("#agentPaneToggle").click()
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
    assert page.get_by_test_id("subagent-toggle").count() >= 1
    page.get_by_test_id("subagent-toggle").first.click()
    expect(page.locator(".subagent-panel")).to_have_count(1)
    expect(page.locator(".subagent-panel")).to_contain_text("OpenCode browser child")
    record(
        page,
        "opencode.readable_transcript",
        kind="interaction",
        flow="opencode.subagent_panel",
        viewport=viewport,
        selector="[data-testid='subagent-toggle']",
        assertion="OpenCode child sessions linked by parent_id appear in the Agents drawer and open as subagent panels",
    )

    if viewport == "studio-native":
        screenshot = screenshot_dir / "studio-native-opencode-conversation.png"
        page.screenshot(path=screenshot, full_page=False)
        assert screenshot.stat().st_size > 1000


def validate_reader(page: Page, url: str, viewport: str, screenshot_dir: Path) -> None:
    page.goto(f"{url}?layout=waterfall", wait_until="networkidle")
    expect(page.get_by_test_id("reader-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_hidden()
    expect(page.locator("button", has_text="Inspect")).to_have_count(0)
    expect(page.locator("[data-action='raw']")).to_have_count(0)
    expect(page.locator("[data-open-inspector]")).to_have_count(0)
    expect(page.locator("[data-testid='transcript-filter']")).to_have_count(0)
    expect(page.locator("[data-testid='problem-list']")).to_have_count(0)
    expect(page.locator("#prevElementBtn")).to_have_count(0)
    expect(page.locator("#nextElementBtn")).to_have_count(0)
    expect(page.locator("#firstProblemBtn")).to_have_count(0)
    expect(page.locator("#timestampJumpInput")).to_have_count(0)
    expect(page.locator("#timestampJumpBtn")).to_have_count(0)
    expect(page.locator("#readerLayoutBtn")).to_contain_text("Waterfall")
    expect(page.locator("#graphLayoutBtn")).to_contain_text("Timeline")
    expect(page.locator("#modeToggleBtn")).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_have_text("Backward")
    expect(page.locator("#returnElementBtn")).to_have_attribute("aria-label", "Backward to previous transcript element")
    expect(page.locator("#forwardElementBtn")).to_have_text("Forward")
    expect(page.locator(".header-source")).to_have_text("/tmp/project")
    expect(page.get_by_test_id("branch-chip")).to_contain_text("main")
    expect(page.get_by_test_id("breadcrumb")).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_be_disabled()
    expect(page.locator("#forwardElementBtn")).to_be_disabled()
    expect(page.locator("#messageNavTab")).to_have_count(0)
    expect(page.locator("#agentTreeTab")).to_have_count(0)
    expect(page.get_by_test_id("agent-filter")).to_have_count(0)
    expect(page.get_by_test_id("selected-agent-strip")).to_have_count(0)
    expect(page.locator(".selected-agent-chip")).to_have_count(0)
    expect(page.get_by_test_id("left-pane-header")).to_be_visible()
    expect(page.locator("#agentPaneToggle")).to_be_visible()
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
    expect(page.get_by_test_id("message-index")).to_be_visible()
    assert_message_index_item_presentation(page)
    expect(page.get_by_test_id("flow-summary")).to_have_count(0)
    expect(page.locator("#sessionInfoButton")).to_be_visible()
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    page.locator("#sessionInfoButton").click()
    expect(page.locator("#sessionInfoPopover")).to_be_visible()
    summary_text = page.locator("#sessionInfoPopover").inner_text()
    assert "Sessions" in summary_text and "Problem events" in summary_text, summary_text
    title_geometry = page.evaluate(
        """() => {
            const header = document.querySelector('[data-testid="command-bar"]').getBoundingClientRect();
            const title = document.querySelector('.session-heading h1').getBoundingClientRect();
            const info = document.querySelector('#sessionInfoButton').getBoundingClientRect();
            const meta = document.querySelector('.header-meta-line').getBoundingClientRect();
            const headerStyle = getComputedStyle(document.querySelector('[data-testid="command-bar"]'));
            return {
                titleCenterDelta: title.left + title.width / 2 - (header.left + header.width / 2),
                infoAfterTitle: info.left >= title.right,
                infoGap: info.left - title.right,
                titleMetaGap: meta.top - title.bottom,
                headerRowGap: Number.parseFloat(headerStyle.rowGap) || 0,
            };
        }"""
    )
    assert abs(title_geometry["titleCenterDelta"]) <= 2, title_geometry
    assert title_geometry["infoAfterTitle"], title_geometry
    assert 0 <= title_geometry["infoGap"] <= 8, title_geometry
    if viewport != "mobile":
        assert title_geometry["headerRowGap"] >= 12, title_geometry
        assert title_geometry["titleMetaGap"] >= 10, title_geometry
        header_button_geometry = page.evaluate(
            """() => {
                const header = document.querySelector('[data-testid="command-bar"]').getBoundingClientRect();
                const selectors = {
                    sessions: '.back-link',
                    backward: '#returnElementBtn',
                    forward: '#forwardElementBtn',
                    timeline: '#graphLayoutBtn',
                    waterfall: '#readerLayoutBtn',
                    copyLink: '#copyLinkBtn',
                };
                const headerCenterY = header.top + header.height / 2;
                const centers = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
                    const rect = document.querySelector(selector).getBoundingClientRect();
                    return [name, rect.top + rect.height / 2];
                }));
                const values = Object.values(centers);
                return {
                    headerCenterY,
                    centers,
                    deltas: Object.fromEntries(Object.entries(centers).map(([name, center]) => [name, center - headerCenterY])),
                    maxButtonCenterSpread: Math.max(...values) - Math.min(...values),
                    maxHeaderCenterDelta: Math.max(...values.map((center) => Math.abs(center - headerCenterY))),
                };
            }"""
        )
        assert header_button_geometry["maxButtonCenterSpread"] <= 2.5, header_button_geometry
        assert header_button_geometry["maxHeaderCenterDelta"] <= 4, header_button_geometry
        record(
            page,
            "ui.top_navigation",
            kind="geometry",
            flow="top_nav.header_geometry",
            viewport=viewport,
            selector="[data-testid='command-bar']",
            assertion=(
                "Sessions, Backward, Forward, Timeline, Waterfall, and Copy link controls "
                f"share a header center line within {header_button_geometry['maxButtonCenterSpread']:.1f}px; "
                f"title/project gap is {title_geometry['titleMetaGap']:.1f}px with "
                f"{title_geometry['headerRowGap']:.1f}px grid row gap"
            ),
        )
    page.keyboard.press("Escape")
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    expect(page.get_by_text("Open raw JSON for the full payload.")).to_have_count(0)
    waterfall_kind_detail = page.evaluate(
        """() => {
            const cards = Array.from(document.querySelectorAll('.reader-message'));
            const cardKinds = cards.map((card) => ({
                line: card.dataset.lineKind || '',
                content: (card.dataset.contentKinds || '').split(',').filter(Boolean),
                headerText: card.querySelector('.message-header')?.innerText.replace(/\\s+/g, ' ').trim() || '',
                titleBarContent: (card.querySelector('.message-kind-stack')?.dataset.contentKinds || '').split(',').filter(Boolean),
            }));
            const titleStacks = cards.map((card) => {
                const stack = card.querySelector('.message-kind-stack');
                const lineBadge = stack?.querySelector('.message-line-kind');
                const contentBadges = Array.from(stack?.querySelectorAll('.message-content-kind') || []);
                const badgeStyle = (node) => {
                    const style = node ? getComputedStyle(node) : null;
                    return style ? {
                        borderRadius: style.borderTopLeftRadius,
                        borderWidth: style.borderTopWidth,
                        fontSize: style.fontSize,
                        fontWeight: style.fontWeight,
                        lineHeight: style.lineHeight,
                        paddingTop: style.paddingTop,
                        textTransform: style.textTransform,
                    } : {};
                };
                return {
                    line: card.dataset.lineKind || '',
                    content: (card.dataset.contentKinds || '').split(',').filter(Boolean),
                    titleBarContent: contentBadges.map((badge) => badge.textContent.trim()),
                    lineStyle: badgeStyle(lineBadge),
                    contentStyles: contentBadges.map(badgeStyle),
                };
            });
            const styleKeys = ['borderRadius', 'borderWidth', 'fontSize', 'fontWeight', 'lineHeight', 'paddingTop', 'textTransform'];
            const titleBarBadgeStylesMatch = titleStacks.every((item) => item.contentStyles.every((style) => (
                styleKeys.every((key) => item.lineStyle[key] === style[key])
            )));
            const titleBarBadgesUseOriginalShape = titleStacks.every((item) => (
                item.lineStyle.borderRadius === '4px'
                && item.lineStyle.borderWidth === '0px'
                && item.contentStyles.every((style) => style.borderRadius === '4px' && style.borderWidth === '0px')
            ));
            const attachmentSubtypes = [...new Set(cardKinds
                .filter((item) => item.line === 'attachment')
                .flatMap((item) => item.content))];
            const toolPre = document.querySelector('.reader-part.tool pre');
            const toolResultPre = document.querySelector('.reader-part.tool-result pre');
            const normalText = document.querySelector('.reader-part .part-text');
            const toolFieldLabels = Array.from(document.querySelectorAll('.reader-part.tool .tool-payload-field dt'))
                .map((item) => item.innerText.trim());
            const fontSize = (node) => node ? Number.parseFloat(getComputedStyle(node).fontSize) || 0 : 0;
            const lineHeight = (node) => node ? Number.parseFloat(getComputedStyle(node).lineHeight) || 0 : 0;
            const headerOverflowCount = Array.from(document.querySelectorAll('.reader-message .message-header'))
                .filter((node) => node.scrollWidth > node.clientWidth + 2).length;
            return {
                cardKinds: cardKinds.slice(0, 80),
                titleStacks: titleStacks.slice(0, 80),
                attachmentSubtypes,
                hasUserText: cardKinds.some((item) => item.line === 'user' && item.content.includes('message')),
                hasUserToolResult: cardKinds.some((item) => item.line === 'user' && item.content.includes('tool result')),
                hasAssistantText: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('message')),
                hasAssistantReasoning: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('reasoning')),
                hasAssistantToolCall: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('tool call')),
                hasAttachmentHookSuccess: cardKinds.some((item) => item.line === 'attachment' && item.content.includes('Hook Success')),
                userTitleBarsUseMessage: titleStacks
                    .filter((item) => item.line === 'user')
                    .every((item) => item.titleBarContent.length === 1 && item.titleBarContent[0] === 'message'),
                assistantTextTitleBarsUseMessage: titleStacks
                    .filter((item) => item.line === 'assistant' && item.content.includes('message'))
                    .every((item) => item.titleBarContent.includes('message')),
                attachmentTitleBarsKeepSubtypes: titleStacks
                    .filter((item) => item.line === 'attachment')
                    .some((item) => item.titleBarContent.includes('Deferred Tools Delta')),
                titleBarBadgeStylesMatch,
                titleBarBadgesUseOriginalShape,
                rawButtonCount: document.querySelectorAll('.reader-message .message-raw-button').length,
                cardCount: cards.length,
                toolFieldLabels,
                toolPreFontSize: fontSize(toolPre),
                toolResultPreFontSize: fontSize(toolResultPre),
                normalTextFontSize: fontSize(normalText),
                toolPreLineHeight: lineHeight(toolPre),
                headerOverflowCount,
            };
        }"""
    )
    assert waterfall_kind_detail["hasUserText"], waterfall_kind_detail
    assert waterfall_kind_detail["hasUserToolResult"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantText"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantReasoning"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantToolCall"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAttachmentHookSuccess"], waterfall_kind_detail
    assert waterfall_kind_detail["userTitleBarsUseMessage"], waterfall_kind_detail
    assert waterfall_kind_detail["assistantTextTitleBarsUseMessage"], waterfall_kind_detail
    assert waterfall_kind_detail["attachmentTitleBarsKeepSubtypes"], waterfall_kind_detail
    assert waterfall_kind_detail["titleBarBadgeStylesMatch"], waterfall_kind_detail
    assert waterfall_kind_detail["titleBarBadgesUseOriginalShape"], waterfall_kind_detail
    assert waterfall_kind_detail["rawButtonCount"] == waterfall_kind_detail["cardCount"], waterfall_kind_detail
    assert {"Command", "Description", "Subagent Type"} <= set(waterfall_kind_detail["toolFieldLabels"]), waterfall_kind_detail
    assert len(waterfall_kind_detail["attachmentSubtypes"]) >= len(EXPECTED_ATTACHMENT_TYPES), waterfall_kind_detail
    assert waterfall_kind_detail["toolPreFontSize"] == 11, waterfall_kind_detail
    assert waterfall_kind_detail["toolResultPreFontSize"] == 11, waterfall_kind_detail
    assert waterfall_kind_detail["normalTextFontSize"] > waterfall_kind_detail["toolPreFontSize"], waterfall_kind_detail
    assert waterfall_kind_detail["toolPreLineHeight"] > waterfall_kind_detail["toolPreFontSize"], waterfall_kind_detail
    assert waterfall_kind_detail["headerOverflowCount"] == 0, waterfall_kind_detail
    page.locator(".reader-message .message-raw-button").first.click()
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
    expect(page.get_by_test_id("timeline-detail-panel")).to_be_visible()
    reader_raw_popup = page.evaluate(
        """() => {
            const panel = document.querySelector('[data-testid="timeline-detail-panel"]');
            const rawPanel = panel?.querySelector('[data-detail-panel="raw"]');
            return {
                mode: panel?.dataset.detailMode || '',
                selectedTab: panel?.dataset.detailTab || '',
                title: panel?.querySelector('.timeline-detail-titlebar strong')?.innerText.trim() || '',
                rawSelected: panel?.querySelector('[data-detail-tab-target="raw"]')?.getAttribute('aria-selected') || '',
                rawHidden: rawPanel?.hidden ?? true,
                contentsHidden: panel?.querySelector('[data-detail-panel="contents"]')?.hidden ?? false,
                rawText: rawPanel?.querySelector('pre code')?.innerText || '',
            };
        }"""
    )
    assert reader_raw_popup["mode"] == "reader-raw", reader_raw_popup
    assert reader_raw_popup["selectedTab"] == "raw", reader_raw_popup
    assert reader_raw_popup["title"] == "Raw JSON", reader_raw_popup
    assert reader_raw_popup["rawSelected"] == "true", reader_raw_popup
    assert reader_raw_popup["rawHidden"] is False and reader_raw_popup["contentsHidden"] is True, reader_raw_popup
    assert '"type": "user"' in reader_raw_popup["rawText"], reader_raw_popup
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    attachment = page.locator(".reader-part.attachment").first
    expect(attachment).to_be_visible()
    reader_attachment_detail = page.evaluate(
        """() => {
            const attachments = Array.from(document.querySelectorAll('.reader-part.attachment .attachment-event'));
            const sectionLabels = Array.from(document.querySelectorAll('.reader-part.attachment .attachment-section header strong'))
                .map((item) => item.innerText.trim());
            const disallowedSectionLabels = new Set(['Output', 'Standard Output', 'Standard Error', 'Context Preview']);
            return {
                types: attachments.map((item) => item.dataset.attachmentType || ''),
                badges: attachments.map((item) => item.querySelector('.attachment-type-badge')?.innerText.trim() || ''),
                titleCount: attachments.filter((item) => item.querySelector('.attachment-display-heading strong')).length,
                sectionCount: attachments.filter((item) => item.querySelector('.attachment-section')).length,
                semanticContentCount: attachments.filter((item) => item.querySelector('.attachment-section, .attachment-meta dd')).length,
                sectionLabels,
                disallowedLabels: sectionLabels.filter((label) => disallowedSectionLabels.has(label)),
                nonHumanLabels: sectionLabels.filter((label) => /_|[a-z][A-Z]/.test(label)),
                stdoutBodyCount: Array.from(document.querySelectorAll('.reader-part.attachment .attachment-section pre'))
                    .filter((item) => /hookSpecificOutput|"stdout"|standard output:/i.test(item.innerText)).length,
            };
        }"""
    )
    assert EXPECTED_ATTACHMENT_TYPES <= set(reader_attachment_detail["types"]), reader_attachment_detail
    assert EXPECTED_ATTACHMENT_BADGES <= set(reader_attachment_detail["badges"]), reader_attachment_detail
    assert reader_attachment_detail["titleCount"] >= len(EXPECTED_ATTACHMENT_TYPES), reader_attachment_detail
    assert reader_attachment_detail["semanticContentCount"] >= len(EXPECTED_ATTACHMENT_TYPES), reader_attachment_detail
    assert reader_attachment_detail["disallowedLabels"] == [], reader_attachment_detail
    assert reader_attachment_detail["nonHumanLabels"] == [], reader_attachment_detail
    assert reader_attachment_detail["stdoutBodyCount"] == 0, reader_attachment_detail
    hook_attachment = page.locator(".reader-part.attachment [data-attachment-type='hook_success']").first.locator("xpath=ancestor::section[contains(@class, 'reader-part')][1]")
    expect(hook_attachment.locator(".attachment-summary")).to_contain_text("SessionStart hook added execution context")
    additional_context_section = hook_attachment.locator(".attachment-section", has_text="Additional Context").first
    expect(additional_context_section).to_contain_text("Using Amplify Skills")
    expect(additional_context_section).not_to_contain_text("FINAL CONTEXT MARKER")
    expect(additional_context_section.locator("[data-action='toggle-attachment-section']")).to_have_text("Expand")
    additional_context_section.locator("[data-action='toggle-attachment-section']").click()
    expect(hook_attachment.locator(".attachment-section", has_text="Additional Context").first).to_contain_text("FINAL CONTEXT MARKER")
    expect(hook_attachment.locator(".attachment-section", has_text="Additional Context").first.locator("[data-action='toggle-attachment-section']")).to_have_text("Collapse")
    expect(hook_attachment.locator("[data-action='toggle-raw-payload']")).to_have_text("View payload")
    hook_attachment.locator("[data-action='toggle-raw-payload']").click()
    expect(hook_attachment.locator("[data-raw-payload]")).to_be_visible()
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text('"attachment"')
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text("hookSpecificOutput")
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text("FINAL CONTEXT MARKER")
    expect(hook_attachment.locator("[data-action='toggle-raw-payload']")).to_have_text("Hide payload")
    hook_attachment.locator("[data-action='toggle-raw-payload']").click()
    expect(hook_attachment.locator("[data-raw-payload]")).to_be_hidden()
    expect(page.locator(".reader-message .message-gutter")).to_have_count(0)
    expect(page.locator(".reader-message .message-card-index").first).to_be_visible()
    left_nav_header_metrics = page.evaluate(
        """async () => {
            const header = document.querySelector('[data-testid="left-pane-header"]');
            const body = document.querySelector('.nav-body-section');
            const rect = (node) => {
                const r = node.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
            };
            const before = {
                header: rect(header),
                bodyScrollTop: body.scrollTop,
                bodyScrollHeight: body.scrollHeight,
                bodyClientHeight: body.clientHeight,
                buttonRadius: getComputedStyle(document.querySelector('#agentPaneToggle')).borderRadius,
            };
            body.scrollTop = Math.min(900, Math.max(0, body.scrollHeight - body.clientHeight));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const after = {
                header: rect(header),
                bodyScrollTop: body.scrollTop,
            };
            return { before, after };
        }"""
    )
    assert left_nav_header_metrics["before"]["bodyScrollHeight"] > left_nav_header_metrics["before"]["bodyClientHeight"], left_nav_header_metrics
    assert left_nav_header_metrics["after"]["bodyScrollTop"] > left_nav_header_metrics["before"]["bodyScrollTop"], left_nav_header_metrics
    assert abs(left_nav_header_metrics["after"]["header"]["top"] - left_nav_header_metrics["before"]["header"]["top"]) <= 1.5, left_nav_header_metrics
    assert left_nav_header_metrics["before"]["buttonRadius"].startswith("999"), left_nav_header_metrics
    card_index_geometry = page.locator(".reader-message").first.evaluate(
        """message => {
            const card = message.querySelector('.message-card');
            const header = message.querySelector('.message-header');
            const index = message.querySelector('.message-card-index');
            const messageRect = message.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const indexRect = index.getBoundingClientRect();
            return {
                leadingGap: Math.round(cardRect.left - messageRect.left),
                indexIsRightAligned: indexRect.left > headerRect.left + headerRect.width * 0.75,
                indexRightDelta: Math.round(headerRect.right - indexRect.right),
            };
        }"""
    )
    assert card_index_geometry["leadingGap"] == 0, card_index_geometry
    assert card_index_geometry["indexIsRightAligned"], card_index_geometry
    assert card_index_geometry["indexRightDelta"] >= 0, card_index_geometry
    card_before_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    page.get_by_test_id("transcript-message").nth(1).click()
    page.wait_for_timeout(200)
    card_after_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    assert card_after_key != card_before_key, (card_before_key, card_after_key)
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    assert page.locator("[data-testid='subagent-node']").count() == 65
    reader_layout_geometry = page.locator("[data-testid='conversation-workbench']").evaluate(
        """element => {
            const style = getComputedStyle(element);
            return {
                display: style.display,
                gridColumnCount: style.gridTemplateColumns === 'none' ? 0 : style.gridTemplateColumns.split(' ').length,
            };
        }"""
    )
    if reader_layout_geometry["display"] == "grid":
        assert reader_layout_geometry["gridColumnCount"] == 2, (
            f"reader grid should use two columns, saw {reader_layout_geometry}"
        )
    initial_metrics = focus_layout_metrics(page)
    assert_no_horizontal_overflow(page)

    record(page, "reader.default", kind="dom_assertion", flow="reader.waterfall", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Waterfall layout is reachable and selecting message cards does not open the floating detail panel")
    record(page, "reader.default", kind="interaction", flow="reader.attachment_payload", viewport=viewport, selector=".reader-part.attachment", assertion="Waterfall cards render two-level message kind chips, type-specific attachment cards for all observed Claude attachment types, smaller tool payload text, and lazily expanded raw JSON")
    record(page, "reader.default", kind="geometry", flow="reader.message_cards", viewport=viewport, selector=".reader-message .message-card-index", assertion="message cards have no leading gutter and show the ordinal at the right edge of the title bar")
    record(page, "left_nav.tabs", kind="dom_assertion", flow="reader.message_navigation", viewport=viewport, selector="[data-testid='message-index']", assertion="Waterfall left navigation defaults to the selected agent message list with one Agents drawer button")
    record(page, "left_nav.tabs", kind="geometry", flow="reader.pinned_nav_header", viewport=viewport, selector="[data-testid='left-pane-header']", assertion="left navigation single-button pane header remained fixed while the message navigation body scrolled")
    record(page, "ui.top_navigation", kind="dom_assertion", flow="top_nav.cleaned", viewport=viewport, selector="[data-testid='command-bar']", assertion="Prev, Next, First problem, timestamp, Jump time controls, Mode, and breadcrumb stack are absent; Backward and Forward are disabled initially; project path and branch are visible")
    record(page, "ui.no_conversation_search", kind="dom_assertion", flow="conversation.removed_controls", viewport=viewport, selector="[data-testid='transcript-filter']", assertion="conversation search controls and left Problems list are absent")
    record(page, "focus.layout_metrics", kind="dom_assertion", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion=f"mainMax={initial_metrics['mainMaxWidth']:.1f}, mainMin={initial_metrics['mainMinWidth']:.1f}, layout={initial_metrics['layoutWidth']:.1f}")
    record(page, "focus.layout_metrics", kind="geometry", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Waterfall layout exposes golden-section main width constraints")

    if viewport == "studio-native":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page)
        select_problem_track_from_agent_sidebar(page)
        assert_message_index_item_presentation(page, require_problem=True)
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator("#agentPaneToggle")).to_have_attribute("aria-expanded", "true")
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(0)
        page.locator("#agentTreeDrawerClose").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.agent_drawer_toggle_native", viewport=viewport, selector="#agentPaneToggle", assertion="native-resolution agent sidebar inserted left of message navigation and toggled a subagent panel")

    if viewport == "desktop":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page)
        select_problem_track_from_agent_sidebar(page)
        assert_message_index_item_presentation(page, require_problem=True)
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator(".subagent-panel .message-gutter")).to_have_count(0)
        expect(page.locator(".subagent-panel .message-card-index").first).to_be_visible()
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_text("")
        expect(page.locator("[role='treeitem'][aria-selected='true']")).to_have_count(1)
        expect(page.locator("#agentStreamSeparator")).to_be_visible()
        before_metrics = focus_layout_metrics(page)
        before_width = round(before_metrics["rackWidth"])
        assert before_metrics["mainContentWidth"] < initial_metrics["mainContentWidth"], (
            initial_metrics,
            before_metrics,
        )
        assert abs(before_metrics["mainStreamCenterDelta"]) <= 1.5, before_metrics
        assert not before_metrics["mainStreamClippedRight"], before_metrics
        assert before_metrics["rackFlexDirection"] == "row-reverse", before_metrics
        assert before_metrics["rackWidth"] <= before_metrics["maxRackWidth"] + 1.5, before_metrics
        page.locator("#agentStreamSeparator").focus()
        page.keyboard.press("End")
        page.wait_for_timeout(120)
        before_metrics = focus_layout_metrics(page)
        before_width = round(before_metrics["rackWidth"])
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(120)
        after_metrics = focus_layout_metrics(page)
        after_width = round(after_metrics["rackWidth"])
        assert after_width > before_width, (before_width, after_width)
        assert abs(after_metrics["mainStreamCenterDelta"]) <= 1.5, after_metrics
        page.keyboard.press("Home")
        page.wait_for_timeout(120)
        max_metrics = focus_layout_metrics(page)
        assert max_metrics["mainContentWidth"] + 2 >= max_metrics["mainMinWidth"], max_metrics
        assert abs(max_metrics["mainStreamCenterDelta"]) <= 1.5, max_metrics
        assert not max_metrics["mainStreamClippedRight"], max_metrics
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(120)
        clamped_metrics = focus_layout_metrics(page)
        assert abs(clamped_metrics["rackWidth"] - max_metrics["rackWidth"]) <= 1.5, (max_metrics, clamped_metrics)
        assert abs(clamped_metrics["mainStreamWidth"] - max_metrics["mainStreamWidth"]) <= 1.5, (max_metrics, clamped_metrics)
        page.keyboard.press("End")
        page.wait_for_timeout(120)
        min_metrics = focus_layout_metrics(page)
        box = page.locator("#agentStreamSeparator").bounding_box()
        assert box, "separator should have a visible box"
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] - 180, box["y"] + box["height"] / 2)
        page.mouse.up()
        page.wait_for_timeout(120)
        drag_metrics = focus_layout_metrics(page)
        assert drag_metrics["rackWidth"] > min_metrics["rackWidth"], (min_metrics, drag_metrics)
        page.evaluate(
            """() => {
                const main = document.getElementById('mainContent');
                const panel = document.querySelector('.subagent-panel');
                main.style.scrollBehavior = 'auto';
                panel.style.scrollBehavior = 'auto';
                main.scrollTop = 520;
                panel.scrollTop = 0;
            }"""
        )
        page.wait_for_timeout(160)
        scrolls = page.evaluate(
            """() => {
                const main = document.getElementById('mainContent');
                const panel = document.querySelector('.subagent-panel');
                const afterMainSet = { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) };
                panel.scrollTop = 360;
                return new Promise((resolve) => setTimeout(() => resolve({
                    afterMainSet,
                    afterPanelSet: { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) },
                }), 120));
            }"""
        )
        assert scrolls["afterMainSet"]["main"] > 0, scrolls
        assert scrolls["afterMainSet"]["panel"] == 0, scrolls
        assert scrolls["afterPanelSet"]["panel"] > 0, scrolls
        assert scrolls["afterPanelSet"]["main"] == scrolls["afterMainSet"]["main"], scrolls
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(0)
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute("aria-pressed", "false")
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_text("")
        drawer_open_metrics = focus_layout_metrics(page)
        assert drawer_open_metrics["rackWidth"] == 0, drawer_open_metrics
        assert drawer_open_metrics["mainContentWidth"] < initial_metrics["mainContentWidth"], (
            initial_metrics,
            drawer_open_metrics,
        )
        page.locator("#agentTreeDrawerClose").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
        closed_metrics = focus_layout_metrics(page)
        assert closed_metrics["rackWidth"] == 0, closed_metrics
        assert abs(closed_metrics["mainStreamWidth"] - initial_metrics["mainStreamWidth"]) <= 1.5, (
            initial_metrics,
            closed_metrics,
        )
        assert abs(closed_metrics["mainStreamLeft"] - initial_metrics["mainStreamLeft"]) <= 1.5, (
            initial_metrics,
            closed_metrics,
        )
        assert_interactive_dom_health(page)
        record(page, "left_nav.tabs", kind="interaction", flow="reader.agent_tree_drawer", viewport=viewport, selector="#agentPaneToggle", assertion="Agents sidebar inserts before message navigation and toggles hierarchical subagent panels")
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.resize_panel", viewport=viewport, selector="#agentStreamSeparator", assertion="Waterfall view shows a vertical divider and keyboard/pointer resizing changes the subagent panel rack width")
        record(page, "focus.layout_metrics", kind="interaction", flow="reader.resize_clamp", viewport=viewport, selector="#agentStreamSeparator", assertion="divider resizing clamps at golden-remainder main content width and preserves main stream left edge")

        page.locator(".spawn-reference").first.scroll_into_view_if_needed()
        page.locator(".spawn-reference button", has_text="Open subagent").first.click()
        assert page.locator(".subagent-panel").count() >= 1
        expect(page.get_by_test_id("subagent-panel-overlay")).to_contain_text("Subagent")
        first_pin = page.evaluate(
            """() => {
                const rack = document.querySelector('.subagent-panel-rack');
                const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                const panel = panels[panels.length - 1];
                const rackRect = rack.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                return {
                    visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                    scrollLeft: rack.scrollLeft,
                    panelSlot: panelRect.width + 14,
                };
            }"""
        )
        assert first_pin["visible"], first_pin
        rack_scroll_before = first_pin["scrollLeft"]
        page.locator(".spawn-reference button", has_text="Open subagent").nth(1).click()
        page.wait_for_timeout(420)
        second_pin = page.evaluate(
            """() => {
                const rack = document.querySelector('.subagent-panel-rack');
                const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                const panel = panels[panels.length - 1];
                const rackRect = rack.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                return {
                    visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                    scrollLeft: rack.scrollLeft,
                    panelSlot: panelRect.width + 14,
                    flexDirection: getComputedStyle(rack).flexDirection,
                    firstPanelRight: panels[0].getBoundingClientRect().right,
                    secondPanelRight: panels[1].getBoundingClientRect().right,
                };
            }"""
        )
        assert second_pin["visible"], second_pin
        assert second_pin["flexDirection"] == "row-reverse", second_pin
        assert second_pin["firstPanelRight"] > second_pin["secondPanelRight"], second_pin
        assert abs(second_pin["scrollLeft"] - rack_scroll_before) <= second_pin["panelSlot"] + 90, (
            rack_scroll_before,
            second_pin,
        )
        if page.locator(".spawn-reference button", has_text="Open subagent").count() > 2:
            preserved_scroll_before = second_pin["scrollLeft"]
            page.locator(".spawn-reference button", has_text="Open subagent").nth(2).click()
            page.wait_for_timeout(420)
            third_pin = page.evaluate(
                """() => {
                    const rack = document.querySelector('.subagent-panel-rack');
                    const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                    const panel = panels[panels.length - 1];
                    const rackRect = rack.getBoundingClientRect();
                    const panelRect = panel.getBoundingClientRect();
                    return {
                        visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                        scrollLeft: rack.scrollLeft,
                        panelSlot: panelRect.width + 14,
                    };
                }"""
            )
            assert third_pin["visible"], third_pin
            assert abs(third_pin["scrollLeft"] - preserved_scroll_before) <= third_pin["panelSlot"] + 90, (
                preserved_scroll_before,
                third_pin,
            )
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.open_panel", viewport=viewport, selector=".spawn-reference button", assertion="task reference opened a subagent panel")
        record(page, "reader.subagent_panels", kind="dom_assertion", flow="reader.open_panel", viewport=viewport, selector=".subagent-panel", assertion="subagent panel is rendered")

        page.locator(".subagent-panel .agent-panel-close").first.click()
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.close_panel", viewport=viewport, selector=".agent-panel-close", assertion="subagent panel closes")

        before = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        page.get_by_test_id("message-index").locator("[data-action='focus-message']").nth(1).click()
        after = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        assert after != before
        expect(page.locator("#returnElementBtn")).to_be_enabled()
        expect(page.locator("#forwardElementBtn")).to_be_disabled()
        page.locator("#returnElementBtn").click()
        page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=before)
        expect(page.locator("#forwardElementBtn")).to_be_enabled()
        page.locator("#forwardElementBtn").click()
        page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=after)
        record(page, "nav.return_forward", kind="interaction", flow="reader.return_forward", viewport=viewport, selector="#returnElementBtn,#forwardElementBtn", assertion="Backward and Forward restored transcript focus in both directions")

    screenshot = screenshot_dir / f"{viewport}-reader.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "reader.default", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Waterfall layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Waterfall layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="reader.geometry", viewport=viewport, selector="document", assertion="Waterfall layout has no document-level horizontal overflow")


def scroll_graph_to_capsule(page: Page, key: str) -> None:
    page.evaluate(
        """(key) => {
            const capsule = window.SESSION_VIEWER.capsules.find((item) => item.key === key);
            const viewport = document.getElementById('graphViewport');
            if (!capsule || !viewport) return;
            viewport.scrollLeft = Math.max(0, capsule.x - viewport.clientWidth * 0.35);
            viewport.scrollTop = Math.max(0, capsule.y - viewport.clientHeight * 0.35);
        }""",
        key,
    )
    page.wait_for_timeout(120)


def timeline_alignment_metrics(page: Page) -> dict[str, Any]:
    metrics = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.timelineMetrics()")
    assert metrics, metrics
    return metrics


def validate_limited_timeline_alignment(page: Page, url: str, viewport: str) -> None:
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible(timeout=20_000)
    page.wait_for_function("document.querySelectorAll('[data-testid=timeline-block]').length > 0")
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 3, counts
    metrics = timeline_alignment_metrics(page)
    tolerance = max(2.0, metrics["viewportWidth"] * 0.001)
    assert metrics["trackGroupFitsViewport"], metrics
    assert abs(metrics["trackGroupCenterDelta"]) <= tolerance, metrics
    assert metrics["viewportScrollLeft"] <= 1, metrics
    assert metrics["mainTrackVisibleInitially"], metrics
    assert_no_horizontal_overflow(page)
    record(
        page,
        "overview.track_alignment",
        kind="geometry",
        flow="timeline.limited_tracks_centered",
        viewport=viewport,
        selector="window.SESSION_VIEWER.timelineMetrics()",
        assertion=(
            f"limited tracks={counts['tracks']} span={metrics['trackSpan']:.1f} "
            f"centerDelta={metrics['trackGroupCenterDelta']:.2f}"
        ),
    )


def assert_timeline_detail_tabs(page: Page, viewport: str) -> None:
    panel = page.get_by_test_id("timeline-detail-panel").first
    expect(panel).to_be_visible()
    detail = panel.evaluate(
        """(panel) => {
            const tablist = panel.querySelector('.timeline-detail-tablist');
            const tabs = Array.from(panel.querySelectorAll('.timeline-detail-tab'));
            const metadataTab = panel.querySelector('[data-detail-tab-target="metadata"]');
            const rawTab = panel.querySelector('[data-detail-tab-target="raw"]');
            const tablistStyle = getComputedStyle(tablist);
            const metadataTabStyle = getComputedStyle(metadataTab);
            const rawTabStyle = getComputedStyle(rawTab);
            const contentsPanel = panel.querySelector('[data-detail-panel="contents"]');
            const metadataPanel = panel.querySelector('[data-detail-panel="metadata"]');
            const rawPanel = panel.querySelector('[data-detail-panel="raw"]');
            const actionButtons = Array.from(panel.querySelectorAll('.timeline-detail-actions button'));
            const pinButton = panel.querySelector('[data-testid="timeline-detail-pin"]');
            const closeButton = panel.querySelector('.timeline-detail-close');
            return {
                headerSummaryCount: panel.querySelectorAll('.timeline-detail-header h2').length,
                badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                contentKinds: (panel.querySelector('.timeline-detail-kind-stack')?.dataset.contentKinds || '').split(',').filter(Boolean),
                tabTexts: tabs.map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim()),
                tabTargets: tabs.map((tab) => tab.dataset.detailTabTarget || ''),
                tabRoles: tabs.map((tab) => tab.getAttribute('role') || ''),
                tablistDisplay: tablistStyle.display,
                tablistRadius: Number.parseFloat(tablistStyle.borderTopLeftRadius) || 0,
                metadataDividerWidth: Number.parseFloat(metadataTabStyle.borderLeftWidth) || 0,
                rawDividerWidth: Number.parseFloat(rawTabStyle.borderLeftWidth) || 0,
                selectedTab: panel.dataset.detailTab || '',
                contentsSelected: panel.querySelector('[data-detail-tab-target="contents"]')?.getAttribute('aria-selected') || '',
                metadataSelected: panel.querySelector('[data-detail-tab-target="metadata"]')?.getAttribute('aria-selected') || '',
                rawSelected: panel.querySelector('[data-detail-tab-target="raw"]')?.getAttribute('aria-selected') || '',
                contentsHidden: contentsPanel.hidden,
                metadataHidden: metadataPanel.hidden,
                rawHidden: rawPanel.hidden,
                contentHasBody: Boolean(contentsPanel.querySelector('.timeline-detail-parts, .timeline-detail-body')),
                rawHasCodeBlock: Boolean(rawPanel.querySelector('pre code')),
                metadataAlertCount: metadataTab.querySelectorAll('.timeline-detail-tab-alert').length,
                actionOrder: actionButtons.map((button) => button.dataset.action || ''),
                pinText: pinButton?.innerText.trim() || '',
                pinHasIcon: Boolean(pinButton?.querySelector('svg')),
                pinLeftOfClose: pinButton && closeButton
                    ? pinButton.getBoundingClientRect().left < closeButton.getBoundingClientRect().left
                    : false,
            };
        }"""
    )
    assert detail["headerSummaryCount"] == 0, detail
    assert detail["badgeText"], detail
    assert detail["lineKind"], detail
    assert detail["contentBadges"], detail
    assert detail["contentKinds"], detail
    assert detail["tabTexts"] == ["Contents", "Metadata", "Raw"], detail
    assert detail["tabTargets"] == ["contents", "metadata", "raw"], detail
    assert detail["tabRoles"] == ["tab", "tab", "tab"], detail
    assert detail["tablistDisplay"] in {"flex", "inline-flex"}, detail
    assert detail["tablistRadius"] >= 12, detail
    assert detail["metadataDividerWidth"] >= 1, detail
    assert detail["rawDividerWidth"] >= 1, detail
    assert detail["selectedTab"] == "contents", detail
    assert detail["contentsSelected"] == "true" and detail["metadataSelected"] == "false" and detail["rawSelected"] == "false", detail
    assert detail["contentsHidden"] is False and detail["metadataHidden"] is True and detail["rawHidden"] is True, detail
    assert detail["contentHasBody"], detail
    assert detail["rawHasCodeBlock"], detail
    assert detail["actionOrder"][:2] == ["toggle-timeline-detail-pin", "close-timeline-detail"], detail
    assert detail["pinText"] == "", detail
    assert detail["pinHasIcon"], detail
    assert detail["pinLeftOfClose"], detail
    record(
        page,
        "timeline.detail_tabs",
        kind="dom_assertion",
        flow="timeline.detail_structure",
        viewport=viewport,
        selector="[data-testid='timeline-detail-panel']",
        assertion=(
            f"detail top section shows {detail['badgeText']!r} line badge and {detail['contentBadges']!r} content badges plus merged Contents/Metadata/Raw tabs "
            "with no duplicated summary heading under the badge"
        ),
    )

    panel.get_by_role("tab", name="Metadata").click()
    metadata = panel.evaluate(
        """(panel) => {
            const labels = Array.from(panel.querySelectorAll('[data-detail-panel="metadata"] .timeline-detail-meta dt'))
                .map((item) => item.innerText.trim());
            return {
                selectedTab: panel.dataset.detailTab || '',
                contentsSelected: panel.querySelector('[data-detail-tab-target="contents"]')?.getAttribute('aria-selected') || '',
                metadataSelected: panel.querySelector('[data-detail-tab-target="metadata"]')?.getAttribute('aria-selected') || '',
                rawSelected: panel.querySelector('[data-detail-tab-target="raw"]')?.getAttribute('aria-selected') || '',
                contentsHidden: panel.querySelector('[data-detail-panel="contents"]').hidden,
                metadataHidden: panel.querySelector('[data-detail-panel="metadata"]').hidden,
                rawHidden: panel.querySelector('[data-detail-panel="raw"]').hidden,
                labels,
            };
        }"""
    )
    expected_labels = {"Line type", "Content types", "Agent", "Block", "Time", "Line", "Path", "Problems", "Common failures"}
    assert metadata["selectedTab"] == "metadata", metadata
    assert metadata["contentsSelected"] == "false" and metadata["metadataSelected"] == "true" and metadata["rawSelected"] == "false", metadata
    assert metadata["contentsHidden"] is True and metadata["metadataHidden"] is False and metadata["rawHidden"] is True, metadata
    assert expected_labels <= set(metadata["labels"]), metadata
    record(
        page,
        "timeline.detail_tabs",
        kind="interaction",
        flow="timeline.detail_metadata_tab",
        viewport=viewport,
        selector="[data-detail-tab-target='metadata']",
        assertion="Metadata tab switches the second section to Line type, Content types, Agent, Block, Time, Line, Path, Problems, and Common failures",
    )

    panel.get_by_role("tab", name="Contents").click()
    expect(panel.locator("[data-detail-tab-target='contents']")).to_have_attribute("aria-selected", "true")

    panel.get_by_role("tab", name="Raw").click()
    raw = panel.evaluate(
        """(panel) => {
            const code = panel.querySelector('[data-detail-panel="raw"] pre code');
            return {
                selectedTab: panel.dataset.detailTab || '',
                contentsSelected: panel.querySelector('[data-detail-tab-target="contents"]')?.getAttribute('aria-selected') || '',
                metadataSelected: panel.querySelector('[data-detail-tab-target="metadata"]')?.getAttribute('aria-selected') || '',
                rawSelected: panel.querySelector('[data-detail-tab-target="raw"]')?.getAttribute('aria-selected') || '',
                contentsHidden: panel.querySelector('[data-detail-panel="contents"]').hidden,
                metadataHidden: panel.querySelector('[data-detail-panel="metadata"]').hidden,
                rawHidden: panel.querySelector('[data-detail-panel="raw"]').hidden,
                codeText: code?.innerText || '',
            };
        }"""
    )
    assert raw["selectedTab"] == "raw", raw
    assert raw["contentsSelected"] == "false" and raw["metadataSelected"] == "false" and raw["rawSelected"] == "true", raw
    assert raw["contentsHidden"] is True and raw["metadataHidden"] is True and raw["rawHidden"] is False, raw
    assert '"type"' in raw["codeText"] or '"table"' in raw["codeText"], raw
    record(
        page,
        "timeline.detail_tabs",
        kind="interaction",
        flow="timeline.detail_raw_tab",
        viewport=viewport,
        selector="[data-detail-tab-target='raw']",
        assertion="Raw tab switches the second section to a formatted raw JSONL code block",
    )

    panel.get_by_role("tab", name="Contents").click()
    expect(panel.locator("[data-detail-tab-target='contents']")).to_have_attribute("aria-selected", "true")


def assert_timeline_detail_error_badge(page: Page, viewport: str) -> None:
    target = page.evaluate(
        """() => window.SESSION_VIEWER.capsules.find((item) => item.type === 'tool_result' && item.problemCount > 0)"""
    )
    assert target, "expected a problem-bearing tool result capsule in the fixture"
    scroll_graph_to_capsule(page, target["key"])
    page.locator(f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']").click()
    panel = page.get_by_test_id("timeline-detail-panel").first
    expect(panel).to_be_visible()
    error_detail = panel.evaluate(
        """(panel) => ({
            badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
            contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
            lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
            headerSummaryCount: panel.querySelectorAll('.timeline-detail-header h2').length,
            tabTexts: Array.from(panel.querySelectorAll('.timeline-detail-tab')).map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim()),
        })"""
    )
    assert error_detail["badgeText"] == "USER", error_detail
    assert error_detail["lineKind"] == "user", error_detail
    assert "tool result" in error_detail["contentBadges"], error_detail
    assert error_detail["headerSummaryCount"] == 0, error_detail
    assert error_detail["tabTexts"][0] == "Contents" and error_detail["tabTexts"][2] == "Raw", error_detail
    assert error_detail["tabTexts"][1].startswith("Metadata") and error_detail["tabTexts"][1].endswith("!"), error_detail
    metadata_tab = panel.locator("[data-detail-tab-target='metadata']")
    expect(metadata_tab).to_contain_text("Metadata")
    expect(metadata_tab.locator(".timeline-detail-tab-alert")).to_be_visible()
    metadata_tab.click()
    expect(panel.locator("[data-detail-panel='metadata']")).to_be_visible()
    common_failures = panel.locator(".timeline-detail-meta dt", has_text="Common failures").locator("xpath=following-sibling::dd[1]")
    expect(common_failures).not_to_have_text("None")
    record(
        page,
        "timeline.detail_tabs",
        kind="interaction",
        flow="timeline.detail_error_badge",
        viewport=viewport,
        selector="[data-detail-tab-target='metadata'] .timeline-detail-tab-alert",
        assertion="error-bearing tool result keeps USER / tool result badges, shows an exclamation badge on Metadata, and lists common failures",
    )


def assert_timeline_attachment_detail(page: Page, viewport: str) -> None:
    targets = page.evaluate(
        """() => window.SESSION_VIEWER.capsules
            .filter((item) => item.type === 'attachment')
            .map((item) => ({ key: item.key }))"""
    )
    assert targets, "expected attachment capsules in the fixture"
    seen_types: set[str] = set()
    hook_raw_verified = False
    for target in targets:
        scroll_graph_to_capsule(page, target["key"])
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']").click()
        panel = page.get_by_test_id("timeline-detail-panel").first
        expect(panel).to_be_visible()
        detail = panel.evaluate(
            """(panel) => {
                const event = panel.querySelector('.attachment-event');
                const contents = panel.querySelector('[data-detail-panel="contents"]');
                const contentRoot = contents || panel;
                const sectionLabels = Array.from(contentRoot.querySelectorAll('.attachment-section header strong'))
                    .map((item) => item.innerText.trim());
                const disallowedSectionLabels = new Set(['Output', 'Standard Output', 'Standard Error', 'Context Preview']);
                return {
                    badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                    lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                    contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                    attachmentType: event?.dataset.attachmentType || '',
                    typeBadge: event?.querySelector('.attachment-type-badge')?.innerText.trim() || '',
                    titleText: event?.querySelector('.attachment-display-heading strong')?.innerText.trim() || '',
                    summaryText: event?.querySelector('.attachment-summary')?.innerText.trim() || '',
                    sectionCount: event?.querySelectorAll('.attachment-section').length || 0,
                    rowCount: event?.querySelectorAll('.attachment-meta dd').length || 0,
                    sectionLabels,
                    disallowedLabels: sectionLabels.filter((label) => disallowedSectionLabels.has(label)),
                    nonHumanLabels: sectionLabels.filter((label) => /_|[a-z][A-Z]/.test(label)),
                    payloadButtonCount: panel.querySelectorAll('[data-action="toggle-raw-payload"], [data-action="copy-raw-payload"]').length,
                    rawPayloadContainerCount: panel.querySelectorAll('[data-raw-payload]').length,
                    contentsText: contents?.innerText || '',
                    stdoutBodyCount: Array.from(contentRoot.querySelectorAll('.attachment-section pre'))
                        .filter((item) => /hookSpecificOutput|"stdout"|standard output:/i.test(item.innerText)).length,
                    contentPreCount: contents?.querySelectorAll('.attachment-section pre').length || 0,
                };
            }"""
        )
        assert detail["badgeText"] == "ATTACHMENT", detail
        assert detail["lineKind"] == "attachment", detail
        assert detail["contentBadges"], detail
        assert detail["attachmentType"], detail
        assert detail["typeBadge"], detail
        assert detail["titleText"], detail
        assert detail["summaryText"], detail
        assert detail["sectionCount"] + detail["rowCount"] >= 1, detail
        assert detail["payloadButtonCount"] == 0, detail
        assert detail["rawPayloadContainerCount"] == 0, detail
        assert detail["disallowedLabels"] == [], detail
        assert detail["nonHumanLabels"] == [], detail
        assert detail["stdoutBodyCount"] == 0, detail
        seen_types.add(detail["attachmentType"])
        if detail["attachmentType"] == "hook_success":
            assert "Hook Success" in detail["contentBadges"], detail
            assert "Additional Context" in detail["sectionLabels"], detail
            assert "Using Amplify Skills" in detail["contentsText"], detail
            assert "hookSpecificOutput" not in detail["contentsText"], detail
            panel.get_by_role("tab", name="Raw").click()
            raw_text = panel.locator("[data-detail-panel='raw']").inner_text()
            assert '"stdout"' in raw_text and "hookSpecificOutput" in raw_text, raw_text[:500]
            assert "FINAL CONTEXT MARKER" in raw_text, raw_text[:500]
            panel.get_by_role("tab", name="Contents").click()
            hook_raw_verified = True
    assert EXPECTED_ATTACHMENT_TYPES <= seen_types, seen_types
    assert hook_raw_verified, seen_types
    record(
        page,
        "timeline.detail_tabs",
        kind="dom_assertion",
        flow="timeline.detail_attachment_types",
        viewport=viewport,
        selector=".timeline-detail-part.attachment",
        assertion="attachment detail cards show type-specific content, omit stdout/stderr bodies, and keep complete payloads in Raw",
    )


def assert_window_layering(page: Page, viewport: str) -> None:
    page.locator("#sessionInfoButton").click()
    expect(page.locator("#sessionInfoPopover")).to_be_visible()
    layering = page.evaluate(
        """() => {
            const number = (value) => Number.parseInt(value, 10) || 0;
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
            };
            const command = document.querySelector('[data-testid="command-bar"]');
            const popover = document.querySelector('#sessionInfoPopover');
            const timelineHeader = document.querySelector('[data-testid="timeline-header"]');
            const timelineLabel = document.querySelector('[data-testid="timeline-track-label"]');
            const timelineBlock = document.querySelector('[data-testid="timeline-block"]');
            const detailDock = document.querySelector('[data-testid="timeline-detail-dock"]');
            const detailWindow = document.querySelector('[data-testid="timeline-detail-panel"]');
            const popoverValues = Array.from(popover.querySelectorAll('.mini-stats dd'));
            const popoverRect = rect(popover);
            const detailDockRect = rect(detailDock);
            const detailWindowRect = rect(detailWindow);
            const detailDockStyles = getComputedStyle(detailDock);
            const timelineLabelBottom = Math.max(
                ...Array.from(document.querySelectorAll('[data-testid="timeline-track-label"]')).map((node) => rect(node).bottom)
            );
            const topElement = document.elementFromPoint(
                popoverRect.left + popoverRect.width / 2,
                Math.min(popoverRect.bottom - 4, popoverRect.top + popoverRect.height / 2)
            );
            return {
                commandZ: number(getComputedStyle(command).zIndex),
                popoverZ: number(getComputedStyle(popover).zIndex),
                timelineHeaderZ: number(getComputedStyle(timelineHeader).zIndex),
                timelineLabelZ: number(getComputedStyle(timelineLabel).zIndex),
                timelineBlockZ: number(getComputedStyle(timelineBlock).zIndex),
                detailDockZ: number(getComputedStyle(detailDock).zIndex),
                popoverFontSize: getComputedStyle(popover).fontSize,
                popoverLineHeight: getComputedStyle(popover).lineHeight,
                popoverValueAlignments: popoverValues.map((value) => getComputedStyle(value).textAlign),
                popoverTopMost: Boolean(topElement?.closest('#sessionInfoPopover')),
                detailDockPaddingRight: Number.parseFloat(detailDockStyles.paddingRight) || 0,
                detailDockPaddingBottom: Number.parseFloat(detailDockStyles.paddingBottom) || 0,
                detailShadowBleedRight: detailDockRect.right - detailWindowRect.right,
                detailShadowBleedBottom: detailDockRect.bottom - detailWindowRect.bottom,
                detailTimelineHeaderClearance: detailDockRect.top - timelineLabelBottom,
                popover: popoverRect,
                command: rect(command),
                timelineLabel: rect(timelineLabel),
                detailDock: detailDockRect,
                detailWindow: detailWindowRect,
            };
        }"""
    )
    assert layering["timelineHeaderZ"] > layering["timelineBlockZ"], layering
    assert layering["timelineLabelZ"] > layering["timelineHeaderZ"], layering
    assert layering["commandZ"] > layering["timelineLabelZ"], layering
    assert layering["detailDockZ"] > layering["timelineLabelZ"], layering
    assert layering["popoverZ"] > layering["detailDockZ"], layering
    assert layering["popoverTopMost"], layering
    assert float(layering["popoverFontSize"].removesuffix("px")) <= 11.0, layering
    assert layering["popoverValueAlignments"] and set(layering["popoverValueAlignments"]) == {"right"}, layering
    assert layering["detailShadowBleedRight"] >= 80, layering
    assert layering["detailShadowBleedBottom"] >= 80, layering
    assert layering["detailTimelineHeaderClearance"] >= 12, layering
    record(
        page,
        "ui.layering",
        kind="dom_assertion",
        flow="timeline.window_layers",
        viewport=viewport,
        selector="#sessionInfoPopover",
        assertion=(
            "session info popover and message detail dock use window-level z-indexes above "
            "timeline header labels and blocks"
        ),
    )
    record(
        page,
        "ui.layering",
        kind="geometry",
        flow="timeline.popover_topmost",
        viewport=viewport,
        selector="document.elementFromPoint",
        assertion=(
            f"popover is topmost at its center with font-size {layering['popoverFontSize']} "
            "and right-aligned numeric values; detail dock reserves "
            f"{layering['detailShadowBleedRight']:.0f}px right and "
            f"{layering['detailShadowBleedBottom']:.0f}px bottom shadow bleed with "
            f"{layering['detailTimelineHeaderClearance']:.0f}px timeline-header clearance"
        ),
    )
    page.keyboard.press("Escape")
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()


def validate_graph(page: Page, url: str, viewport: str, screenshot_dir: Path) -> None:
    graph_url = url
    page.goto(graph_url, wait_until="networkidle")
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("reader-layout")).to_be_hidden()
    expect(page.locator(".left-rail")).to_be_hidden()
    expect(page.locator("#graphLayoutBtn")).to_contain_text("Timeline")
    expect(page.locator("#readerLayoutBtn")).to_contain_text("Waterfall")
    expect(page.locator("#modeToggleBtn")).to_have_count(0)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.locator("[data-testid='graph-capsule']")).to_have_count(0)
    page.wait_for_function("document.querySelectorAll('[data-testid=timeline-block]').length > 0")
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    rendered_blocks = page.locator("[data-testid='timeline-block']").count()
    assert rendered_blocks < 5000, f"virtual timeline rendered too many blocks: {rendered_blocks}"
    metrics = timeline_alignment_metrics(page)
    assert metrics["uniqueBlockWidths"] == [118], metrics
    assert metrics["uniqueBlockHeights"] == [26], metrics
    assert len(metrics["uniqueBlockColors"]) >= 3, metrics
    assert metrics["renderedHeaderLabels"] == counts["tracks"], metrics
    assert metrics["uniqueHeaderHeights"] == [58], metrics
    assert metrics["headerPosition"] == "sticky", metrics
    assert metrics["headerZIndex"] > metrics["blockZIndex"], metrics
    assert "90deg" not in metrics["backgroundImage"], metrics
    assert "1px" not in metrics["backgroundImage"], metrics
    assert not metrics["trackGroupFitsViewport"], metrics
    assert metrics["viewportScrollLeft"] <= 1, metrics
    assert metrics["mainTrackVisibleInitially"], metrics
    main_timeline_label = page.evaluate(
        """() => {
            const label = document.querySelector('.timeline-header-track.main [data-testid="timeline-track-label"]');
            return {
                text: label?.innerText.replace(/\\s+/g, ' ').trim() || '',
                title: label?.getAttribute('title') || '',
                hasKicker: Boolean(label?.querySelector('.timeline-track-kicker')),
            };
        }"""
    )
    assert main_timeline_label["text"], main_timeline_label
    assert not main_timeline_label["hasKicker"], main_timeline_label
    assert len(re.findall(r"\bmain\b", main_timeline_label["text"], flags=re.IGNORECASE)) == 1, main_timeline_label
    assert len(re.findall(r"\bmain\b", main_timeline_label["title"], flags=re.IGNORECASE)) == 1, main_timeline_label
    block_kind_sample = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
            .slice(0, 160)
            .map((element) => ({
                label: element.textContent.replace(/\\s+/g, ' ').trim(),
                line: element.dataset.lineKind || '',
                content: (element.dataset.contentKinds || '').split(',').filter(Boolean),
                title: element.getAttribute('title') || '',
                aria: element.getAttribute('aria-label') || '',
            }))"""
    )
    assert any(item["line"] == "user" and "message" in item["content"] and item["label"].startswith("MSG ") for item in block_kind_sample), block_kind_sample[:20]
    assert any(item["line"] == "user" and "tool result" in item["content"] and item["label"].startswith("RESULT ") for item in block_kind_sample), block_kind_sample[:20]
    assert any(item["line"] == "assistant" and "message" in item["content"] and item["label"].startswith("MSG ") for item in block_kind_sample), block_kind_sample[:20]
    assert any(item["line"] == "assistant" and "reasoning" in item["content"] and item["label"].startswith("REASON ") for item in block_kind_sample), block_kind_sample[:20]
    assert any(item["line"] == "assistant" and "tool call" in item["content"] and item["label"].startswith("TOOL ") for item in block_kind_sample), block_kind_sample[:20]
    assert any(item["line"] == "attachment" and "Hook Success" in item["content"] and item["label"].startswith("HOOK ") for item in block_kind_sample), block_kind_sample[:20]
    assert any("user / tool result" in item["title"] and "user / tool result" in item["aria"] for item in block_kind_sample), block_kind_sample[:20]
    assert not any(" · " in item["label"] for item in block_kind_sample), block_kind_sample[:20]
    dom_count = page.evaluate("document.querySelectorAll('*').length")
    assert dom_count < 9000, f"timeline page DOM too large: {dom_count}"
    assert_no_horizontal_overflow(page)
    assert_timeline_detail_tabs(page, viewport)
    if viewport in {"studio-native", "desktop"}:
        assert_window_layering(page, viewport)
    if viewport in {"studio-native", "desktop"}:
        assert_timeline_attachment_detail(page, viewport)
        assert_timeline_detail_error_badge(page, viewport)

    record(page, "graph.dom_svg", kind="dom_assertion", flow="timeline.open", viewport=viewport, selector="[data-testid='overview-timeline']", assertion=f"default Timeline rendered {counts['messages']} logical messages without canvas and without the left rail")
    record(page, "perf.large_session", kind="dom_assertion", flow="timeline.dom_budget", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"virtual timeline rendered {rendered_blocks} visible blocks")
    record(page, "overview.header_stability", kind="dom_assertion", flow="timeline.header_dom", viewport=viewport, selector="[data-testid='timeline-header']", assertion="sticky header has equal-height labels above timeline blocks and no grid-line background")
    record(page, "overview.header_stability", kind="dom_assertion", flow="timeline.main_track_label", viewport=viewport, selector=".timeline-header-track.main [data-testid='timeline-track-label']", assertion=f"main timeline header label shows the main agent name once without a duplicate kicker: {main_timeline_label['text']!r}")
    record(page, "overview.scroll_blocks", kind="dom_assertion", flow="timeline.block_labels", viewport=viewport, selector="[data-testid='timeline-block']", assertion="timeline blocks expose only compact second-level labels such as RESULT and full two-level title/aria labels")
    record(
        page,
        "overview.track_alignment",
        kind="geometry",
        flow="timeline.overflow_initial_main_visible",
        viewport=viewport,
        selector="window.SESSION_VIEWER.timelineMetrics()",
        assertion=(
            f"overflow tracks={counts['tracks']} span={metrics['trackSpan']:.1f} "
            f"scrollLeft={metrics['viewportScrollLeft']:.1f}, main={metrics['mainTrackLeft']:.1f}-{metrics['mainTrackRight']:.1f}"
        ),
    )

    problem_badge_capsule = page.evaluate("window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)")
    assert problem_badge_capsule, "expected a problem-bearing capsule in the fixture"
    scroll_graph_to_capsule(page, problem_badge_capsule["key"])
    badge = page.evaluate(
        """() => {
            const block = document.querySelector('[data-testid="timeline-block"].has-problem');
            if (!block) return null;
            const style = getComputedStyle(block);
            const after = getComputedStyle(block, '::after');
            const rect = block.getBoundingClientRect();
            return {
                overflow: style.overflow,
                markerTop: parseFloat(after.top),
                markerRight: parseFloat(after.right),
                markerWidth: parseFloat(after.width),
                markerHeight: parseFloat(after.height),
                blockTop: rect.top,
                blockRight: rect.right,
            };
        }"""
    )
    assert badge, "expected at least one problem-bearing timeline block"
    assert badge["overflow"] == "visible", badge
    assert badge["markerTop"] < 0 and badge["markerRight"] < 0, badge
    assert badge["markerWidth"] >= 14 and badge["markerHeight"] >= 14, badge
    record(page, "overview.problem_badge", kind="dom_assertion", flow="timeline.problem_badge", viewport=viewport, selector="[data-testid='timeline-block'].has-problem", assertion="problem badge is allowed to overflow outside the message block border")

    if viewport == "studio-native":
        center_selection = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const settle = async (ms = 120) => {
                    await raf();
                    await raf();
                    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
                };
                const clickCapsule = async (target) => {
                    viewport.scrollLeft = Math.max(0, target.x - 180);
                    viewport.scrollTop = Math.max(0, target.y - 180);
                    await settle(0);
                    Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
                        .find((element) => element.dataset.capsuleKey === target.key)
                        ?.click();
                    await settle(900);
                };
                const centeredTarget = window.SESSION_VIEWER.capsules.find((item) => (
                    item.x > viewport.clientWidth * 0.62 &&
                    item.y > viewport.clientHeight * 0.65 &&
                    item.x < viewport.scrollWidth - viewport.clientWidth * 0.62 &&
                    item.y < viewport.scrollHeight - viewport.clientHeight * 0.62
                )) || window.SESSION_VIEWER.capsules[Math.floor(window.SESSION_VIEWER.capsules.length / 2)];
                await clickCapsule(centeredTarget);
                const centeredMetrics = window.SESSION_VIEWER.timelineMetrics();
                return {
                    centeredTarget: centeredTarget.key,
                    centeredDelta: centeredMetrics.currentBlockCenterDelta,
                    detailPanels: document.querySelectorAll('[data-testid="timeline-detail-panel"]').length,
                    detailDockVisible: !document.querySelector('[data-testid="timeline-detail-dock"]')?.classList.contains('hidden'),
                    statusText: document.querySelector('[data-testid="selected-capsule-summary"]')?.textContent || '',
                };
            }"""
        )
        assert center_selection["centeredDelta"], center_selection
        assert abs(center_selection["centeredDelta"]["x"]) <= 8, center_selection
        assert abs(center_selection["centeredDelta"]["y"]) <= 8, center_selection
        assert center_selection["detailPanels"] >= 1, center_selection
        assert center_selection["detailDockVisible"], center_selection
        assert center_selection["statusText"], center_selection
        assert_timeline_detail_top_right(page)
        record(page, "graph.dom_svg", kind="interaction", flow="timeline.center_select_with_detail", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"focused block centered with delta {center_selection['centeredDelta']} and the Timeline detail dock stayed visible")

        down_scroll = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const counts = [];
                const samples = [];
                const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
                const visibleCount = () => {
                    const viewportRect = viewport.getBoundingClientRect();
                    const blocks = Array.from(document.querySelectorAll('[data-testid="timeline-block"]'));
                    const visible = blocks.filter((block) => {
                        const rect = block.getBoundingClientRect();
                        return rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom && rect.right >= viewportRect.left && rect.left <= viewportRect.right;
                    });
                    return {
                        scrollTop: viewport.scrollTop,
                        visible: visible.length,
                        sample: visible.slice(0, 8).map((block) => block.textContent.replace(/\\s+/g, ' ').trim()),
                    };
                };
                for (const fraction of [0.18, 0.42, 0.68, 0.88]) {
                    viewport.scrollLeft = 0;
                    viewport.scrollTop = maxTop * fraction;
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const result = visibleCount();
                    counts.push(result.visible);
                    samples.push(result.sample);
                }
                return { counts, samples };
            }"""
        )
        assert all(count > 0 for count in down_scroll["counts"]), down_scroll
        assert not any(label.startswith("US ") or label.startswith("AS ") or label.startswith("TR ") for sample in down_scroll["samples"] for label in sample), down_scroll
        record(page, "overview.scroll_blocks", kind="interaction", flow="timeline.down_scroll_blocks", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"visible block counts after down-scroll: {down_scroll['counts']}")
        record(page, "overview.problem_badge", kind="interaction", flow="timeline.problem_badge_native", viewport=viewport, selector="[data-testid='timeline-block'].has-problem", assertion="problem badge geometry verified at native resolution")

        stability = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const label = document.querySelector('[data-testid="timeline-track-label"]');
                const before = window.SESSION_VIEWER.timelineMetrics();
                const tops = [];
                const lefts = [];
                const start = performance.now();
                for (let index = 0; index < 28; index += 1) {
                    viewport.scrollTop += Math.max(220, Math.floor(viewport.clientHeight * 0.18));
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const rect = label.getBoundingClientRect();
                    tops.push(rect.top);
                    lefts.push(rect.left);
                }
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const after = window.SESSION_VIEWER.timelineMetrics();
                return {
                    before,
                    after,
                    topRange: Math.max(...tops) - Math.min(...tops),
                    leftRange: Math.max(...lefts) - Math.min(...lefts),
                    elapsedMs: performance.now() - start,
                };
            }"""
        )
        assert stability["topRange"] <= 1.5, stability
        assert stability["leftRange"] <= 1.5, stability
        assert stability["after"]["renderCounts"]["header"] == stability["before"]["renderCounts"]["header"], stability
        assert stability["after"]["renderCounts"]["detail"] == stability["before"]["renderCounts"]["detail"], stability
        assert stability["elapsedMs"] < 2500, stability
        record(page, "overview.header_stability", kind="interaction", flow="timeline.header_scroll", viewport=viewport, selector="[data-testid='timeline-track-label']", assertion=f"header top range {stability['topRange']:.2f}px during multi-screen native scroll")
        record(page, "overview.header_stability", kind="performance", flow="timeline.header_scroll", viewport=viewport, selector="window.SESSION_VIEWER.timelineMetrics()", assertion=f"header rerenders stayed at {stability['after']['renderCounts']['header']} over {stability['elapsedMs']:.1f}ms scroll sample")

    if viewport == "mobile":
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

    if viewport == "desktop":
        spawn = page.evaluate("window.SESSION_VIEWER.spawnEdges[0]")
        scroll_graph_to_capsule(page, spawn["sourceKey"])
        before_width = page.get_by_test_id("overview-timeline").evaluate("node => node.clientWidth")
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{spawn['sourceKey']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("tool call")
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)
        after_width = page.get_by_test_id("overview-timeline").evaluate("node => node.clientWidth")
        assert after_width == before_width, (before_width, after_width)
        page.wait_for_function("document.querySelectorAll('.timeline-connector.spawn.selected').length > 0")
        record(page, "graph.dom_svg", kind="interaction", flow="timeline.click_block", viewport=viewport, selector="[data-testid='timeline-block']", assertion="clicking an HTML timeline block selected it and kept a floating detail panel visible")
        record(page, "graph.spawn_edges", kind="interaction", flow="timeline.spawn_connector", viewport=viewport, selector="[data-testid='timeline-block']", assertion="parent spawn block selected")
        record(page, "graph.spawn_edges", kind="dom_assertion", flow="timeline.spawn_connector", viewport=viewport, selector=".timeline-connector.spawn.selected", assertion="selected spawn block exposes a visible child connector")

        scroll_graph_to_capsule(page, spawn["targetKey"])
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{spawn['targetKey']}']").click()
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

        page.locator("[data-testid='timeline-block']").nth(0).click()
        page.locator("[data-testid='timeline-block']").nth(1).click(modifiers=["Meta"])
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("2 transcript elements selected")
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(2)
        assert_timeline_detail_top_right(page, expected_count=2)
        record(page, "graph.multiselect", kind="interaction", flow="timeline.multiselect", viewport=viewport, selector="[data-testid='timeline-block']", assertion="Control-click toggled timeline multi-selection")

        problem_capsule = page.evaluate("window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)")
        assert problem_capsule, "expected a problem-bearing capsule in the fixture"
        scroll_graph_to_capsule(page, problem_capsule["key"])
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{problem_capsule['key']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("problems")

        before_layout = page.evaluate("window.SESSION_VIEWER.current().layout")
        page.locator("#readerLayoutBtn").click()
        page.go_back()
        page.wait_for_function("(layout) => window.SESSION_VIEWER.current().layout === layout", arg=before_layout)
        record(page, "nav.return_forward", kind="interaction", flow="timeline.browser_history", viewport=viewport, selector="history.state", assertion="browser back restored timeline layout state")

    screenshot = screenshot_dir / f"{viewport}-timeline.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "visual.studio", kind="screenshot", flow="timeline.screenshot", viewport=viewport, selector="screenshot", assertion="timeline layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="timeline.geometry", viewport=viewport, selector="document", assertion="timeline layout has no document-level horizontal overflow")


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="session-viewer-dual-"))
    screenshots = Path("/tmp/session-viewer-browser-screenshots")
    if screenshots.exists():
        shutil.rmtree(screenshots)
    screenshots.mkdir(parents=True)
    server: subprocess.Popen[bytes] | None = None
    limited_server: subprocess.Popen[bytes] | None = None
    try:
        projects_dir = temp_root / "claude-home" / "projects"
        limited_projects_dir = temp_root / "limited-home" / "projects"
        opencode_data_dir = temp_root / "opencode-data"
        build_large_fixture(projects_dir)
        build_limited_fixture(limited_projects_dir)
        build_opencode_fixture(opencode_data_dir)
        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        server = start_server(projects_dir, port, opencode_data_dir)
        wait_for_server(base_url)
        sessions = httpx.get(f"{base_url}/api/sessions", timeout=10).json()
        assert len(sessions) == 1
        url = f"{base_url}/conversation/{sessions[0]['id']}"
        opencode_sessions = httpx.get(f"{base_url}/api/sessions?agent=opencode", timeout=10).json()
        assert len(opencode_sessions) == 1
        opencode_url = (
            f"{base_url}/conversation/opencode/{opencode_sessions[0]['id']}?"
            + urlencode({"tab": "opencode", "opencode_data_dir": str(opencode_data_dir)})
        )
        assert httpx.get(f"{base_url}/api/conversation/{sessions[0]['id']}", timeout=10).status_code == 200
        assert httpx.get(f"{base_url}/api/conversation/claude/{sessions[0]['id']}", timeout=10).status_code == 200
        assert httpx.get(f"{base_url}/api/conversation/opencode/{opencode_sessions[0]['id']}", timeout=10).status_code == 200

        console_errors: list[str] = []
        network_failures: list[str] = []
        with sync_playwright() as playwright:
            browser, browser_channel = launch_verified_browser(playwright)
            page = browser.new_page()
            RUN_METADATA.update(
                {
                    "browserChannel": browser_channel,
                    "browserVersion": browser.version,
                    "userAgent": page.evaluate("navigator.userAgent"),
                }
            )
            page.add_init_script(
                "localStorage.setItem('sessionViewerSubagentPanelRackWidth', '999999');"
            )
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda exc: console_errors.append(str(exc)))
            page.on("requestfailed", lambda request: network_failures.append(request.url))
            validate_dashboard(page, base_url, projects_dir=projects_dir, opencode_data_dir=opencode_data_dir)
            record(
                page,
                "compat.api_cli",
                kind="dom_assertion",
                flow="api.compatibility",
                selector="/api/conversation",
                assertion="legacy Claude, agent-aware Claude, and agent-aware OpenCode conversation APIs returned HTTP 200",
            )
            for viewport, width, height, dpr in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                page.emulate_media(color_scheme="light")
                if viewport == "studio-native":
                    validate_dashboard(
                        page,
                        base_url,
                        projects_dir=projects_dir,
                        opencode_data_dir=opencode_data_dir,
                        viewport=viewport,
                        screenshot_dir=screenshots,
                    )
                    record(
                        page,
                        "compat.api_cli",
                        kind="dom_assertion",
                        flow="api.compatibility_studio",
                        viewport=viewport,
                        selector="/api/conversation",
                        assertion="API compatibility checks completed before Studio Display browser verification",
                    )
                validate_reader(page, url, viewport, screenshots)
                validate_graph(page, url, viewport, screenshots)
                if viewport == "studio-native":
                    cdp = page.context.new_cdp_session(page)
                    cdp.send("Performance.enable")
                    metrics = {item["name"]: item["value"] for item in cdp.send("Performance.getMetrics")["metrics"]}
                    nodes = page.evaluate("document.querySelectorAll('*').length")
                    heap = metrics.get("JSHeapUsedSize", 0)
                    assert nodes < 9000, f"DOM node budget exceeded: {nodes}"
                    assert heap < 220_000_000, f"JS heap budget exceeded: {heap}"
                    record(
                        page,
                        "perf.large_session",
                        kind="performance",
                        flow="timeline.cdp_metrics",
                        viewport=viewport,
                        selector="Performance.getMetrics",
                        assertion=f"Nodes={nodes}, JSHeapUsedSize={heap}",
                        source="cdp",
                    )
                    validate_opencode_conversation(
                        page,
                        opencode_url,
                        viewport=viewport,
                        screenshot_dir=screenshots,
                    )
            limited_port = free_port()
            limited_base_url = f"http://127.0.0.1:{limited_port}"
            limited_server = start_server(limited_projects_dir, limited_port)
            wait_for_server(limited_base_url)
            limited_sessions = httpx.get(f"{limited_base_url}/api/sessions", timeout=10).json()
            assert len(limited_sessions) == 1
            limited_url = f"{limited_base_url}/conversation/{limited_sessions[0]['id']}"
            for viewport, width, height, _dpr in [
                item for item in VIEWPORTS if item[0] in {"studio-native", "desktop"}
            ]:
                page.set_viewport_size({"width": width, "height": height})
                page.emulate_media(color_scheme="light")
                validate_limited_timeline_alignment(page, limited_url, viewport)
            assert not console_errors, "browser console/page errors:\n" + "\n".join(console_errors)
            assert not network_failures, "browser network failures:\n" + "\n".join(network_failures)
            record(page, "perf.large_session", kind="console_network", flow="browser_health", selector="console/network", assertion="zero console errors and zero failed network requests")
            write_story_report(screenshots / "story-verification.json")
            browser.close()
        print(
            "Browser validation passed. "
            f"Browser: {RUN_METADATA.get('browserChannel')} {RUN_METADATA.get('browserVersion')}. "
            f"Screenshots: {screenshots}"
        )
        return 0
    finally:
        if limited_server and limited_server.poll() is None:
            limited_server.terminate()
            try:
                limited_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                limited_server.kill()
        if server and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
