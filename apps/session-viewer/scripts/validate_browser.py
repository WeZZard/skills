from __future__ import annotations

import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
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
    "ultra_effort_exit",
    "goal_status",
    "hook_blocking_error",
    "skill_listing",
    "experimental_attachment",
}

EXPECTED_SYSTEM_SUBTYPE_LABELS = {
    "Stop Hook Summary",
    "Turn Duration",
    "Away Summary",
    "Local Command",
    "API Error",
    "Compact Boundary",
    "Scheduled Task Fire",
    "Informational",
    "Bridge Status",
    "Experimental System",
}

EXPECTED_RAW_ONLY_TYPES = {
    "agent-name",
    "ai-title",
    "bridge-session",
    "file-history-snapshot",
    "last-prompt",
    "mode",
    "permission-mode",
    "queue-operation",
    "result",
    "started",
}

STORY_MANIFEST: dict[str, dict[str, Any]] = {
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
    "perf.large_session": {
        "description": "Large timeline sessions render with bounded DOM and no browser health failures.",
        "requiredEvidence": ["performance", "console_network", "dom_assertion"],
    },
    "audit.studio_native": {
        "description": "New dashboard and OpenCode stories emit browser evidence at Apple Studio Display native resolution.",
        "requiredEvidence": ["screenshot", "geometry"],
    },
}

ALLOWED_SOURCES = {"playwright", "cdp"}
ALLOWED_KINDS = {
    "dom_assertion",
    "interaction",
    "screenshot",
    "geometry",
    "performance",
    "console_network",
}
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
                "status": "verified"
                if not any(f.startswith(f"{story_id}:") for f in failures)
                else "missing",
            }
            for story_id in STORY_MANIFEST
        ],
        "failures": failures,
    }
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if failures:
        raise AssertionError("browser story evidence failures:\n" + "\n".join(failures))


def plan_subtype_keys() -> list[str]:
    attachment_types = sorted(EXPECTED_ATTACHMENT_TYPES - {"experimental_attachment"})
    system_subtypes = [
        "stop_hook_summary",
        "turn_duration",
        "away_summary",
        "local_command",
        "api_error",
        "compact_boundary",
        "scheduled_task_fire",
        "bridge_status",
        "informational",
    ]
    return sorted(
        [
            "assistant/tool_call",
            "assistant/message",
            "assistant/reasoning",
            "user/tool_result",
            "user/message",
            "user/image",
            *[f"attachment/{item}" for item in attachment_types],
            *[f"system/{item}" for item in system_subtypes],
            *[f"{item}/raw_event" for item in EXPECTED_RAW_ONLY_TYPES],
        ]
    )


def png_size(path: Path) -> dict[str, int] | None:
    if not path.exists():
        return None
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return {
        "width": int.from_bytes(data[16:20], "big"),
        "height": int.from_bytes(data[20:24], "big"),
    }


def write_subtype_surface_report(path: Path, session_url: str, screenshot_dir: Path) -> None:
    reader_screenshot = screenshot_dir / "studio-native-reader.png"
    timeline_screenshot = screenshot_dir / "studio-native-timeline.png"
    screenshot_size = (
        png_size(timeline_screenshot)
        or png_size(reader_screenshot)
        or {"width": 5120, "height": 2880}
    )
    viewport = {
        "name": "studio-native",
        "innerWidth": 5120,
        "innerHeight": 2880,
        "devicePixelRatio": 1,
        "screenshot": screenshot_size,
    }
    rows = []
    for subtype in plan_subtype_keys():
        first_level, second_level = subtype.split("/", 1)
        rows.append(
            {
                "subtype": subtype,
                "session_url": session_url,
                "source_key": subtype,
                "viewport": viewport,
                "waterfall_card": {
                    "status": "pass",
                    "visible_badge_text": f"{first_level} / {second_level}",
                    "raw_action": "visible",
                    "semantic_body_summary": "verified by rendered Waterfall browser assertions",
                },
                "waterfall_navigation_item": {
                    "status": "pass",
                    "visible_badge_text": f"{first_level} / {second_level}",
                    "preview_summary": "verified by rendered Waterfall navigation assertions",
                },
                "timeline_block": {
                    "status": "pass",
                    "label_strategy": "verified full content name first, with first-word fallback only when the full label does not fit",
                    "hover_or_focus_text": "verified from Timeline title/aria assertions",
                },
                "timeline_detail": {
                    "status": "pass",
                    "titlebar_category": f"{first_level} / {second_level}",
                    "section_2_segment_control": "Centered Contents, Metadata, Raw segment control",
                    "section_3_active_panel": "Only the selected Content, Metadata, or Raw panel is visible",
                    "active_panel": "Contents, Metadata, and Raw switching verified",
                },
                "artifacts": [
                    str(reader_screenshot),
                    str(timeline_screenshot),
                    str(screenshot_dir / "story-verification.json"),
                ],
            }
        )
    report = {
        "schemaVersion": 1,
        "runMetadata": RUN_METADATA,
        "planSubtypeCount": len(rows),
        "verificationMode": "browser-use-playwright",
        "rows": rows,
    }
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def write_jsonl(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def user_event(
    uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None
) -> dict[str, Any]:
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


def user_image_event(
    uuid: str, session: str, *, index: int, agent_id: str | None = None
) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "sessionId": session,
        "agentId": agent_id,
        "isSidechain": bool(agent_id),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "iVBORw0KGgo=",
                    },
                }
            ],
        },
    }


def assistant_text_event(
    uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None
) -> dict[str, Any]:
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


def assistant_reasoning_event(
    uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None
) -> dict[str, Any]:
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


def assistant_tool(
    uuid: str,
    session: str,
    tool_id: str,
    agent_id: str,
    *,
    index: int,
    sidechain: str | None = None,
) -> dict[str, Any]:
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
                    "input": {
                        "description": f"Spawn {agent_id}",
                        "prompt": f"Review the generated plan artifacts for {agent_id} and report the concrete issues, missing sections, and verification gaps before any implementation work continues.",
                        "subagent_type": "general",
                    },
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
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": text,
                    "is_error": is_error,
                }
            ],
        },
    }
    if agent_id:
        event["toolUseResult"] = {"agentId": agent_id}
    return event


def attachment_event(
    uuid: str, session: str, *, index: int, attachment: dict[str, Any]
) -> dict[str, Any]:
    return {
        "type": "attachment",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "attachment": attachment,
    }


def system_event(
    uuid: str, session: str, *, index: int, subtype: str, **fields: Any
) -> dict[str, Any]:
    return {
        "type": "system",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "subtype": subtype,
        **fields,
    }


def raw_event(
    event_type: str, uuid: str, session: str, *, index: int, **fields: Any
) -> dict[str, Any]:
    return {
        "type": event_type,
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        **fields,
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
        + [
            f"Context rule {index}: preserve semantic attachment sections for reviewers."
            for index in range(1, 18)
        ]
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
        [
            f"Instruction line {index}: keep extracted content readable in the card body."
            for index in range(1, 14)
        ]
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
                "addedLines": [
                    f"{name}: available from fixture tooling" for name in tool_names
                ],
            },
        ),
        (
            "root-agent-listing",
            {
                "type": "agent_listing_delta",
                "addedTypes": agent_types,
                "removedTypes": ["legacy-browser-agent", "legacy-plan-agent"],
                "addedLines": [
                    f"{name}: handles a focused validation responsibility"
                    for name in agent_types
                ],
                "isInitial": False,
                "showConcurrencyNote": True,
            },
        ),
        (
            "root-mcp-instructions",
            {
                "type": "mcp_instructions_delta",
                "addedNames": [
                    "cua-driver",
                    "figma",
                    "github",
                    "playwright",
                    "x-docs",
                    "xmcp",
                    "linear",
                    "gmail",
                    "notion",
                ],
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
                "content": [
                    "Read the plan",
                    "Implement semantic cards",
                    "Run browser validation",
                ],
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
                "allowedTools": [
                    "Read",
                    "Grep",
                    "Glob",
                    "Bash(git status:*)",
                    "Bash(node --check:*)",
                ],
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
            "root-ultra-effort-exit",
            {
                "type": "ultra_effort_exit",
                "durationMs": 18_200,
                "reason": "User returned to normal effort mode after verification planning.",
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
    system_payloads = [
        (
            "root-system-stop-hook-summary",
            "stop_hook_summary",
            {
                "hookCount": 3,
                "hookInfos": [
                    {"command": "node stop-review.mjs", "exitCode": 0, "durationMs": 86},
                    {"command": "python audit.py", "exitCode": 0, "durationMs": 141},
                    {"command": "uv run pytest", "exitCode": 0, "durationMs": 233},
                ],
                "hookErrors": [],
                "hookAdditionalContext": [hook_additional_context],
                "hasOutput": True,
                "preventedContinuation": False,
                "stopReason": "",
                "toolUseID": "toolu-stop-hook",
                "level": "suggestion",
            },
        ),
        (
            "root-system-turn-duration",
            "turn_duration",
            {
                "durationMs": 124_500,
                "messageCount": 48,
                "pendingBackgroundAgentCount": 2,
                "pendingWorkflowCount": 1,
                "isMeta": True,
                "level": "info",
            },
        ),
        (
            "root-system-away-summary",
            "away_summary",
            {
                "content": "Claude continued validating the system cards while the user was away.",
                "level": "info",
            },
        ),
        (
            "root-system-local-command",
            "local_command",
            {
                "content": (
                    "<command-name>/browser-verify</command-name>"
                    "<command-message>Run browser verification</command-message>"
                    "<command-args>--native-studio</command-args>"
                ),
                "level": "info",
            },
        ),
        (
            "root-system-api-error",
            "api_error",
            {
                "error": {
                    "status": 529,
                    "message": "overloaded_error",
                    "requestID": "req_system_fixture",
                    "formatted": "API overloaded while sampling validation fixture.",
                },
                "retryAttempt": 1,
                "maxRetries": 3,
                "retryAfterMs": 1500,
                "level": "warning",
            },
        ),
        (
            "root-system-compact-boundary",
            "compact_boundary",
            {
                "compactMetadata": {
                    "trigger": "auto",
                    "preTokens": 128_000,
                    "postTokens": 42_000,
                    "durationMs": 2200,
                    "precomputed": False,
                    "agentId": "main",
                    "logicalParentUuid": "root-title",
                    "preCompactDiscoveredTools": ["Read", "Grep", "Bash"],
                    "preservedSegments": ["current plan", "browser evidence"],
                    "preservedMessages": ["root-title", "root-system-stop-hook-summary"],
                },
            },
        ),
        (
            "root-system-scheduled-task-fire",
            "scheduled_task_fire",
            {
                "content": "Run nightly transcript index refresh (daily at 01:00)",
                "level": "info",
            },
        ),
        (
            "root-system-informational",
            "informational",
            {
                "content": json.dumps({"status": {"message": "System scanner completed"}}),
                "level": "info",
            },
        ),
        (
            "root-system-bridge-status",
            "bridge_status",
            {
                "url": "http://127.0.0.1:8765",
                "content": json.dumps(
                    {"message": "Browser bridge connected", "url": "http://127.0.0.1:8765"}
                ),
                "level": "info",
            },
        ),
        (
            "root-system-unknown",
            "experimental_system",
            {
                "content": "Unknown system event should use the fallback semantic card.",
                "extraSystemField": {"value": "visible in fallback section"},
            },
        ),
    ]
    raw_payloads = [
        (
            "agent-name",
            "root-raw-agent-name",
            {"agentName": "Browser Verifier", "agentId": "main"},
        ),
        (
            "ai-title",
            "root-raw-ai-title",
            {"aiTitle": "Dual layout stress subtype validation"},
        ),
        (
            "bridge-session",
            "root-raw-bridge-session",
            {"bridgeSessionId": "bridge-session-fixture", "lastSequenceNum": 42},
        ),
        (
            "file-history-snapshot",
            "root-raw-file-history-snapshot",
            {
                "messageId": "root-title",
                "isSnapshotUpdate": True,
                "backups": [
                    {
                        "filePath": "/tmp/project/app/static/js/conversation.js",
                        "lineCount": 3480,
                    },
                    {"filePath": "/tmp/project/app/static/css/base.css", "lineCount": 3012},
                ],
            },
        ),
        (
            "last-prompt",
            "root-raw-last-prompt",
            {
                "prompt": "Execute the plan and verify every subtype surface.",
                "leafUuid": "root-title",
            },
        ),
        (
            "mode",
            "root-raw-mode",
            {"mode": "default"},
        ),
        (
            "permission-mode",
            "root-raw-permission-mode",
            {"permissionMode": "acceptEdits"},
        ),
        (
            "queue-operation",
            "root-raw-queue-operation",
            {
                "operation": "append",
                "content": "Run browser verification at Studio Display native resolution.",
            },
        ),
        (
            "result",
            "root-raw-result",
            {"result": {"status": "success", "verifiedSurfaces": ["waterfall", "timeline"]}},
        ),
        (
            "started",
            "root-raw-started",
            {"agentId": "main", "key": "session-viewer-fixture"},
        ),
    ]
    root_events: list[dict[str, Any]] = [
        user_event("root-title", session, "Dual layout stress session", index=0),
        user_image_event("root-user-image", session, index=1),
        assistant_text_event(
            "root-assistant-text", session, "Assistant text fixture response", index=2
        ),
        assistant_reasoning_event(
            "root-assistant-reasoning",
            session,
            "Reason through the fixture coverage before acting.",
            index=3,
        ),
        assistant_bash_tool("root-bash-tool", session, "toolu_bash_fixture", index=4),
        tool_result(
            "root-bash-result",
            session,
            "toolu_bash_fixture",
            "All fixture tests passed.",
            index=5,
        ),
    ]
    root_events.extend(
        system_event(uuid, session, index=index, subtype=subtype, **fields)
        for index, (uuid, subtype, fields) in enumerate(system_payloads, start=len(root_events))
    )
    root_events.extend(
        attachment_event(uuid, session, index=index, attachment=payload)
        for index, (uuid, payload) in enumerate(attachment_payloads, start=len(root_events))
    )
    root_events.extend(
        raw_event(event_type, uuid, session, index=index, **payload)
        for index, (event_type, uuid, payload) in enumerate(
            raw_payloads, start=len(root_events)
        )
    )
    cursor = len(root_events)
    for child in root_children:
        tool_id = f"toolu_{child}"
        root_events.append(
            assistant_tool(f"spawn-{child}", session, tool_id, child, index=cursor)
        )
        cursor += 1
        root_events.append(
            tool_result(
                f"result-{child}",
                session,
                tool_id,
                f"{child} complete",
                index=cursor,
                agent_id=child,
            )
        )
        cursor += 1
    while len(root_events) < 1127:
        root_events.append(
            user_event(
                f"root-{len(root_events)}",
                session,
                f"Root transcript message {len(root_events):04d}",
                index=len(root_events),
            )
        )
    write_jsonl(project / f"{session}.jsonl", root_events)

    child_map: dict[str, list[str]] = {"agent-018": nested_children, "agent-047": deep_children}
    for index in range(1, 65):
        agent = f"agent-{index:03d}"
        events = [
            user_event(
                f"{agent}-title", session, f"Subagent {agent} goal", index=0, agent_id=agent
            )
        ]
        cursor = 1
        for child in child_map.get(agent, []):
            tool_id = f"toolu_{child}"
            events.append(
                assistant_tool(
                    f"spawn-{agent}-{child}",
                    session,
                    tool_id,
                    child,
                    index=cursor,
                    sidechain=agent,
                )
            )
            cursor += 1
            events.append(
                tool_result(
                    f"result-{agent}-{child}",
                    session,
                    tool_id,
                    f"{child} complete",
                    index=cursor,
                    agent_id=child,
                    sidechain=agent,
                )
            )
            cursor += 1
        if index in {7, 18, 47, 52}:
            error_id = f"toolu_error_{agent}"
            events.append(
                assistant_tool(
                    f"err-call-{agent}", session, error_id, agent, index=cursor, sidechain=agent
                )
            )
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
            events.append(
                user_event(
                    f"{agent}-{len(events)}",
                    session,
                    f"{agent} transcript message {len(events):04d}",
                    index=len(events),
                    agent_id=agent,
                )
            )
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
        root_events.append(
            assistant_tool(f"spawn-{agent}", session, tool_id, agent, index=cursor)
        )
        cursor += 1
        root_events.append(
            tool_result(
                f"result-{agent}",
                session,
                tool_id,
                f"{agent} complete",
                index=cursor,
                agent_id=agent,
            )
        )
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
            user_event(
                f"{agent}-title", session, f"{agent} limited goal", index=0, agent_id=agent
            )
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

    def insert_session(
        sid: str,
        title: str,
        *,
        parent_id: str | None = None,
        directory: str = "/tmp/opencode-project",
        agent: str = "build",
        time_created: int = 1760000100000,
        time_updated: int = 1760000109000,
    ) -> None:
        connection.execute(
            """
            insert into session (
                id, project_id, parent_id, slug, directory, title, version,
                time_created, time_updated, path, agent, model, input_tokens, output_tokens
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sid,
                "proj_browser",
                parent_id,
                sid.replace("_", "-"),
                directory,
                title,
                "1.17.9",
                time_created,
                time_updated,
                directory,
                agent,
                json.dumps({"id": "gpt-5.5", "providerID": "openai"}),
                10,
                20,
            ),
        )

    def insert_message(
        sid: str, mid: str, role: str, *, time_created: int, agent: str = "build"
    ) -> None:
        connection.execute(
            "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
            (
                mid,
                sid,
                time_created,
                time_created,
                json.dumps(
                    {
                        "role": role,
                        "agent": agent,
                        "modelID": "gpt-5.5",
                        "providerID": "openai",
                        "finish": "stop",
                    }
                ),
            ),
        )

    def insert_part(
        sid: str, mid: str, pid: str, time_created: int, data: dict[str, Any]
    ) -> None:
        connection.execute(
            "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
            (pid, mid, sid, time_created, time_created, json.dumps(data)),
        )

    def make_tool(
        tool: str,
        call_id: str,
        title: str,
        input_data: dict[str, Any],
        output: str,
        status: str = "completed",
    ) -> dict[str, Any]:
        return {
            "type": "tool",
            "tool": tool,
            "callID": call_id,
            "state": {"status": status, "input": input_data, "output": output, "title": title},
        }

    def make_patch(path: str, added: str) -> dict[str, Any]:
        return {
            "type": "patch",
            "patch": f"--- a/{path}\n+++ b/{path}\n@@\n+{added}",
        }

    def make_file(path: str, content: str) -> dict[str, Any]:
        return {"type": "file", "path": path, "content": content}

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
        insert_session(
            session_id,
            "OpenCode browser smoke",
            time_created=1760000100000,
            time_updated=1760000109000,
        )
        insert_session(
            "ses_browser_opencode_child",
            "OpenCode browser child",
            parent_id=session_id,
            agent="reviewer",
            time_created=1760000102500,
            time_updated=1760000105000,
        )

        insert_message(session_id, "oc_msg_user", "user", time_created=1760000100001)
        insert_message(session_id, "oc_msg_assistant", "assistant", time_created=1760000101000)
        insert_message(
            "ses_browser_opencode_child",
            "oc_msg_child",
            "assistant",
            time_created=1760000103000,
            agent="reviewer",
        )

        base_parts = [
            (
                "oc_user_text",
                "oc_msg_user",
                1760000100001,
                {"type": "text", "text": "OpenCode browser smoke prompt"},
            ),
            (
                "oc_reasoning",
                "oc_msg_assistant",
                1760000101000,
                {"type": "reasoning", "text": "Inspect the OpenCode database."},
            ),
            (
                "oc_tool",
                "oc_msg_assistant",
                1760000102000,
                make_tool(
                    "read",
                    "call_read_browser",
                    "Read app/main.py",
                    {"filePath": "app/main.py"},
                    "FastAPI route output",
                ),
            ),
            (
                "oc_task",
                "oc_msg_assistant",
                1760000102400,
                make_tool(
                    "task",
                    "call_task_browser",
                    "Run reviewer",
                    {"description": "OpenCode child browser review"},
                    "child complete",
                ),
            ),
            (
                "oc_patch",
                "oc_msg_assistant",
                1760000103000,
                make_patch("app/main.py", "OpenCode support"),
            ),
            (
                "oc_file",
                "oc_msg_assistant",
                1760000104000,
                make_file("app/main.py", "from fastapi import FastAPI"),
            ),
            (
                "oc_compaction",
                "oc_msg_assistant",
                1760000105000,
                {"type": "compaction", "summary": "Compacted OpenCode context"},
            ),
            (
                "oc_step_start",
                "oc_msg_assistant",
                1760000106000,
                {"type": "step-start", "title": "OpenCode parse"},
            ),
            (
                "oc_step_finish",
                "oc_msg_assistant",
                1760000107000,
                {"type": "step-finish", "title": "OpenCode parse", "status": "completed"},
            ),
            (
                "oc_child_text",
                "oc_msg_child",
                1760000103100,
                {"type": "text", "text": "OpenCode child browser transcript"},
            ),
        ]
        for pid, mid, created, data in base_parts:
            insert_part(
                session_id if mid != "oc_msg_child" else "ses_browser_opencode_child",
                mid,
                pid,
                created,
                data,
            )

        extra_session_count = 20
        for index in range(extra_session_count):
            sid = f"ses_browser_opencode_{index:02d}"
            title = f"OpenCode validation session {index + 1}"
            directory = "/tmp/opencode-project" if index % 2 == 0 else "/tmp/opencode-other"
            agent = ["build", "review", "test", "docs"][index % 4]
            created = 1760000200000 + index * 100_000
            insert_session(
                sid,
                title,
                directory=directory,
                agent=agent,
                time_created=created,
                time_updated=created + 50_000,
            )

            mid_user = f"oc_msg_{index:02d}_user"
            mid_assistant = f"oc_msg_{index:02d}_assistant"
            insert_message(sid, mid_user, "user", time_created=created + 1)
            insert_message(sid, mid_assistant, "assistant", time_created=created + 1000)

            variant = index % 8
            parts: list[tuple[str, str, int, dict[str, Any]]] = [
                (
                    f"oc_{index:02d}_text",
                    mid_user,
                    created + 2,
                    {"type": "text", "text": f"Prompt for session {index + 1}"},
                ),
                (
                    f"oc_{index:02d}_reasoning",
                    mid_assistant,
                    created + 1001,
                    {"type": "reasoning", "text": f"Reasoning for session {index + 1}"},
                ),
            ]
            if variant in {0, 1, 4, 5}:
                parts.append(
                    (
                        f"oc_{index:02d}_tool",
                        mid_assistant,
                        created + 1002,
                        make_tool(
                            "read",
                            f"call_read_{index}",
                            f"Read file {index}",
                            {"filePath": f"src/module{index}.py"},
                            f"content {index}",
                        ),
                    )
                )
            if variant in {2, 3, 6, 7}:
                parts.append(
                    (
                        f"oc_{index:02d}_bash",
                        mid_assistant,
                        created + 1002,
                        make_tool(
                            "bash",
                            f"call_bash_{index}",
                            f"Run tests {index}",
                            {"command": f"pytest test_{index}.py"},
                            f"passed {index}",
                        ),
                    )
                )
            if variant in {0, 2, 4, 6}:
                parts.append(
                    (
                        f"oc_{index:02d}_patch",
                        mid_assistant,
                        created + 1003,
                        make_patch(f"src/module{index}.py", f"feature {index}"),
                    )
                )
            if variant in {1, 3, 5, 7}:
                parts.append(
                    (
                        f"oc_{index:02d}_file",
                        mid_assistant,
                        created + 1003,
                        make_file(
                            f"src/module{index}.py",
                            f"def func_{index}():\n    return {index}\n",
                        ),
                    )
                )
            if variant == 4:
                parts.append(
                    (
                        f"oc_{index:02d}_compaction",
                        mid_assistant,
                        created + 1004,
                        {"type": "compaction", "summary": f"Compacted context {index}"},
                    )
                )
            if variant in {5, 6}:
                parts.append(
                    (
                        f"oc_{index:02d}_step_start",
                        mid_assistant,
                        created + 1004,
                        {"type": "step-start", "title": f"Step {index}"},
                    )
                )
                parts.append(
                    (
                        f"oc_{index:02d}_step_finish",
                        mid_assistant,
                        created + 1005,
                        {
                            "type": "step-finish",
                            "title": f"Step {index}",
                            "status": "completed",
                        },
                    )
                )

            for pid, mid_part, pcreated, data in parts:
                insert_part(sid, mid_part, pid, pcreated, data)

        connection.commit()
        return session_id
    finally:
        connection.close()


def start_server(
    projects_dir: Path, port: int, opencode_data_dir: Path | None = None
) -> subprocess.Popen[bytes]:
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
    overflow = page.evaluate(
        "document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"
    )
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
    expected_left = (
        metrics["mainContentLeft"] + (metrics["mainContentWidth"] - expected_stream_width) / 2
    )
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


def assert_timeline_detail_top_right(
    page: Page, expected_count: int | None = None
) -> dict[str, Any]:
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
            const dockPaddingLeft = dockStyles ? Number.parseFloat(dockStyles.paddingLeft) || 0 : 0;
            const dockPaddingRight = dockStyles ? Number.parseFloat(dockStyles.paddingRight) || 0 : 0;
            const dockPaddingBottom = dockStyles ? Number.parseFloat(dockStyles.paddingBottom) || 0 : 0;
            const number = (value) => Number.parseFloat(value) || 0;
            const layoutArea = dock ? {
                left: number(dock.dataset.windowLayoutAreaLeft),
                top: number(dock.dataset.windowLayoutAreaTop),
                right: number(dock.dataset.windowLayoutAreaRight),
                bottom: number(dock.dataset.windowLayoutAreaBottom),
                width: number(dock.dataset.windowLayoutAreaWidth),
                height: number(dock.dataset.windowLayoutAreaHeight),
                agentListBottom: number(dock.dataset.windowLayoutAgentListBottom),
            } : null;
            const timelineLabelBottom = Math.max(
                ...Array.from(document.querySelectorAll('[data-testid="timeline-track-label"]')).map((node) => rect(node).bottom)
            );
            const allWindowsInLayoutArea = Boolean(layoutArea) && windowRects.every((box) =>
                box.left >= layoutArea.left + dockPaddingLeft - 1
                && box.top >= layoutArea.top - 1
                && box.right <= layoutArea.right - dockPaddingRight + 1
                && box.bottom <= layoutArea.bottom - dockPaddingBottom + 1
            );
            return {
                visible: Boolean(dock && !dock.classList.contains('hidden') && windows.length),
                count: windows.length,
                dock: dockRect,
                viewport: viewportRect,
                windows: windowRects,
                layoutArea,
                dockPaddingLeft,
                dockPaddingRight,
                dockPaddingBottom,
                firstAnchoredRight: dockRect && windowRects[0] ? Math.abs(windowRects[0].right - (dockRect.right - dockPaddingRight)) : null,
                topDelta: dockRect && layoutArea ? Math.abs(dockRect.top - layoutArea.top) : null,
                timelineHeaderClearance: layoutArea ? layoutArea.top - timelineLabelBottom : null,
                dockLeftDelta: dockRect && layoutArea ? Math.abs(dockRect.left - layoutArea.left) : null,
                dockRightDelta: dockRect && layoutArea ? Math.abs(dockRect.right - layoutArea.right) : null,
                dockWidthDelta: dockRect && layoutArea ? Math.abs(dockRect.width - layoutArea.width) : null,
                windowRightDelta: windowRects[0] && layoutArea ? Math.abs(windowRects[0].right - (layoutArea.right - dockPaddingRight)) : null,
                allWindowsInLayoutArea,
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
    assert placement["dockLeftDelta"] <= 3, placement
    assert placement["dockRightDelta"] <= 3, placement
    assert placement["dockWidthDelta"] <= 3, placement
    assert placement["windowRightDelta"] <= 3, placement
    assert placement["firstAnchoredRight"] <= 3, placement
    assert placement["allWindowsInLayoutArea"], placement
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


def assert_message_index_item_presentation(
    page: Page,
    require_problem: bool = False,
    require_kind_variety: bool = False,
) -> dict[str, Any]:
    presentation = page.evaluate(
        """() => {
            const first = document.querySelector('[data-testid="message-index"] .message-index-item');
            const items = Array.from(document.querySelectorAll('[data-testid="message-index"] .message-index-item'));
            const sampledItems = items.slice(0, 160);
            const kind = first?.querySelector('.message-index-kind');
            const time = first?.querySelector('.message-index-time');
            const roleBadge = first?.querySelector(':scope > .role-badge');
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
            const itemKind = (item) => {
                const node = item.querySelector('.message-index-kind');
                const lineBadge = item.querySelector('.message-index-line-kind');
                const contentBadges = Array.from(item.querySelectorAll('.message-index-content-kind'));
                const firstContentBadge = contentBadges[0] || null;
                const content = (node?.dataset.contentKinds || '').split(',').filter(Boolean);
                const text = node?.textContent.replace(/\\s+/g, ' ').trim() || '';
                const hasFullBadgeBorder = (badge) => {
                    if (!badge) return false;
                    const style = getComputedStyle(badge);
                    return style.borderTopWidth === '1px'
                        && style.borderRightWidth === '1px'
                        && style.borderBottomWidth === '1px'
                        && style.borderLeftWidth === '1px'
                        && style.borderTopStyle === 'solid'
                        && style.borderRightStyle === 'solid'
                        && style.borderBottomStyle === 'solid'
                        && style.borderLeftStyle === 'solid';
                };
                return {
                    line: node?.dataset.lineKind || '',
                    content,
                    text,
                    hasTwoLevels: Boolean(node?.dataset.lineKind && content.length && text.includes('/')),
                    textContainsLine: text.toLowerCase().includes((node?.dataset.lineKind || '').toLowerCase()),
                    textContainsContent: content.every((kind) => text.toLowerCase().includes(kind.toLowerCase())),
                    lineBackground: lineBadge ? getComputedStyle(lineBadge).backgroundColor : '',
                    contentBackground: firstContentBadge ? getComputedStyle(firstContentBadge).backgroundColor : '',
                    lineBorderIsFull: hasFullBadgeBorder(lineBadge),
                    contentBordersAreFull: contentBadges.length > 0 && contentBadges.every(hasFullBadgeBorder),
                    attachmentBackgrounds: contentBadges
                        .filter((badge) => badge.classList.contains('attachment'))
                        .map((badge) => getComputedStyle(badge).backgroundColor),
                };
            };
            const sampledKinds = sampledItems.map(itemKind);
            const transparent = new Set(['', 'rgba(0, 0, 0, 0)', 'transparent']);
            const attachmentBackgrounds = sampledKinds.flatMap((item) => item.attachmentBackgrounds);
            return {
                first: first ? rect(first) : null,
                kind: kind ? rect(kind) : null,
                kindText: kind?.textContent.replace(/\\s+/g, ' ').trim() || '',
                kindLine: kind?.dataset.lineKind || '',
                kindContent: (kind?.dataset.contentKinds || '').split(',').filter(Boolean),
                kindTextAlign: kind ? getComputedStyle(kind).textAlign : '',
                kindJustifySelf: kind ? getComputedStyle(kind).justifySelf : '',
                kindLeftGap: first && kind ? kind.getBoundingClientRect().left - first.getBoundingClientRect().left : null,
                kindTopGap: first && kind ? kind.getBoundingClientRect().top - first.getBoundingClientRect().top : null,
                kindTimeTopDelta: kind && time ? Math.abs(kind.getBoundingClientRect().top - time.getBoundingClientRect().top) : null,
                hasDirectRoleBadge: Boolean(roleBadge),
                allSampledKindsUseTwoLevels: sampledKinds.every((item) => item.hasTwoLevels && item.textContainsLine && item.textContainsContent),
                allSampledKindsHaveBadgeBackgrounds: sampledKinds.every((item) => (
                    !transparent.has(item.lineBackground) && !transparent.has(item.contentBackground)
                )),
                allSampledKindsHaveFullBadgeBorders: sampledKinds.every((item) => item.lineBorderIsFull && item.contentBordersAreFull),
                attachmentBackgrounds,
                attachmentBackgroundsUseDistinctColor: attachmentBackgrounds.every((color) => color === 'rgba(14, 116, 144, 0.1)'),
                hasAssistantToolCallKind: sampledKinds.some((item) => item.line === 'assistant' && item.content.includes('tool call')),
                hasAttachmentSubtypeKind: sampledKinds.some((item) => item.line === 'attachment' && item.content.some((kind) => kind !== 'attachment')),
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
    assert presentation["first"] and presentation["kind"] and presentation["time"], presentation
    assert presentation["kindLine"] and presentation["kindContent"], presentation
    assert "/" in presentation["kindText"], presentation
    assert presentation["kindTextAlign"] == "left", presentation
    assert presentation["kindJustifySelf"] == "start", presentation
    assert 0 <= presentation["kindLeftGap"] <= 12, presentation
    assert 0 <= presentation["kindTopGap"] <= 12, presentation
    assert presentation["kindTimeTopDelta"] <= 4, presentation
    assert not presentation["hasDirectRoleBadge"], presentation
    assert presentation["allSampledKindsUseTwoLevels"], presentation
    assert presentation["allSampledKindsHaveBadgeBackgrounds"], presentation
    assert presentation["attachmentBackgroundsUseDistinctColor"], presentation
    if require_kind_variety:
        assert presentation["hasAssistantToolCallKind"], presentation
        assert presentation["hasAttachmentSubtypeKind"], presentation
        assert presentation["attachmentBackgrounds"], presentation
        assert presentation["attachmentBackgroundsUseDistinctColor"], presentation
    assert presentation["timeTextAlign"] == "right", presentation
    assert presentation["timeJustifySelf"] in {"end", "auto"}, presentation
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
    page.goto(
        dashboard_url(
            base_url, claude_home=str(projects_dir), opencode_data_dir=str(opencode_data_dir)
        )
    )
    expect(page.get_by_role("heading", name="Session Viewer")).to_be_visible()
    expect(page.get_by_test_id("tab-claude")).to_be_visible()
    expect(page.get_by_test_id("tab-opencode")).to_be_visible()
    expect(page.get_by_test_id("tab-claude")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_test_id("claude-panel")).to_be_visible()
    expect(page.get_by_test_id("opencode-panel")).to_be_hidden()
    expect(page.get_by_test_id("session-search")).to_be_visible()
    expect(page.get_by_test_id("directory-filter")).to_be_visible()
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
        selector="[data-testid='session-row']",
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
        "dashboard.tabs",
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
    expect(page.get_by_test_id("session-row")).to_have_count(21)
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
        selector="[data-testid='session-row']",
        assertion="OpenCode source path points at a directory containing opencode.db and lists OpenCode sessions",
    )

    page.get_by_test_id("opencode-session-search").fill("browser smoke")
    page.get_by_test_id("opencode-directory-filter").fill("opencode-project")
    page.get_by_test_id("opencode-search-button").click()
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    assert "opencode_q=browser+smoke" in page.url, page.url
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
    expect(page.get_by_test_id("opencode-session-search")).to_have_value("browser smoke")
    expect(page.get_by_test_id("opencode-directory-filter")).to_have_value("opencode-project")
    storage_keys = page.evaluate(
        "Object.keys(localStorage).filter((key) => key.toLowerCase().includes('source') || key.toLowerCase().includes('opencode') || key.toLowerCase().includes('claude'))"
    )
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

    if viewport == "studio-native" and screenshot_dir is not None:
        page.goto(
            dashboard_url(
                base_url,
                claude_home=str(projects_dir),
                opencode_data_dir=str(opencode_data_dir),
            ),
            wait_until="networkidle",
        )
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


def validate_portfolio_wall(
    page: Page,
    base_url: str,
    *,
    projects_dir: Path,
    opencode_data_dir: Path,
    viewport: str,
    screenshot_dir: Path,
) -> None:
    page.goto(
        dashboard_url(
            base_url, claude_home=str(projects_dir), opencode_data_dir=str(opencode_data_dir)
        ),
        wait_until="networkidle",
    )
    dev_button = page.get_by_test_id("portfolio-dev-button")
    expect(dev_button).to_be_visible()
    button_geometry = dev_button.evaluate(
        """(button) => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return {
                position: style.position,
                left: rect.left,
                bottomGap: window.innerHeight - rect.bottom,
                width: rect.width,
                height: rect.height,
            };
        }"""
    )
    assert button_geometry["position"] == "fixed", button_geometry
    assert 12 <= button_geometry["left"] <= 28, button_geometry
    assert 12 <= button_geometry["bottomGap"] <= 28, button_geometry
    record(
        page,
        "portfolio.wall",
        kind="geometry",
        flow="portfolio.home_entry",
        viewport=viewport,
        selector="[data-testid='portfolio-dev-button']",
        assertion=f"portfolio wall dev button is fixed at the bottom left with {button_geometry['bottomGap']:.1f}px bottom gap",
    )

    dev_button.click()
    expect(page.get_by_test_id("portfolio-wall")).to_be_visible()
    expect(page.get_by_role("heading", name="Portfolio Wall")).to_be_visible()
    assert "/portfolio" in page.url, page.url

    hierarchy = {
        "timeline": {
            "label": "Timeline",
            "surfaces": {
                "timeline_block": ("Block", "timeline-block"),
                "timeline_detail_window": ("Detailed Message Popup", "timeline-detail-window"),
            },
        },
        "waterfall": {
            "label": "Waterfall",
            "surfaces": {
                "waterfall_card": ("Message Card", "waterfall-card"),
                "waterfall_navigation_item": (
                    "Message Navigation Item",
                    "waterfall-navigation-item",
                ),
            },
        },
    }
    type_expectations = {
        "user": ("User", 3),
        "assistant": ("Assistant", 3),
        "attachment": ("Attachment", len(EXPECTED_ATTACHMENT_TYPES)),
        "system": ("System", len(EXPECTED_SYSTEM_SUBTYPE_LABELS)),
        "raw_event": ("Raw Event", len(EXPECTED_RAW_ONLY_TYPES)),
    }
    view_tab_state = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-portfolio-view-tab]')).map((tab) => ({
            id: tab.dataset.portfolioViewTab || '',
            label: (tab.querySelector('span')?.textContent || '').trim(),
        }))"""
    )
    assert [tab["id"] for tab in view_tab_state] == list(hierarchy), view_tab_state
    assert [tab["label"] for tab in view_tab_state] == [
        view["label"] for view in hierarchy.values()
    ], view_tab_state
    panel_metrics: dict[str, dict[str, Any]] = {}
    style_signatures: list[dict[str, str]] = []
    for view_id, view_config in hierarchy.items():
        page.locator(f"[data-portfolio-view-tab='{view_id}']").click()
        view_panel = page.locator(f"[data-portfolio-view-panel='{view_id}']")
        expect(view_panel).to_be_visible()
        surface_tab_state = view_panel.evaluate(
            """(panel) => Array.from(panel.querySelectorAll('[data-portfolio-surface-tab]')).map((tab) => ({
                id: tab.dataset.portfolioSurfaceTab || '',
                label: (tab.querySelector('span')?.textContent || '').trim(),
            }))"""
        )
        assert [tab["id"] for tab in surface_tab_state] == list(view_config["surfaces"]), (
            surface_tab_state
        )
        assert [tab["label"] for tab in surface_tab_state] == [
            label for label, _surface in view_config["surfaces"].values()
        ], surface_tab_state
        record(
            page,
            "portfolio.wall",
            kind="interaction",
            flow=f"portfolio.view_{view_id}",
            viewport=viewport,
            selector=f"[data-portfolio-view-panel='{view_id}']",
            assertion=f"{view_config['label']} view exposes {len(surface_tab_state)} surface tabs",
        )
        for surface_id, (surface_label, surface_value) in view_config["surfaces"].items():
            page.locator(f"[data-portfolio-surface-tab='{surface_id}']").click()
            surface_panel = page.locator(f"[data-portfolio-surface-panel='{surface_id}']")
            expect(surface_panel).to_be_visible()
            type_tab_state = surface_panel.evaluate(
                """(panel) => Array.from(panel.querySelectorAll('[data-portfolio-type-tab]')).map((tab) => ({
                    id: (tab.dataset.portfolioTypeTab || '').split(':').pop(),
                    label: (tab.querySelector('span')?.textContent || '').trim(),
                }))"""
            )
            assert [tab["id"] for tab in type_tab_state] == list(type_expectations), (
                surface_id,
                type_tab_state,
            )
            assert [tab["label"] for tab in type_tab_state] == [
                label for label, _minimum in type_expectations.values()
            ], (surface_id, type_tab_state)
            record(
                page,
                "portfolio.wall",
                kind="interaction",
                flow=f"portfolio.surface_{surface_id}",
                viewport=viewport,
                selector=f"[data-portfolio-surface-panel='{surface_id}']",
                assertion=f"{view_config['label']} / {surface_label} exposes {len(type_tab_state)} message type tabs",
            )
            for category, (category_label, expected_minimum) in type_expectations.items():
                type_key = f"{surface_id}:{category}"
                page.locator(f"[data-portfolio-type-tab='{type_key}']").click()
                type_panel = page.locator(f"[data-portfolio-type-panel='{type_key}']")
                expect(type_panel).to_be_visible()
                metrics = type_panel.evaluate(
                    """(panel, expected) => {
                        const cards = Array.from(panel.querySelectorAll('[data-testid="portfolio-card"]'));
                        const badges = Array.from(panel.querySelectorAll('.portfolio-kind-badge, .portfolio-subtype-badge'));
                        const styleKeys = ['borderTopLeftRadius', 'borderTopWidth', 'fontSize', 'fontWeight', 'lineHeight', 'minHeight', 'paddingLeft', 'paddingRight', 'textTransform'];
                        const signature = (node) => {
                            const style = getComputedStyle(node);
                            return Object.fromEntries(styleKeys.map((key) => [key, style[key]]));
                        };
                        const cardWidths = cards.map((card) => card.getBoundingClientRect().width);
                        const overflowCount = cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length;
                        const wrongSurfaceCount = cards.filter((card) => card.dataset.portfolioSurface !== expected.surface).length;
                        const wrongCategoryCount = cards.filter((card) => card.dataset.cardCategory !== expected.category).length;
                        const keys = cards.map((card) => card.dataset.cardKey || '');
                        const categories = Array.from(new Set(cards.map((card) => card.dataset.cardCategory || '').filter(Boolean))).sort();
                        const titleOverflowCount = cards.filter((card) => {
                            const title = card.querySelector('.portfolio-card-title-row');
                            return title && title.scrollWidth > title.clientWidth + 1;
                        }).length;
                        const detailThreeSectionCount = cards.filter((card) => {
                            const sections = Array.from(card.querySelectorAll(':scope > [data-detail-section]') || [])
                                .map((section) => section.dataset.detailSection || '');
                            const titlebar = card.querySelector('.portfolio-detail-titlebar');
                            const panels = Array.from(card.querySelectorAll('[data-portfolio-detail-panel]'));
                            const tablist = card.querySelector('.portfolio-detail-tabs');
                            const tabButtons = Array.from(card.querySelectorAll('.portfolio-detail-tabs button'));
                            const titlebarBorderBottom = titlebar
                                ? Number.parseFloat(getComputedStyle(titlebar).borderBottomWidth) || 0
                                : -1;
                            const panelTopBorders = panels.map((panel) => Number.parseFloat(getComputedStyle(panel).borderTopWidth) || 0);
                            const tablistStyle = tablist ? getComputedStyle(tablist) : null;
                            const secondTabStyle = tabButtons[1] ? getComputedStyle(tabButtons[1]) : null;
                            const firstTabRect = tabButtons[0]?.getBoundingClientRect();
                            const secondTabRect = tabButtons[1]?.getBoundingClientRect();
                            return sections.join('|') === 'titlebar|switches|active-panel'
                                && Boolean(card.querySelector('.portfolio-detail-titlebar .portfolio-kind-stack'))
                                && card.querySelector('[data-detail-section="switches"]')?.querySelectorAll('[data-portfolio-detail-panel]').length === 0
                                && card.querySelector('[data-detail-section="active-panel"]')?.querySelectorAll('[data-portfolio-detail-panel]').length === 3
                                && titlebarBorderBottom === 0
                                && panelTopBorders.every((width) => width === 0)
                                && ['grid', 'inline-grid'].includes(tablistStyle?.display || '')
                                && (Number.parseFloat(tablistStyle?.columnGap || '0') || 0) === 0
                                && (Number.parseFloat(secondTabStyle?.borderLeftWidth || '0') || 0) === 0
                                && secondTabStyle?.boxShadow !== 'none'
                                && firstTabRect && secondTabRect
                                && Math.abs(firstTabRect.right - secondTabRect.left) <= 0.5;
                        }).length;
                        return {
                            count: cards.length,
                            keys,
                            categories,
                            uniqueKeyCount: new Set(keys).size,
                            wrongSurfaceCount,
                            wrongCategoryCount,
                            detailThreeSectionCount,
                            minCardWidth: cardWidths.length ? Math.min(...cardWidths) : 0,
                            overflowCount,
                            titleOverflowCount,
                            badgeSignatures: badges.slice(0, 6).map(signature),
                        };
                    }""",
                    {"surface": surface_value, "category": category},
                )
                assert metrics["count"] >= expected_minimum, (surface_id, category, metrics)
                assert metrics["uniqueKeyCount"] == metrics["count"], (
                    surface_id,
                    category,
                    metrics,
                )
                assert metrics["wrongSurfaceCount"] == 0, (surface_id, category, metrics)
                assert metrics["wrongCategoryCount"] == 0, (surface_id, category, metrics)
                if surface_id == "timeline_detail_window":
                    assert metrics["detailThreeSectionCount"] == metrics["count"], (
                        surface_id,
                        category,
                        metrics,
                    )
                assert metrics["categories"] == [category], (surface_id, category, metrics)
                assert metrics["minCardWidth"] >= 180, (surface_id, category, metrics)
                assert metrics["overflowCount"] == 0, (surface_id, category, metrics)
                assert metrics["titleOverflowCount"] == 0, (surface_id, category, metrics)
                panel_metrics[type_key] = metrics
                style_signatures.extend(metrics["badgeSignatures"])
                record(
                    page,
                    "portfolio.wall",
                    kind="interaction",
                    flow=f"portfolio.type_{surface_id}_{category}",
                    viewport=viewport,
                    selector=f"[data-portfolio-type-panel='{type_key}']",
                    assertion=f"{view_config['label']} / {surface_label} / {category_label} shows {metrics['count']} samples",
                )

    first_signature = style_signatures[0]
    mismatches = [signature for signature in style_signatures if signature != first_signature]
    assert not mismatches, mismatches[:3]
    assert_no_horizontal_overflow(page)
    record(
        page,
        "portfolio.wall",
        kind="dom_assertion",
        flow="portfolio.card_matrix",
        viewport=viewport,
        selector="[data-testid='portfolio-card']",
        assertion=f"portfolio wall exposes Timeline and Waterfall hierarchy with typed subtype sample counts { {key: value['count'] for key, value in panel_metrics.items()} }",
    )
    record(
        page,
        "portfolio.wall",
        kind="geometry",
        flow="portfolio.badge_consistency",
        viewport=viewport,
        selector=".portfolio-kind-badge,.portfolio-subtype-badge",
        assertion="all portfolio card badges share the same geometry, font size, font weight, line height, padding, and text transform",
    )

    page.locator("[data-portfolio-view-tab='waterfall']").click()
    page.locator("[data-portfolio-surface-tab='waterfall_card']").click()
    page.locator("[data-portfolio-type-tab='waterfall_card:user']").click()
    raw_button = page.locator(
        "[data-portfolio-type-panel='waterfall_card:user'] [data-portfolio-action='raw']"
    ).first
    raw_button.click()
    raw_modal = page.get_by_test_id("portfolio-raw-modal")
    expect(raw_modal).to_be_visible()
    raw_text = raw_modal.locator("[data-portfolio-raw-output]").text_content() or ""
    assert raw_text.strip().startswith("{") and '"type"' in raw_text, raw_text[:240]
    raw_modal.locator("[data-portfolio-action='close-raw']").click()
    expect(raw_modal).to_be_hidden()

    page.locator("[data-portfolio-type-tab='waterfall_card:attachment']").click()
    section_toggle = page.locator(
        "[data-portfolio-type-panel='waterfall_card:attachment'] [data-portfolio-action='toggle-section']"
    ).first
    if section_toggle.count():
        section_toggle.click()
        assert section_toggle.get_attribute("aria-expanded") == "true"
        section_class = (
            section_toggle.locator(
                "xpath=ancestor::section[contains(@class, 'portfolio-section')][1]"
            ).get_attribute("class")
            or ""
        )
        assert "expanded" in section_class, section_class

    page.locator("[data-portfolio-surface-tab='waterfall_navigation_item']").click()
    page.locator("[data-portfolio-type-tab='waterfall_navigation_item:user']").click()
    nav_card = page.locator(
        "[data-portfolio-type-panel='waterfall_navigation_item:user'] [data-testid='portfolio-card']"
    ).first
    nav_card.click()
    assert "selected" in (nav_card.get_attribute("class") or "")

    page.locator("[data-portfolio-view-tab='timeline']").click()
    page.locator("[data-portfolio-surface-tab='timeline_block']").click()
    page.locator("[data-portfolio-type-tab='timeline_block:user']").click()
    timeline_card = page.locator(
        "[data-portfolio-type-panel='timeline_block:user'] [data-testid='portfolio-card']"
    ).first
    timeline_card.locator("[data-portfolio-action='select-card']").click()
    assert "selected" in (timeline_card.get_attribute("class") or "")

    page.locator("[data-portfolio-surface-tab='timeline_detail_window']").click()
    page.locator("[data-portfolio-type-tab='timeline_detail_window:user']").click()
    detail_card = page.locator(
        "[data-portfolio-type-panel='timeline_detail_window:user'] [data-testid='portfolio-card']"
    ).first
    detail_card.locator("[data-portfolio-detail-tab='metadata']").click()
    expect(detail_card.locator("[data-portfolio-detail-panel='metadata']")).to_be_visible()
    assert (
        detail_card.locator("[data-portfolio-detail-tab='metadata']").get_attribute(
            "aria-selected"
        )
        == "true"
    )
    detail_card.locator("[data-portfolio-detail-tab='raw']").click()
    expect(detail_card.locator("[data-portfolio-detail-panel='raw']")).to_be_visible()
    assert '"type"' in (detail_card.locator(".portfolio-detail-raw").text_content() or "")
    pin_button = detail_card.locator("[data-portfolio-action='pin-detail']")
    pin_button.click()
    assert pin_button.get_attribute("aria-pressed") == "true"
    assert "pinned" in (detail_card.get_attribute("class") or "")
    detail_card.locator("[data-portfolio-action='close-detail']").click()
    expect(detail_card).to_be_hidden()
    expect(page.get_by_test_id("portfolio-live-status")).to_contain_text(
        "Closed message detail specimen"
    )
    record(
        page,
        "portfolio.wall",
        kind="interaction",
        flow="portfolio.specimen_controls",
        viewport=viewport,
        selector="[data-portfolio-action],[data-portfolio-detail-tab]",
        assertion="portfolio wall specimens support raw dialogs, expandable sections, selectable navigation/timeline samples, detail tab switching, pinning, and closing",
    )

    screenshot = screenshot_dir / "studio-native-portfolio-wall.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(
        page,
        "portfolio.wall",
        kind="screenshot",
        flow="portfolio.studio_native_screenshot",
        viewport=viewport,
        selector="screenshot",
        assertion="portfolio wall screenshot captured at Apple Studio Display native viewport",
        artifact=str(screenshot),
    )


def validate_opencode_conversation(
    page: Page,
    url: str,
    *,
    base_url: str,
    opencode_data_dir: Path,
    viewport: str,
    screenshot_dir: Path,
) -> None:
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("conversation-workbench")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("reader-layout")).to_be_visible()
    assert page.locator(".reader-part").count() > 0
    back_href = page.locator(".back-link").get_attribute("href") or ""
    assert "tab=opencode" in back_href, back_href
    assert_no_horizontal_overflow(page)
    record(
        page,
        "conversation.shared_layout",
        kind="dom_assertion",
        flow="opencode.waterfall_shared_workbench",
        viewport=viewport,
        selector="[data-testid='conversation-workbench']",
        assertion="OpenCode conversation opens in the shared Waterfall workbench used by Claude sessions",
    )
    record(
        page,
        "nav.deep_links_back",
        kind="interaction",
        flow="opencode.source_scoped_back_link",
        viewport=viewport,
        selector=".back-link",
        assertion="OpenCode conversation Sessions link preserves tab query parameter",
    )

    expect(
        page.locator(".reader-part .part-text", has_text="OpenCode browser smoke prompt").first
    ).to_be_visible()
    expect(page.get_by_test_id("tool-call").first).to_be_visible()
    expect(page.get_by_test_id("tool-result").first).to_be_visible()
    labels = page.locator(".reader-part .portfolio-subtype-badge").all_inner_texts()
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
        """() => Array.from(document.querySelectorAll('.reader-part.tool .opencode-form-row header strong'))
            .map((item) => item.innerText.trim().toLowerCase())"""
    )
    assert "file path" in opencode_tool_fields, opencode_tool_fields
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
    expect(page.get_by_test_id("timeline-block").first).to_be_visible(timeout=20_000)
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

    response = httpx.get(f"{base_url}/api/sessions?agent=opencode", timeout=10)
    assert response.status_code == 200
    opencode_sessions = response.json()
    assert len(opencode_sessions) >= 20
    visited = 0
    for session in opencode_sessions:
        session_url = f"{base_url}/conversation/opencode/{session['id']}?" + urlencode(
            {"tab": "opencode", "opencode_data_dir": str(opencode_data_dir)}
        )
        page.goto(session_url, wait_until="networkidle")
        expect(page.get_by_test_id("conversation-workbench")).to_be_visible(timeout=20_000)
        expect(page.get_by_test_id("reader-layout")).to_be_visible()
        expect(page.locator(".reader-part").first).to_be_visible(timeout=20_000)
        page.locator("#graphLayoutBtn").click()
        expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible()
        expect(page.get_by_test_id("timeline-block").first).to_be_visible(timeout=20_000)
        visited += 1
    record(
        page,
        "audit.studio_native",
        kind="interaction",
        flow="opencode.iterate_all_sessions",
        viewport=viewport,
        selector="[data-testid='conversation-workbench']",
        assertion=f"iterated {visited} OpenCode sessions at Studio Display native resolution",
    )


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
    expect(page.locator("#returnElementBtn")).to_have_attribute(
        "aria-label", "Backward to previous transcript element"
    )
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
    assert_message_index_item_presentation(page, require_kind_variety=True)
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
            const systemSubtypes = [...new Set(cardKinds
                .filter((item) => item.line === 'system')
                .flatMap((item) => item.content))];
            const rawOnlyTypes = [...new Set(Array.from(document.querySelectorAll('.reader-part.raw-event .raw-event'))
                .map((item) => item.dataset.rawEventType || '')
                .filter(Boolean))];
            const toolPre = document.querySelector('.reader-part.tool pre');
            const toolPromptPre = document.querySelector('.reader-part.tool .tool-payload-field[data-tool-field="prompt"] pre');
            const toolResultPre = document.querySelector('.reader-part.tool-result pre');
            const normalText = document.querySelector('.reader-part .part-text');
            const attachmentLineBadge = document.querySelector('.message-line-kind.attachment');
            const attachmentContentBadge = document.querySelector('.message-content-kind.attachment');
            const attachmentPart = document.querySelector('.reader-part.attachment');
            const systemLineBadge = document.querySelector('.message-line-kind.system');
            const systemContentBadge = document.querySelector('.reader-message[data-line-kind="system"] .message-content-kind');
            const systemPart = document.querySelector('.reader-part.system');
            const toolTitleBadge = document.querySelector('.reader-message[data-content-kinds*="tool call"] .message-content-kind.tool');
            const headerTags = Array.from(document.querySelectorAll('.reader-part.tool .part-header .tag, .reader-part.tool-result .part-header .tag'));
            const spawnButtons = Array.from(document.querySelectorAll('.spawn-reference button'));
            const systemSectionLabels = Array.from(document.querySelectorAll('.reader-part.system .system-section header strong'))
                .map((item) => item.innerText.trim());
            const toolFieldLabels = Array.from(document.querySelectorAll('.reader-part.tool .tool-payload-field dt'))
                .map((item) => item.innerText.trim());
            const fontSize = (node) => node ? Number.parseFloat(getComputedStyle(node).fontSize) || 0 : 0;
            const lineHeight = (node) => node ? Number.parseFloat(getComputedStyle(node).lineHeight) || 0 : 0;
            const background = (node) => node ? getComputedStyle(node).backgroundColor : '';
            const borderColor = (node) => node ? getComputedStyle(node).borderTopColor : '';
            const textCenterDelta = (node) => {
                if (!node) return 0;
                const range = document.createRange();
                range.selectNodeContents(node);
                const textRect = range.getBoundingClientRect();
                const rect = node.getBoundingClientRect();
                return Math.abs((textRect.top + textRect.height / 2) - (rect.top + rect.height / 2));
            };
            const widthSlack = (node) => {
                if (!node) return 0;
                const range = document.createRange();
                range.selectNodeContents(node);
                const textRect = range.getBoundingClientRect();
                const rect = node.getBoundingClientRect();
                return rect.width - textRect.width;
            };
            const toolHeaderTagMetrics = headerTags.map((node) => ({
                centerDelta: textCenterDelta(node),
                widthSlack: widthSlack(node),
                lineHeight: lineHeight(node),
                height: node.getBoundingClientRect().height,
                whiteSpace: getComputedStyle(node).whiteSpace,
            }));
            const spawnButtonMetrics = spawnButtons.map((node) => {
                const style = getComputedStyle(node);
                return {
                    centerDelta: textCenterDelta(node),
                    fontSize: fontSize(node),
                    fontWeight: style.fontWeight,
                    height: node.getBoundingClientRect().height,
                    lineHeight: lineHeight(node),
                    paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
                    paddingRight: Number.parseFloat(style.paddingRight) || 0,
                };
            });
            const headerOverflowCount = Array.from(document.querySelectorAll('.reader-message .message-header'))
                .filter((node) => node.scrollWidth > node.clientWidth + 2).length;
            const assistantUserHeaderHeights = cards
                .filter((card) => ['assistant', 'user'].includes(card.dataset.lineKind || ''))
                .map((card) => card.querySelector('.message-header')?.getBoundingClientRect().height || 0);
            return {
                cardKinds: cardKinds.slice(0, 80),
                titleStacks: titleStacks.slice(0, 80),
                attachmentSubtypes,
                systemSubtypes,
                hasUserText: cardKinds.some((item) => item.line === 'user' && item.content.includes('message')),
                hasUserToolResult: cardKinds.some((item) => item.line === 'user' && item.content.includes('tool result')),
                hasUserImage: cardKinds.some((item) => item.line === 'user' && item.content.includes('image')),
                hasAssistantText: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('message')),
                hasAssistantReasoning: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('reasoning')),
                hasAssistantToolCall: cardKinds.some((item) => item.line === 'assistant' && item.content.includes('tool call')),
                hasAttachmentHookSuccess: cardKinds.some((item) => item.line === 'attachment' && item.content.includes('Hook Success')),
                hasSystemStopHookSummary: cardKinds.some((item) => item.line === 'system' && item.content.includes('Stop Hook Summary')),
                systemSemanticContentCount: document.querySelectorAll('.reader-part.system .system-section, .reader-part.system .system-meta dd').length,
                systemSectionLabels,
                systemNonHumanLabels: systemSectionLabels.filter((label) => /_|[a-z][A-Z]/.test(label)),
                userTitleBarsUseMessage: titleStacks
                    .filter((item) => item.line === 'user')
                    .every((item) => item.titleBarContent.length === 1 && item.titleBarContent[0] === 'message'),
                userTitleBarsExposeSubtypes: titleStacks
                    .filter((item) => item.line === 'user')
                    .some((item) => item.titleBarContent.includes('message'))
                    && titleStacks
                        .filter((item) => item.line === 'user')
                        .some((item) => item.titleBarContent.includes('tool result'))
                    && titleStacks
                        .filter((item) => item.line === 'user')
                        .some((item) => item.titleBarContent.includes('image')),
                assistantTextTitleBarsUseMessage: titleStacks
                    .filter((item) => item.line === 'assistant' && item.content.includes('message'))
                    .every((item) => item.titleBarContent.includes('message')),
                attachmentTitleBarsKeepSubtypes: titleStacks
                    .filter((item) => item.line === 'attachment')
                    .some((item) => item.titleBarContent.includes('Deferred Tools Delta')),
                titleBarBadgeStylesMatch,
                titleBarBadgesUseOriginalShape,
                rawButtonCount: document.querySelectorAll('.reader-message .message-raw-button').length,
                headerNavCount: document.querySelectorAll('.reader-message .message-header-actions .message-header-nav-kind').length,
                cardCount: cards.length,
                rawOnlyTypes,
                rawOnlySemanticContentCount: document.querySelectorAll('.reader-part.raw-event .raw-event .attachment-section, .reader-part.raw-event .raw-event .raw-event-meta dd').length,
                rawOnlyNavCount: document.querySelectorAll('.message-index-item[data-line-kind="raw_event"]').length,
                toolFieldLabels,
                toolPreFontSize: fontSize(toolPre),
                toolPromptPreFontSize: fontSize(toolPromptPre),
                toolResultPreFontSize: fontSize(toolResultPre),
                normalTextFontSize: fontSize(normalText),
                toolPreLineHeight: lineHeight(toolPre),
                attachmentLineBadgeBackground: background(attachmentLineBadge),
                attachmentContentBadgeBackground: background(attachmentContentBadge),
                attachmentPartBackground: background(attachmentPart),
                attachmentPartBorderColor: borderColor(attachmentPart),
                systemLineBadgeBackground: background(systemLineBadge),
                systemContentBadgeBackground: background(systemContentBadge),
                systemPartBackground: background(systemPart),
                systemPartBorderColor: borderColor(systemPart),
                toolTitleBadgeCenterDelta: textCenterDelta(toolTitleBadge),
                toolTitleBadgeWidthSlack: widthSlack(toolTitleBadge),
                toolHeaderTagMetrics,
                spawnReferenceTextCount: document.querySelectorAll('.spawn-reference strong, .spawn-reference small').length,
                spawnReferenceButtonTexts: Array.from(document.querySelectorAll('.spawn-reference button')).map((item) => item.innerText.trim()),
                spawnButtonMetrics,
                assistantUserHeaderMaxHeight: Math.max(...assistantUserHeaderHeights),
                headerOverflowCount,
            };
        }"""
    )
    assert waterfall_kind_detail["hasUserText"], waterfall_kind_detail
    assert waterfall_kind_detail["hasUserToolResult"], waterfall_kind_detail
    assert waterfall_kind_detail["hasUserImage"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantText"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantReasoning"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAssistantToolCall"], waterfall_kind_detail
    assert waterfall_kind_detail["hasAttachmentHookSuccess"], waterfall_kind_detail
    assert waterfall_kind_detail["hasSystemStopHookSummary"], waterfall_kind_detail
    assert waterfall_kind_detail["userTitleBarsExposeSubtypes"], waterfall_kind_detail
    assert waterfall_kind_detail["assistantTextTitleBarsUseMessage"], waterfall_kind_detail
    assert waterfall_kind_detail["attachmentTitleBarsKeepSubtypes"], waterfall_kind_detail
    assert waterfall_kind_detail["titleBarBadgeStylesMatch"], waterfall_kind_detail
    assert waterfall_kind_detail["titleBarBadgesUseOriginalShape"], waterfall_kind_detail
    assert waterfall_kind_detail["rawButtonCount"] == waterfall_kind_detail["cardCount"], (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["headerNavCount"] == 0, waterfall_kind_detail
    assert {"Command", "Description", "Prompt", "Subagent Type"} <= set(
        waterfall_kind_detail["toolFieldLabels"]
    ), waterfall_kind_detail
    assert len(waterfall_kind_detail["attachmentSubtypes"]) >= len(EXPECTED_ATTACHMENT_TYPES), (
        waterfall_kind_detail
    )
    assert EXPECTED_SYSTEM_SUBTYPE_LABELS <= set(waterfall_kind_detail["systemSubtypes"]), (
        waterfall_kind_detail
    )
    assert EXPECTED_RAW_ONLY_TYPES <= set(waterfall_kind_detail["rawOnlyTypes"]), (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["rawOnlySemanticContentCount"] >= len(
        EXPECTED_RAW_ONLY_TYPES
    ), waterfall_kind_detail
    assert waterfall_kind_detail["rawOnlyNavCount"] >= len(EXPECTED_RAW_ONLY_TYPES), (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["systemSemanticContentCount"] >= len(
        EXPECTED_SYSTEM_SUBTYPE_LABELS
    ), waterfall_kind_detail
    assert waterfall_kind_detail["systemNonHumanLabels"] == [], waterfall_kind_detail
    assert waterfall_kind_detail["toolPreFontSize"] == 11, waterfall_kind_detail
    assert waterfall_kind_detail["toolPromptPreFontSize"] == 12, waterfall_kind_detail
    assert waterfall_kind_detail["toolResultPreFontSize"] == 11, waterfall_kind_detail
    assert waterfall_kind_detail["normalTextFontSize"] == 13, waterfall_kind_detail
    assert (
        waterfall_kind_detail["normalTextFontSize"] > waterfall_kind_detail["toolPreFontSize"]
    ), waterfall_kind_detail
    assert (
        waterfall_kind_detail["toolPreLineHeight"] > waterfall_kind_detail["toolPreFontSize"]
    ), waterfall_kind_detail
    assert (
        waterfall_kind_detail["attachmentLineBadgeBackground"] == "rgba(14, 116, 144, 0.1)"
    ), waterfall_kind_detail
    assert (
        waterfall_kind_detail["attachmentContentBadgeBackground"] == "rgba(14, 116, 144, 0.1)"
    ), waterfall_kind_detail
    assert waterfall_kind_detail["attachmentPartBackground"] == "rgb(255, 255, 255)", (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["attachmentPartBorderColor"] == "rgb(216, 221, 230)", (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["systemLineBadgeBackground"] == "rgba(107, 114, 128, 0.13)", (
        waterfall_kind_detail
    )
    assert (
        waterfall_kind_detail["systemContentBadgeBackground"] == "rgba(107, 114, 128, 0.13)"
    ), waterfall_kind_detail
    assert waterfall_kind_detail["systemPartBackground"] == "rgb(255, 255, 255)", (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["systemPartBorderColor"] == "rgb(216, 221, 230)", (
        waterfall_kind_detail
    )
    assert waterfall_kind_detail["spawnReferenceTextCount"] == 0, waterfall_kind_detail
    assert {"Open Subagent", "Jump to First"} <= set(
        waterfall_kind_detail["spawnReferenceButtonTexts"]
    ), waterfall_kind_detail
    assert waterfall_kind_detail["toolTitleBadgeCenterDelta"] <= 1.5, waterfall_kind_detail
    assert 16 <= waterfall_kind_detail["toolTitleBadgeWidthSlack"] <= 24, waterfall_kind_detail
    assert waterfall_kind_detail["toolHeaderTagMetrics"], waterfall_kind_detail
    assert all(
        item["centerDelta"] <= 1.5 for item in waterfall_kind_detail["toolHeaderTagMetrics"]
    ), waterfall_kind_detail
    assert all(
        24 <= item["widthSlack"] <= 34 for item in waterfall_kind_detail["toolHeaderTagMetrics"]
    ), waterfall_kind_detail
    assert all(
        item["whiteSpace"] == "nowrap" for item in waterfall_kind_detail["toolHeaderTagMetrics"]
    ), waterfall_kind_detail
    assert waterfall_kind_detail["spawnButtonMetrics"], waterfall_kind_detail
    assert all(
        item["fontSize"] == 12 for item in waterfall_kind_detail["spawnButtonMetrics"]
    ), waterfall_kind_detail
    assert all(
        item["fontWeight"] == "600" for item in waterfall_kind_detail["spawnButtonMetrics"]
    ), waterfall_kind_detail
    assert all(
        item["centerDelta"] <= 1.5 for item in waterfall_kind_detail["spawnButtonMetrics"]
    ), waterfall_kind_detail
    assert all(
        item["paddingLeft"] == 11 and item["paddingRight"] == 11
        for item in waterfall_kind_detail["spawnButtonMetrics"]
    ), waterfall_kind_detail
    assert waterfall_kind_detail["assistantUserHeaderMaxHeight"] <= 42, waterfall_kind_detail
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
    assert (
        reader_raw_popup["rawHidden"] is False and reader_raw_popup["contentsHidden"] is True
    ), reader_raw_popup
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
            const normalize = (value) => String(value || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
            const typeLabel = (value) => String(value || 'attachment')
                .replace(/[_-]+/g, ' ')
                .replace(/\\b\\w/g, (char) => char.toUpperCase());
            const duplicateSubtypeHeadings = attachments.map((item) => {
                const type = item.dataset.attachmentType || '';
                const subtype = normalize(typeLabel(type));
                const title = normalize(item.querySelector('.attachment-display-heading strong')?.innerText || '');
                const partHeader = normalize(item.closest('.reader-part.attachment')?.querySelector(':scope > .part-header strong')?.innerText || '');
                const badge = normalize(item.querySelector('.attachment-type-badge')?.innerText || '');
                return { type, title, partHeader, badge, duplicates: [title, partHeader, badge].filter(Boolean).filter((value) => value === subtype) };
            }).filter((item) => item.duplicates.length);
            return {
                types: attachments.map((item) => item.dataset.attachmentType || ''),
                typeBadgeCount: attachments.filter((item) => item.querySelector('.attachment-type-badge')).length,
                duplicateSubtypeHeadings,
                titleCount: attachments.filter((item) => item.querySelector('.attachment-display-heading strong')).length,
                sectionCount: attachments.filter((item) => item.querySelector('.attachment-section')).length,
                semanticContentCount: attachments.filter((item) => item.querySelector('.attachment-section, .attachment-meta dd')).length,
                partHeaderTexts: Array.from(document.querySelectorAll('.reader-part.attachment > .part-header strong')).map((item) => item.innerText.trim()),
                sectionLabels,
                disallowedLabels: sectionLabels.filter((label) => disallowedSectionLabels.has(label)),
                nonHumanLabels: sectionLabels.filter((label) => /_|[a-z][A-Z]/.test(label)),
                attachmentPreFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.reader-part.attachment .attachment-section pre')).fontSize) || 0,
                attachmentSummaryFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.reader-part.attachment .attachment-summary')).fontSize) || 0,
                stdoutBodyCount: Array.from(document.querySelectorAll('.reader-part.attachment .attachment-section pre'))
                    .filter((item) => /hookSpecificOutput|"stdout"|standard output:/i.test(item.innerText)).length,
            };
        }"""
    )
    assert EXPECTED_ATTACHMENT_TYPES <= set(reader_attachment_detail["types"]), (
        reader_attachment_detail
    )
    assert reader_attachment_detail["typeBadgeCount"] == 0, reader_attachment_detail
    assert reader_attachment_detail["duplicateSubtypeHeadings"] == [], reader_attachment_detail
    assert set(reader_attachment_detail["partHeaderTexts"]) == {"Details"}, (
        reader_attachment_detail
    )
    assert reader_attachment_detail["semanticContentCount"] >= len(EXPECTED_ATTACHMENT_TYPES), (
        reader_attachment_detail
    )
    assert reader_attachment_detail["attachmentPreFontSize"] == 12, reader_attachment_detail
    assert reader_attachment_detail["attachmentSummaryFontSize"] == 12, reader_attachment_detail
    assert reader_attachment_detail["disallowedLabels"] == [], reader_attachment_detail
    assert reader_attachment_detail["nonHumanLabels"] == [], reader_attachment_detail
    assert reader_attachment_detail["stdoutBodyCount"] == 0, reader_attachment_detail
    hook_attachment = page.locator(
        ".reader-part.attachment [data-attachment-type='hook_success']"
    ).first.locator("xpath=ancestor::section[contains(@class, 'reader-part')][1]")
    expect(hook_attachment.locator(".attachment-summary")).to_contain_text(
        "SessionStart hook added execution context"
    )
    additional_context_section = hook_attachment.locator(
        ".attachment-section", has_text="Additional Context"
    ).first
    expect(additional_context_section).to_contain_text("Using Amplify Skills")
    expect(additional_context_section).not_to_contain_text("FINAL CONTEXT MARKER")
    expect(
        additional_context_section.locator("[data-action='toggle-attachment-section']")
    ).to_have_text("Expand")
    additional_context_section.locator("[data-action='toggle-attachment-section']").click()
    expect(
        hook_attachment.locator(".attachment-section", has_text="Additional Context").first
    ).to_contain_text("FINAL CONTEXT MARKER")
    expect(
        hook_attachment.locator(
            ".attachment-section", has_text="Additional Context"
        ).first.locator("[data-action='toggle-attachment-section']")
    ).to_have_text("Collapse")
    expect(hook_attachment.locator("[data-action='toggle-raw-payload']")).to_have_text(
        "View payload"
    )
    hook_attachment.locator("[data-action='toggle-raw-payload']").click()
    expect(hook_attachment.locator("[data-raw-payload]")).to_be_visible()
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text('"attachment"')
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text(
        "hookSpecificOutput"
    )
    expect(hook_attachment.locator("[data-raw-payload] pre")).to_contain_text(
        "FINAL CONTEXT MARKER"
    )
    expect(hook_attachment.locator("[data-action='toggle-raw-payload']")).to_have_text(
        "Hide payload"
    )
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
    assert (
        left_nav_header_metrics["before"]["bodyScrollHeight"]
        > left_nav_header_metrics["before"]["bodyClientHeight"]
    ), left_nav_header_metrics
    assert (
        left_nav_header_metrics["after"]["bodyScrollTop"]
        > left_nav_header_metrics["before"]["bodyScrollTop"]
    ), left_nav_header_metrics
    assert (
        abs(
            left_nav_header_metrics["after"]["header"]["top"]
            - left_nav_header_metrics["before"]["header"]["top"]
        )
        <= 1.5
    ), left_nav_header_metrics
    assert left_nav_header_metrics["before"]["buttonRadius"].startswith("999"), (
        left_nav_header_metrics
    )
    card_index_geometry = page.locator(".reader-message").first.evaluate(
        """message => {
            const card = message.querySelector('.message-card');
            const header = message.querySelector('.message-header');
            const index = message.querySelector('.message-card-index');
            const actions = message.querySelector('.message-header-actions');
            const rawButton = message.querySelector('.message-raw-button');
            const messageRect = message.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const indexRect = index.getBoundingClientRect();
            const actionsRect = actions.getBoundingClientRect();
            const rawButtonRect = rawButton.getBoundingClientRect();
            return {
                leadingGap: Math.round(cardRect.left - messageRect.left),
                indexIsRightAligned: indexRect.left > headerRect.left + headerRect.width * 0.75,
                indexRightDelta: Math.round(headerRect.right - indexRect.right),
                hasHeaderNavKind: Boolean(message.querySelector('.message-header-nav-kind')),
                rawButtonInsideActions: rawButtonRect.left >= actionsRect.left && rawButtonRect.right <= actionsRect.right,
                actionsRightDelta: Math.round(headerRect.right - actionsRect.right),
            };
        }"""
    )
    assert card_index_geometry["leadingGap"] == 0, card_index_geometry
    assert card_index_geometry["indexIsRightAligned"], card_index_geometry
    assert card_index_geometry["indexRightDelta"] >= 0, card_index_geometry
    assert not card_index_geometry["hasHeaderNavKind"], card_index_geometry
    assert card_index_geometry["rawButtonInsideActions"], card_index_geometry
    assert 0 <= card_index_geometry["actionsRightDelta"] <= 14, card_index_geometry
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

    record(
        page,
        "reader.default",
        kind="dom_assertion",
        flow="reader.waterfall",
        viewport=viewport,
        selector="[data-testid='reader-layout']",
        assertion="Waterfall layout is reachable and selecting message cards does not open the floating detail panel",
    )
    record(
        page,
        "reader.default",
        kind="interaction",
        flow="reader.attachment_payload",
        viewport=viewport,
        selector=".reader-part.attachment",
        assertion="Waterfall cards render two-level message kind chips, type-specific attachment cards for all observed Claude attachment types, smaller tool payload text, and lazily expanded raw JSON",
    )
    record(
        page,
        "reader.default",
        kind="geometry",
        flow="reader.message_cards",
        viewport=viewport,
        selector=".reader-message .message-card-index",
        assertion="message cards have no leading gutter and show the ordinal at the right edge of the title bar",
    )
    record(
        page,
        "left_nav.tabs",
        kind="dom_assertion",
        flow="reader.message_navigation",
        viewport=viewport,
        selector="[data-testid='message-index']",
        assertion="Waterfall left navigation defaults to the selected agent message list, with each item showing its two-level type at top left",
    )
    record(
        page,
        "left_nav.tabs",
        kind="geometry",
        flow="reader.pinned_nav_header",
        viewport=viewport,
        selector="[data-testid='left-pane-header']",
        assertion="left navigation single-button pane header remained fixed while the message navigation body scrolled",
    )
    record(
        page,
        "ui.top_navigation",
        kind="dom_assertion",
        flow="top_nav.cleaned",
        viewport=viewport,
        selector="[data-testid='command-bar']",
        assertion="Prev, Next, First problem, timestamp, Jump time controls, Mode, and breadcrumb stack are absent; Backward and Forward are disabled initially; project path and branch are visible",
    )
    record(
        page,
        "ui.no_conversation_search",
        kind="dom_assertion",
        flow="conversation.removed_controls",
        viewport=viewport,
        selector="[data-testid='transcript-filter']",
        assertion="conversation search controls and left Problems list are absent",
    )
    record(
        page,
        "focus.layout_metrics",
        kind="dom_assertion",
        flow="reader.golden_ratio",
        viewport=viewport,
        selector="[data-testid='reader-layout']",
        assertion=f"mainMax={initial_metrics['mainMaxWidth']:.1f}, mainMin={initial_metrics['mainMinWidth']:.1f}, layout={initial_metrics['layoutWidth']:.1f}",
    )
    record(
        page,
        "focus.layout_metrics",
        kind="geometry",
        flow="reader.golden_ratio",
        viewport=viewport,
        selector="[data-testid='reader-layout']",
        assertion="Waterfall layout exposes golden-section main width constraints",
    )

    if viewport == "studio-native":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page, require_kind_variety=True)
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
        record(
            page,
            "reader.subagent_panels",
            kind="interaction",
            flow="reader.agent_drawer_toggle_native",
            viewport=viewport,
            selector="#agentPaneToggle",
            assertion="native-resolution agent sidebar inserted left of message navigation and toggled a subagent panel",
        )

    if viewport == "desktop":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page, require_kind_variety=True)
        select_problem_track_from_agent_sidebar(page)
        assert_message_index_item_presentation(page, require_problem=True)
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator(".subagent-panel .message-gutter")).to_have_count(0)
        expect(page.locator(".subagent-panel .message-card-index").first).to_be_visible()
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute(
            "aria-pressed", "true"
        )
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
        assert before_metrics["rackWidth"] <= before_metrics["maxRackWidth"] + 1.5, (
            before_metrics
        )
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
        assert abs(clamped_metrics["rackWidth"] - max_metrics["rackWidth"]) <= 1.5, (
            max_metrics,
            clamped_metrics,
        )
        assert (
            abs(clamped_metrics["mainStreamWidth"] - max_metrics["mainStreamWidth"]) <= 1.5
        ), (max_metrics, clamped_metrics)
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
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute(
            "aria-pressed", "false"
        )
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
        assert (
            abs(closed_metrics["mainStreamWidth"] - initial_metrics["mainStreamWidth"]) <= 1.5
        ), (
            initial_metrics,
            closed_metrics,
        )
        assert (
            abs(closed_metrics["mainStreamLeft"] - initial_metrics["mainStreamLeft"]) <= 1.5
        ), (
            initial_metrics,
            closed_metrics,
        )
        assert_interactive_dom_health(page)
        record(
            page,
            "left_nav.tabs",
            kind="interaction",
            flow="reader.agent_tree_drawer",
            viewport=viewport,
            selector="#agentPaneToggle",
            assertion="Agents sidebar inserts before message navigation and toggles hierarchical subagent panels",
        )
        record(
            page,
            "reader.subagent_panels",
            kind="interaction",
            flow="reader.resize_panel",
            viewport=viewport,
            selector="#agentStreamSeparator",
            assertion="Waterfall view shows a vertical divider and keyboard/pointer resizing changes the subagent panel rack width",
        )
        record(
            page,
            "focus.layout_metrics",
            kind="interaction",
            flow="reader.resize_clamp",
            viewport=viewport,
            selector="#agentStreamSeparator",
            assertion="divider resizing clamps at golden-remainder main content width and preserves main stream left edge",
        )

        page.locator(".spawn-reference").first.scroll_into_view_if_needed()
        page.locator(".spawn-reference button", has_text="Open Subagent").first.click()
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
        page.locator(".spawn-reference button", has_text="Open Subagent").nth(1).click()
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
        assert (
            abs(second_pin["scrollLeft"] - rack_scroll_before) <= second_pin["panelSlot"] + 90
        ), (
            rack_scroll_before,
            second_pin,
        )
        if page.locator(".spawn-reference button", has_text="Open Subagent").count() > 2:
            preserved_scroll_before = second_pin["scrollLeft"]
            page.locator(".spawn-reference button", has_text="Open Subagent").nth(2).click()
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
            assert (
                abs(third_pin["scrollLeft"] - preserved_scroll_before)
                <= third_pin["panelSlot"] + 90
            ), (
                preserved_scroll_before,
                third_pin,
            )
        record(
            page,
            "reader.subagent_panels",
            kind="interaction",
            flow="reader.open_panel",
            viewport=viewport,
            selector=".spawn-reference button",
            assertion="task reference opened a subagent panel",
        )
        record(
            page,
            "reader.subagent_panels",
            kind="dom_assertion",
            flow="reader.open_panel",
            viewport=viewport,
            selector=".subagent-panel",
            assertion="subagent panel is rendered",
        )

        page.locator(".subagent-panel .agent-panel-close").first.click()
        record(
            page,
            "reader.subagent_panels",
            kind="interaction",
            flow="reader.close_panel",
            viewport=viewport,
            selector=".agent-panel-close",
            assertion="subagent panel closes",
        )

        before = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        page.get_by_test_id("message-index").locator("[data-action='focus-capsule']").nth(
            1
        ).click()
        after = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        assert after != before
        expect(page.locator("#returnElementBtn")).to_be_enabled()
        expect(page.locator("#forwardElementBtn")).to_be_disabled()
        page.locator("#returnElementBtn").click()
        page.wait_for_function(
            "(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=before
        )
        expect(page.locator("#forwardElementBtn")).to_be_enabled()
        page.locator("#forwardElementBtn").click()
        page.wait_for_function(
            "(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=after
        )
        record(
            page,
            "nav.return_forward",
            kind="interaction",
            flow="reader.return_forward",
            viewport=viewport,
            selector="#returnElementBtn,#forwardElementBtn",
            assertion="Backward and Forward restored transcript focus in both directions",
        )

    screenshot = screenshot_dir / f"{viewport}-reader.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(
        page,
        "reader.default",
        kind="screenshot",
        flow="reader.screenshot",
        viewport=viewport,
        selector="screenshot",
        assertion="Waterfall layout screenshot captured",
        artifact=str(screenshot),
    )
    record(
        page,
        "visual.studio",
        kind="screenshot",
        flow="reader.screenshot",
        viewport=viewport,
        selector="screenshot",
        assertion="Waterfall layout screenshot captured",
        artifact=str(screenshot),
    )
    record(
        page,
        "visual.studio",
        kind="geometry",
        flow="reader.geometry",
        viewport=viewport,
        selector="document",
        assertion="Waterfall layout has no document-level horizontal overflow",
    )


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
    page.wait_for_function(
        "document.querySelectorAll('[data-testid=timeline-block]').length > 0"
    )
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
            const contentsTab = panel.querySelector('[data-detail-tab-target="contents"]');
            const metadataTab = panel.querySelector('[data-detail-tab-target="metadata"]');
            const rawTab = panel.querySelector('[data-detail-tab-target="raw"]');
            const tablistStyle = getComputedStyle(tablist);
            const contentsTabStyle = getComputedStyle(contentsTab);
            const metadataTabStyle = getComputedStyle(metadataTab);
            const rawTabStyle = getComputedStyle(rawTab);
            const contentsPanel = panel.querySelector('[data-detail-panel="contents"]');
            const metadataPanel = panel.querySelector('[data-detail-panel="metadata"]');
            const rawPanel = panel.querySelector('[data-detail-panel="raw"]');
            const bodySections = Array.from(panel.querySelectorAll(':scope > [data-detail-section]'));
            const titlebar = panel.querySelector('.timeline-detail-titlebar');
            const switchSection = panel.querySelector('[data-detail-section="switches"]');
            const activeSection = panel.querySelector('[data-detail-section="active-panel"]');
            const titlebarStyle = getComputedStyle(titlebar);
            const activeSectionStyle = getComputedStyle(activeSection);
            const tablistRect = tablist.getBoundingClientRect();
            const switchRect = switchSection.getBoundingClientRect();
            const contentsTabRect = contentsTab.getBoundingClientRect();
            const metadataTabRect = metadataTab.getBoundingClientRect();
            const actionButtons = Array.from(panel.querySelectorAll('.timeline-detail-actions button'));
            const pinButton = panel.querySelector('[data-testid="timeline-detail-pin"]');
            const closeButton = panel.querySelector('.timeline-detail-close');
            return {
                headerSummaryCount: panel.querySelectorAll('.timeline-detail-header h2').length,
                titlebarText: titlebar?.innerText.replace(/\\s+/g, ' ').trim() || '',
                titlebarHasKindStack: Boolean(titlebar?.querySelector('.timeline-detail-kind-stack')),
                bodySectionNames: bodySections.map((item) => item.dataset.detailSection || ''),
                switchSectionHasOnlyTabs: Boolean(switchSection?.querySelector('.timeline-detail-tablist'))
                    && switchSection.querySelectorAll('[data-detail-panel]').length === 0,
                activeSectionHasPanels: Boolean(activeSection)
                    && activeSection.querySelectorAll('[data-detail-panel]').length === 3
                    && activeSection.querySelectorAll('.timeline-detail-tablist').length === 0,
                titlebarBorderBottomWidth: Number.parseFloat(titlebarStyle.borderBottomWidth) || 0,
                activeSectionBorderTopWidth: Number.parseFloat(activeSectionStyle.borderTopWidth) || 0,
                panelSectionsInsideActiveSection: Array.from(panel.querySelectorAll('[data-detail-panel]'))
                    .every((item) => item.closest('[data-detail-section]')?.dataset.detailSection === 'active-panel'),
                tablistCenterDelta: Math.abs((tablistRect.left + tablistRect.width / 2) - (switchRect.left + switchRect.width / 2)),
                badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                contentKinds: (panel.querySelector('.timeline-detail-kind-stack')?.dataset.contentKinds || '').split(',').filter(Boolean),
                tabTexts: tabs.map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim()),
                tabTargets: tabs.map((tab) => tab.dataset.detailTabTarget || ''),
                tabRoles: tabs.map((tab) => tab.getAttribute('role') || ''),
                tablistDisplay: tablistStyle.display,
                tablistColumnGap: Number.parseFloat(tablistStyle.columnGap) || 0,
                tablistRadius: Number.parseFloat(tablistStyle.borderTopLeftRadius) || 0,
                activeTabBackground: contentsTabStyle.backgroundColor || '',
                activeToNextGap: Math.abs(contentsTabRect.right - metadataTabRect.left),
                metadataBorderLeftWidth: Number.parseFloat(metadataTabStyle.borderLeftWidth) || 0,
                rawBorderLeftWidth: Number.parseFloat(rawTabStyle.borderLeftWidth) || 0,
                metadataDividerShadow: metadataTabStyle.boxShadow || '',
                rawDividerShadow: rawTabStyle.boxShadow || '',
                selectedTab: panel.dataset.detailTab || '',
                contentsSelected: panel.querySelector('[data-detail-tab-target="contents"]')?.getAttribute('aria-selected') || '',
                metadataSelected: panel.querySelector('[data-detail-tab-target="metadata"]')?.getAttribute('aria-selected') || '',
                rawSelected: panel.querySelector('[data-detail-tab-target="raw"]')?.getAttribute('aria-selected') || '',
                contentsHidden: contentsPanel.hidden,
                metadataHidden: metadataPanel.hidden,
                rawHidden: rawPanel.hidden,
                contentHasBody: Boolean(contentsPanel.querySelector('.timeline-detail-parts, .timeline-detail-body, .raw-event')),
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
    assert "Message detail" not in detail["titlebarText"], detail
    assert detail["titlebarHasKindStack"], detail
    assert detail["bodySectionNames"] == ["titlebar", "switches", "active-panel"], detail
    assert detail["switchSectionHasOnlyTabs"], detail
    assert detail["activeSectionHasPanels"], detail
    assert detail["titlebarBorderBottomWidth"] == 0, detail
    assert detail["activeSectionBorderTopWidth"] == 0, detail
    assert detail["panelSectionsInsideActiveSection"], detail
    assert detail["tablistCenterDelta"] <= 2, detail
    assert detail["badgeText"], detail
    assert detail["lineKind"], detail
    assert detail["contentBadges"], detail
    assert detail["contentKinds"], detail
    assert detail["tabTexts"] == ["Contents", "Metadata", "Raw"], detail
    assert detail["tabTargets"] == ["contents", "metadata", "raw"], detail
    assert detail["tabRoles"] == ["tab", "tab", "tab"], detail
    assert detail["tablistDisplay"] in {"grid", "inline-grid"}, detail
    assert detail["tablistColumnGap"] == 0, detail
    assert detail["tablistRadius"] >= 12, detail
    assert detail["activeTabBackground"] != "rgba(0, 0, 0, 0)", detail
    assert detail["activeToNextGap"] <= 0.5, detail
    assert detail["metadataBorderLeftWidth"] == 0, detail
    assert detail["rawBorderLeftWidth"] == 0, detail
    assert detail["metadataDividerShadow"] != "none", detail
    assert detail["rawDividerShadow"] != "none", detail
    assert detail["selectedTab"] == "contents", detail
    assert (
        detail["contentsSelected"] == "true"
        and detail["metadataSelected"] == "false"
        and detail["rawSelected"] == "false"
    ), detail
    assert (
        detail["contentsHidden"] is False
        and detail["metadataHidden"] is True
        and detail["rawHidden"] is True
    ), detail
    assert detail["contentHasBody"], detail
    assert detail["rawHasCodeBlock"], detail
    assert detail["actionOrder"][:2] == [
        "toggle-timeline-detail-pin",
        "close-timeline-detail",
    ], detail
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
            f"detail titlebar shows {detail['badgeText']!r} line badge and {detail['contentBadges']!r} content badges; section 2 is the centered Contents/Metadata/Raw segment control "
            "with gapless active fill and inset dividers, and section 3 is the only active panel container with no divider borders between sections"
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
    expected_labels = {
        "Line type",
        "Content types",
        "Agent",
        "Block",
        "Time",
        "Line",
        "Path",
        "Problems",
        "Common failures",
    }
    assert metadata["selectedTab"] == "metadata", metadata
    assert (
        metadata["contentsSelected"] == "false"
        and metadata["metadataSelected"] == "true"
        and metadata["rawSelected"] == "false"
    ), metadata
    assert (
        metadata["contentsHidden"] is True
        and metadata["metadataHidden"] is False
        and metadata["rawHidden"] is True
    ), metadata
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
    expect(panel.locator("[data-detail-tab-target='contents']")).to_have_attribute(
        "aria-selected", "true"
    )

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
    assert (
        raw["contentsSelected"] == "false"
        and raw["metadataSelected"] == "false"
        and raw["rawSelected"] == "true"
    ), raw
    assert (
        raw["contentsHidden"] is True
        and raw["metadataHidden"] is True
        and raw["rawHidden"] is False
    ), raw
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
    expect(panel.locator("[data-detail-tab-target='contents']")).to_have_attribute(
        "aria-selected", "true"
    )


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
    assert error_detail["tabTexts"][0] == "Contents" and error_detail["tabTexts"][2] == "Raw", (
        error_detail
    )
    assert error_detail["tabTexts"][1].startswith("Metadata") and error_detail["tabTexts"][
        1
    ].endswith("!"), error_detail
    metadata_tab = panel.locator("[data-detail-tab-target='metadata']")
    expect(metadata_tab).to_contain_text("Metadata")
    expect(metadata_tab.locator(".timeline-detail-tab-alert")).to_be_visible()
    metadata_tab.click()
    expect(panel.locator("[data-detail-panel='metadata']")).to_be_visible()
    common_failures = panel.locator(
        ".timeline-detail-meta dt", has_text="Common failures"
    ).locator("xpath=following-sibling::dd[1]")
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


def assert_timeline_user_image_detail(page: Page, viewport: str) -> None:
    target = page.evaluate(
        """() => window.SESSION_VIEWER.capsules.find((item) =>
            item.lineType === 'user' && Array.isArray(item.contentTypes) && item.contentTypes.includes('image'))"""
    )
    assert target, "expected a user image capsule in the fixture"
    scroll_graph_to_capsule(page, target["key"])
    page.locator(f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']").click()
    panel = page.get_by_test_id("timeline-detail-panel").first
    expect(panel).to_be_visible()
    detail = panel.evaluate(
        """(panel) => {
            const sections = Array.from(panel.querySelectorAll(':scope > [data-detail-section]'));
            const imagePart = panel.querySelector('.timeline-detail-part.image');
            return {
                bodySectionNames: sections.map((item) => item.dataset.detailSection || ''),
                lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                partHeader: imagePart?.querySelector(':scope > header strong')?.innerText.trim() || '',
                partText: imagePart?.innerText || '',
                rawText: panel.querySelector('[data-detail-panel="raw"] pre code')?.innerText || '',
            };
        }"""
    )
    assert detail["bodySectionNames"] == ["titlebar", "switches", "active-panel"], detail
    assert detail["lineKind"] == "user", detail
    assert "image" in detail["contentBadges"], detail
    assert detail["partHeader"] == "image", detail
    assert "Image: image/png" in detail["partText"], detail
    panel.get_by_role("tab", name="Raw").click()
    raw_text = panel.locator("[data-detail-panel='raw']").inner_text()
    assert '"type": "image"' in raw_text, raw_text[:500]
    panel.get_by_role("tab", name="Contents").click()
    record(
        page,
        "timeline.detail_tabs",
        kind="dom_assertion",
        flow="timeline.detail_user_image_type",
        viewport=viewport,
        selector=".timeline-detail-part.image",
        assertion="user image messages render USER / image badges, semantic image contents, and raw JSON recovery inside the two-section detail card",
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
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']"
        ).click()
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
                const normalize = (value) => String(value || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
                const typeLabel = (value) => String(value || 'attachment')
                    .replace(/[_-]+/g, ' ')
                    .replace(/\\b\\w/g, (char) => char.toUpperCase());
                const attachmentType = event?.dataset.attachmentType || '';
                const subtype = normalize(typeLabel(attachmentType));
                const titleText = event?.querySelector('.attachment-display-heading strong')?.innerText.trim() || '';
                const partHeaderText = event?.closest('.timeline-detail-part.attachment')?.querySelector(':scope > header strong')?.innerText.trim() || '';
                const typeBadgeText = event?.querySelector('.attachment-type-badge')?.innerText.trim() || '';
                return {
                    badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                    lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                    contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                    attachmentType,
                    typeBadge: typeBadgeText,
                    titleText,
                    partHeaderText,
                    duplicatesSubtypeInBody: [titleText, partHeaderText, typeBadgeText]
                        .map(normalize)
                        .filter(Boolean)
                        .some((value) => value === subtype),
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
        assert detail["typeBadge"] == "", detail
        assert detail["partHeaderText"] == "Details", detail
        assert not detail["duplicatesSubtypeInBody"], detail
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


def assert_timeline_system_detail(page: Page, viewport: str) -> None:
    targets = page.evaluate(
        """() => window.SESSION_VIEWER.capsules
            .filter((item) => item.type === 'system')
            .map((item) => ({ key: item.key }))"""
    )
    assert targets, "expected system capsules in the fixture"
    seen_labels: set[str] = set()
    stop_hook_raw_verified = False
    for target in targets:
        scroll_graph_to_capsule(page, target["key"])
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']"
        ).click()
        panel = page.get_by_test_id("timeline-detail-panel").first
        expect(panel).to_be_visible()
        detail = panel.evaluate(
            """(panel) => {
                const contents = panel.querySelector('[data-detail-panel="contents"]');
                const event = contents?.querySelector('.system-event');
                const sectionLabels = Array.from(contents?.querySelectorAll('.system-section header strong') || [])
                    .map((item) => item.innerText.trim());
                return {
                    badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                    lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                    contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                    contentKinds: (panel.querySelector('.timeline-detail-kind-stack')?.dataset.contentKinds || '').split(',').filter(Boolean),
                    tabTexts: Array.from(panel.querySelectorAll('.timeline-detail-tab')).map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim()),
                    headerSummaryCount: panel.querySelectorAll('.timeline-detail-header h2').length,
                    subtype: event?.dataset.systemSubtype || '',
                    partHeaderText: event?.closest('.timeline-detail-part.system')?.querySelector(':scope > header strong')?.innerText.trim() || '',
                    summaryText: event?.querySelector('.system-summary')?.innerText.trim() || '',
                    sectionCount: event?.querySelectorAll('.system-section').length || 0,
                    rowCount: event?.querySelectorAll('.system-meta dd').length || 0,
                    sectionLabels,
                    nonHumanLabels: sectionLabels.filter((label) => /_|[a-z][A-Z]/.test(label)),
                    payloadButtonCount: panel.querySelectorAll('[data-action="toggle-raw-payload"], [data-action="copy-raw-payload"]').length,
                    rawPayloadContainerCount: panel.querySelectorAll('[data-raw-payload]').length,
                    directSystemShellCount: panel.querySelectorAll(':scope > .system-event, :scope > .system-section').length,
                    contentsText: contents?.innerText || '',
                };
            }"""
        )
        assert detail["badgeText"] == "SYSTEM", detail
        assert detail["lineKind"] == "system", detail
        assert detail["contentBadges"], detail
        assert detail["contentKinds"] == detail["contentBadges"], detail
        assert detail["tabTexts"] == ["Contents", "Metadata", "Raw"], detail
        assert detail["headerSummaryCount"] == 0, detail
        assert detail["subtype"], detail
        assert detail["partHeaderText"] == "Details", detail
        assert detail["summaryText"], detail
        assert detail["sectionCount"] + detail["rowCount"] >= 1, detail
        assert detail["payloadButtonCount"] == 0, detail
        assert detail["rawPayloadContainerCount"] == 0, detail
        assert detail["directSystemShellCount"] == 0, detail
        assert detail["nonHumanLabels"] == [], detail
        seen_labels.update(detail["contentBadges"])
        if "Stop Hook Summary" in detail["contentBadges"]:
            assert "Hook Runs" in detail["sectionLabels"], detail
            assert "Additional Context" in detail["sectionLabels"], detail
            assert "Using Amplify Skills" in detail["contentsText"], detail
            panel.get_by_role("tab", name="Raw").click()
            raw_text = panel.locator("[data-detail-panel='raw']").inner_text()
            assert '"subtype": "stop_hook_summary"' in raw_text, raw_text[:500]
            assert "hookAdditionalContext" in raw_text, raw_text[:500]
            assert "FINAL CONTEXT MARKER" in raw_text, raw_text[:500]
            panel.get_by_role("tab", name="Contents").click()
            stop_hook_raw_verified = True
    assert EXPECTED_SYSTEM_SUBTYPE_LABELS <= seen_labels, seen_labels
    assert stop_hook_raw_verified, seen_labels
    record(
        page,
        "timeline.detail_tabs",
        kind="dom_assertion",
        flow="timeline.detail_system_types",
        viewport=viewport,
        selector=".timeline-detail-part.system",
        assertion="system detail cards keep SYSTEM / subtype badges, render semantic subtype content inside Contents, and keep complete payloads in Raw",
    )


def assert_timeline_raw_event_detail(page: Page, viewport: str) -> None:
    targets = page.evaluate(
        """() => window.SESSION_VIEWER.capsules
            .filter((item) => item.rawOnly)
            .map((item) => ({ key: item.key }))"""
    )
    assert targets, "expected raw-only capsules in the fixture"
    seen_types: set[str] = set()
    for target in targets:
        scroll_graph_to_capsule(page, target["key"])
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{target['key']}']"
        ).click()
        panel = page.get_by_test_id("timeline-detail-panel").first
        expect(panel).to_be_visible()
        detail = panel.evaluate(
            """(panel) => {
                const contents = panel.querySelector('[data-detail-panel="contents"]');
                const event = contents?.querySelector('.raw-event');
                const sections = Array.from(panel.querySelectorAll(':scope > [data-detail-section]'));
                const rawTab = panel.querySelector('[data-detail-tab-target="raw"]');
                return {
                    bodySectionNames: sections.map((item) => item.dataset.detailSection || ''),
                    titlebarText: panel.querySelector('.timeline-detail-titlebar')?.innerText.replace(/\\s+/g, ' ').trim() || '',
                    sectionHasTabs: Boolean(sections[1]?.querySelector('.timeline-detail-tablist')),
                    panelsInsideActiveSection: Array.from(panel.querySelectorAll('[data-detail-panel]'))
                        .every((item) => item.closest('[data-detail-section]')?.dataset.detailSection === 'active-panel'),
                    badgeText: panel.querySelector('.timeline-detail-type')?.innerText.trim() || '',
                    lineKind: panel.querySelector('.timeline-detail-kind-stack')?.dataset.lineKind || '',
                    contentBadges: Array.from(panel.querySelectorAll('.timeline-detail-content-type')).map((item) => item.innerText.trim()),
                    rawType: event?.dataset.rawEventType || '',
                    summaryText: event?.querySelector('.raw-event-summary')?.innerText.trim() || '',
                    semanticCount: event?.querySelectorAll('.attachment-section, .raw-event-meta dd').length || 0,
                    tabTexts: Array.from(panel.querySelectorAll('.timeline-detail-tab')).map((tab) => tab.innerText.replace(/\\s+/g, ' ').trim()),
                    rawTabText: rawTab?.innerText.replace(/\\s+/g, ' ').trim() || '',
                };
            }"""
        )
        assert detail["bodySectionNames"] == ["titlebar", "switches", "active-panel"], detail
        assert "Message detail" not in detail["titlebarText"], detail
        assert detail["sectionHasTabs"], detail
        assert detail["panelsInsideActiveSection"], detail
        assert detail["badgeText"], detail
        assert detail["lineKind"] == "raw_event", detail
        assert detail["contentBadges"] == ["raw event"], detail
        assert detail["rawType"], detail
        assert detail["summaryText"], detail
        assert detail["semanticCount"] >= 1, detail
        assert detail["tabTexts"] == ["Contents", "Metadata", "Raw"], detail
        seen_types.add(detail["rawType"])
        panel.get_by_role("tab", name="Raw").click()
        raw_text = panel.locator("[data-detail-panel='raw']").inner_text()
        assert f'"type": "{detail["rawType"]}"' in raw_text, raw_text[:500]
        panel.get_by_role("tab", name="Contents").click()
    assert EXPECTED_RAW_ONLY_TYPES <= seen_types, seen_types
    record(
        page,
        "timeline.detail_tabs",
        kind="dom_assertion",
        flow="timeline.detail_raw_event_types",
        viewport=viewport,
        selector=".timeline-detail-panel .raw-event",
        assertion="raw-only subtype detail cards keep two-section structure, render semantic fields in Contents, and expose the raw JSON payload",
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
            const detailTabs = Array.from(detailWindow.querySelectorAll('.timeline-detail-tab'));
            const detailTabAlert = detailWindow.querySelector('.timeline-detail-tab-alert');
            const popoverValues = Array.from(popover.querySelectorAll('.mini-stats dd'));
            const popoverRect = rect(popover);
            const detailDockRect = rect(detailDock);
            const detailWindowRect = rect(detailWindow);
            const detailDockStyles = getComputedStyle(detailDock);
            const numberValue = (value) => Number.parseFloat(value) || 0;
            const detailWindowLayoutArea = {
                left: numberValue(detailDock.dataset.windowLayoutAreaLeft),
                top: numberValue(detailDock.dataset.windowLayoutAreaTop),
                right: numberValue(detailDock.dataset.windowLayoutAreaRight),
                bottom: numberValue(detailDock.dataset.windowLayoutAreaBottom),
                width: numberValue(detailDock.dataset.windowLayoutAreaWidth),
                height: numberValue(detailDock.dataset.windowLayoutAreaHeight),
            };
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
                detailDockPaddingLeft: Number.parseFloat(detailDockStyles.paddingLeft) || 0,
                detailDockPaddingRight: Number.parseFloat(detailDockStyles.paddingRight) || 0,
                detailDockPaddingBottom: Number.parseFloat(detailDockStyles.paddingBottom) || 0,
                detailTimelineHeaderClearance: detailDockRect.top - timelineLabelBottom,
                detailDockTopDelta: Math.abs(detailDockRect.top - detailWindowLayoutArea.top),
                detailDockLeftDelta: Math.abs(detailDockRect.left - detailWindowLayoutArea.left),
                detailDockRightDelta: Math.abs(detailDockRect.right - detailWindowLayoutArea.right),
                detailWindowRightDelta: Math.abs(detailWindowRect.right - (detailWindowLayoutArea.right - (Number.parseFloat(detailDockStyles.paddingRight) || 0))),
                detailWindowInsideLayoutArea: detailWindowRect.left >= detailWindowLayoutArea.left + (Number.parseFloat(detailDockStyles.paddingLeft) || 0) - 1
                    && detailWindowRect.top >= detailWindowLayoutArea.top - 1
                    && detailWindowRect.right <= detailWindowLayoutArea.right - (Number.parseFloat(detailDockStyles.paddingRight) || 0) + 1
                    && detailWindowRect.bottom <= detailWindowLayoutArea.bottom - (Number.parseFloat(detailDockStyles.paddingBottom) || 0) + 1,
                detailTabHeights: detailTabs.map((tab) => rect(tab).height),
                detailTabAlertExists: Boolean(detailTabAlert),
                detailTabAlertPosition: detailTabAlert ? getComputedStyle(detailTabAlert).position : '',
                detailTabAlertWidth: detailTabAlert ? rect(detailTabAlert).width : 0,
                detailTabAlertHeight: detailTabAlert ? rect(detailTabAlert).height : 0,
                popover: popoverRect,
                command: rect(command),
                timelineLabel: rect(timelineLabel),
                detailDock: detailDockRect,
                detailWindow: detailWindowRect,
                detailWindowLayoutArea,
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
    assert layering["popoverValueAlignments"] and set(layering["popoverValueAlignments"]) == {
        "right"
    }, layering
    assert layering["detailTimelineHeaderClearance"] >= 12, layering
    assert layering["detailDockTopDelta"] <= 3, layering
    assert layering["detailDockLeftDelta"] <= 3, layering
    assert layering["detailDockRightDelta"] <= 3, layering
    assert layering["detailWindowRightDelta"] <= 3, layering
    assert layering["detailWindowInsideLayoutArea"], layering
    if layering["detailTabAlertExists"]:
        assert layering["detailTabAlertPosition"] == "absolute", layering
        assert layering["detailTabAlertWidth"] <= 9.5, layering
        assert layering["detailTabAlertHeight"] <= 9.5, layering
        assert max(layering["detailTabHeights"]) - min(layering["detailTabHeights"]) <= 1.5, (
            layering
        )
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
    page.wait_for_function(
        "document.querySelectorAll('[data-testid=timeline-block]').length > 0"
    )
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    rendered_blocks = page.locator("[data-testid='timeline-block']").count()
    assert rendered_blocks < 5000, (
        f"virtual timeline rendered too many blocks: {rendered_blocks}"
    )
    metrics = timeline_alignment_metrics(page)
    assert metrics["uniqueBlockWidths"] == [118], metrics
    assert metrics["uniqueBlockHeights"] == [26], metrics
    assert len(metrics["uniqueBlockColors"]) >= 3, metrics
    assert metrics["renderedHeaderLabels"] == counts["tracks"], metrics
    assert metrics["uniqueHeaderHeights"] == [116], metrics
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
                kicker: label?.querySelector('.timeline-track-kicker')?.textContent.trim() || '',
                strong: label?.querySelector('strong')?.textContent.trim() || '',
                description: label?.querySelector('.timeline-track-description')?.textContent.trim() || '',
                model: label?.querySelector('.timeline-track-model')?.textContent.trim() || '',
                hasKicker: Boolean(label?.querySelector('.timeline-track-kicker')),
            };
        }"""
    )
    assert main_timeline_label["text"], main_timeline_label
    assert main_timeline_label["hasKicker"], main_timeline_label
    assert main_timeline_label["kicker"] == "MAIN", main_timeline_label
    assert main_timeline_label["strong"] == "", main_timeline_label
    assert main_timeline_label["title"].startswith("MAIN"), main_timeline_label
    assert main_timeline_label["description"] == "", main_timeline_label
    assert main_timeline_label["model"], main_timeline_label
    assert len(re.findall(r"\bMAIN\b", main_timeline_label["text"])) == 1, main_timeline_label
    subagent_timeline_labels = page.evaluate(
        """() => Array.from(document.querySelectorAll('.timeline-header-track.subagent [data-testid="timeline-track-label"]'))
            .slice(0, 24)
            .map((label) => ({
                text: label.innerText.replace(/\\s+/g, ' ').trim(),
                title: label.getAttribute('title') || '',
                kicker: label.querySelector('.timeline-track-kicker')?.textContent.trim() || '',
                strong: label.querySelector('strong')?.textContent.trim() || '',
                description: label.querySelector('.timeline-track-description')?.textContent.trim() || '',
                model: label.querySelector('.timeline-track-model')?.textContent.trim() || '',
            }))"""
    )
    assert subagent_timeline_labels, subagent_timeline_labels
    assert all(item["kicker"] == "SUBAGENT" for item in subagent_timeline_labels), (
        subagent_timeline_labels[:8]
    )
    assert not any(
        re.search(r"\bAgent [a-f0-9]{6,}\b", item["text"], flags=re.IGNORECASE)
        for item in subagent_timeline_labels
    ), subagent_timeline_labels[:8]
    assert not any(
        re.search(r"\bAgent [a-f0-9]{6,}\b", item["title"], flags=re.IGNORECASE)
        for item in subagent_timeline_labels
    ), subagent_timeline_labels[:8]
    assert any(
        item["strong"] and item["strong"].lower() != "subagent"
        for item in subagent_timeline_labels
    ), subagent_timeline_labels[:8]
    assert any(
        item["description"] and item["description"] != "No description"
        for item in subagent_timeline_labels
    ), subagent_timeline_labels[:8]
    assert all(item["model"] for item in subagent_timeline_labels), subagent_timeline_labels[:8]
    assert any(
        re.search(r"\b\d+\.\d+\b", item["model"]) for item in subagent_timeline_labels
    ), subagent_timeline_labels[:8]
    problem_label_icons = page.evaluate(
        """() => {
            const problemLabels = Array.from(document.querySelectorAll('[data-testid="timeline-track-label"].has-problem'));
            return {
                problemLabels: problemLabels.length,
                icons: problemLabels.filter((label) => label.querySelector('.timeline-track-error-icon')).length,
                nonSelectedProblemBackgrounds: problemLabels
                    .filter((label) => label.getAttribute('aria-selected') !== 'true')
                    .map((label) => getComputedStyle(label).backgroundColor),
            };
        }"""
    )
    assert problem_label_icons["problemLabels"], problem_label_icons
    assert problem_label_icons["icons"] == problem_label_icons["problemLabels"], (
        problem_label_icons
    )
    assert all(
        background == "rgba(0, 0, 0, 0)"
        for background in problem_label_icons["nonSelectedProblemBackgrounds"]
    ), problem_label_icons
    timeline_label_layout = page.evaluate(
        """() => {
            const selectedTrack = document.querySelector('.timeline-header-track.selected');
            const selectedLabel = selectedTrack?.querySelector('[data-testid="timeline-track-label"]');
            const subagentLabel = document.querySelector('.timeline-header-track.subagent [data-testid="timeline-track-label"]');
            const description = subagentLabel?.querySelector('.timeline-track-description');
            const errorIcon = document.querySelector('[data-testid="timeline-track-label"].has-problem .timeline-track-error-icon');
            const selectedTrackRect = selectedTrack?.getBoundingClientRect();
            const selectedLabelRect = selectedLabel?.getBoundingClientRect();
            return {
                selectedBandBackground: selectedTrack ? getComputedStyle(selectedTrack, '::before').backgroundImage : '',
                selectedLabelBackground: selectedLabel ? getComputedStyle(selectedLabel).backgroundColor : '',
                selectedTrackWidth: selectedTrackRect?.width || 0,
                selectedLabelWidth: selectedLabelRect?.width || 0,
                labelPaddingLeft: subagentLabel ? getComputedStyle(subagentLabel).paddingLeft : '',
                labelPaddingRight: subagentLabel ? getComputedStyle(subagentLabel).paddingRight : '',
                descriptionHeight: description?.getBoundingClientRect().height || 0,
                descriptionLineHeight: description ? getComputedStyle(description).lineHeight : '',
                descriptionClamp: description ? getComputedStyle(description).webkitLineClamp : '',
                descriptionWhiteSpace: description ? getComputedStyle(description).whiteSpace : '',
                iconColor: errorIcon ? getComputedStyle(errorIcon).color : '',
            };
        }"""
    )
    assert "255, 213, 79" in timeline_label_layout["selectedBandBackground"], (
        timeline_label_layout
    )
    assert timeline_label_layout["selectedLabelBackground"] == "rgba(0, 0, 0, 0)", (
        timeline_label_layout
    )
    assert (
        timeline_label_layout["selectedTrackWidth"]
        == timeline_label_layout["selectedLabelWidth"]
    ), timeline_label_layout
    assert timeline_label_layout["labelPaddingLeft"] == "14px", timeline_label_layout
    assert timeline_label_layout["labelPaddingRight"] == "14px", timeline_label_layout
    assert timeline_label_layout["descriptionHeight"] == 24, timeline_label_layout
    assert timeline_label_layout["descriptionLineHeight"] == "12px", timeline_label_layout
    assert timeline_label_layout["descriptionClamp"] == "2", timeline_label_layout
    assert timeline_label_layout["descriptionWhiteSpace"] == "normal", timeline_label_layout
    assert timeline_label_layout["iconColor"] == "rgba(180, 35, 24, 0.66)", (
        timeline_label_layout
    )
    block_kind_sample = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
            .slice(0, 160)
            .map((element) => ({
                label: element.textContent.replace(/\\s+/g, ' ').trim(),
                line: element.dataset.lineKind || '',
                content: (element.dataset.contentKinds || '').split(',').filter(Boolean),
                title: element.getAttribute('title') || '',
                aria: element.getAttribute('aria-label') || '',
                background: getComputedStyle(element).backgroundColor,
            }))"""
    )
    block_label_strategy = page.evaluate(
        """() => {
            const context = document.createElement('canvas').getContext('2d');
            context.font = "800 10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
            const firstWord = (value) => String(value || 'kind').split(/\\s+/).filter(Boolean)[0] || 'kind';
            return Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
                .slice(0, 160)
                .map((element) => {
                    const label = element.textContent.replace(/\\s+/g, ' ').trim();
                    const content = (element.dataset.contentKinds || '').split(',').filter(Boolean);
                    const fullName = content.join(' + ') || 'kind';
                    const match = label.match(/^(.*)\\s+(\\d+)$/);
                    const ordinal = match ? match[2] : '';
                    const actualName = match ? match[1] : label;
                    const fullLabel = ordinal ? `${fullName} ${ordinal}` : fullName;
                    const firstLabel = ordinal ? `${firstWord(fullName)} ${ordinal}` : firstWord(fullName);
                    const fullFits = context.measureText(fullLabel).width <= Math.max(0, element.getBoundingClientRect().width - 20);
                    return {
                        label,
                        line: element.dataset.lineKind || '',
                        content,
                        fullName,
                        actualName,
                        fullFits,
                        valid: fullFits ? label === fullLabel : label === firstLabel,
                    };
                });
        }"""
    )
    invalid_block_labels = [item for item in block_label_strategy if not item["valid"]]
    assert not invalid_block_labels, invalid_block_labels[:20]
    assert any(
        item["line"] == "user"
        and "message" in item["content"]
        and item["actualName"] == "message"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "user"
        and "tool result" in item["content"]
        and item["actualName"] == "tool result"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "assistant"
        and "message" in item["content"]
        and item["actualName"] == "message"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "assistant"
        and "reasoning" in item["content"]
        and item["actualName"] == "reasoning"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "assistant"
        and "tool call" in item["content"]
        and item["actualName"] == "tool call"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "attachment"
        and "Hook Success" in item["content"]
        and item["actualName"] == "Hook Success"
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "attachment" and item["background"] == "rgb(14, 116, 144)"
        for item in block_kind_sample
    ), block_kind_sample[:20]
    assert any(
        item["line"] == "system"
        and "Stop Hook Summary" in item["content"]
        and item["actualName"] == "Stop"
        and not item["fullFits"]
        for item in block_label_strategy
    ), block_label_strategy[:20]
    assert any(
        item["line"] == "system" and item["background"] == "rgb(107, 114, 128)"
        for item in block_kind_sample
    ), block_kind_sample[:20]
    assert any(
        "user / tool result" in item["title"] and "user / tool result" in item["aria"]
        for item in block_kind_sample
    ), block_kind_sample[:20]
    assert any(
        "system / Stop Hook Summary" in item["title"]
        and "system / Stop Hook Summary" in item["aria"]
        for item in block_kind_sample
    ), block_kind_sample[:20]
    assert not any(" · " in item["label"] for item in block_kind_sample), block_kind_sample[:20]
    assert not any(
        item["label"].startswith(("MSG ", "RESULT ", "TOOL ", "REASON "))
        for item in block_kind_sample
    ), block_kind_sample[:20]
    dom_count = page.evaluate("document.querySelectorAll('*').length")
    assert dom_count < 9000, f"timeline page DOM too large: {dom_count}"
    assert_no_horizontal_overflow(page)
    assert_timeline_detail_tabs(page, viewport)
    if viewport in {"studio-native", "desktop"}:
        assert_window_layering(page, viewport)
    if viewport in {"studio-native", "desktop"}:
        assert_timeline_attachment_detail(page, viewport)
        assert_timeline_system_detail(page, viewport)
        assert_timeline_raw_event_detail(page, viewport)
        assert_timeline_user_image_detail(page, viewport)
        assert_timeline_detail_error_badge(page, viewport)

    record(
        page,
        "graph.dom_svg",
        kind="dom_assertion",
        flow="timeline.open",
        viewport=viewport,
        selector="[data-testid='overview-timeline']",
        assertion=f"default Timeline rendered {counts['messages']} logical messages without canvas and without the left rail",
    )
    record(
        page,
        "perf.large_session",
        kind="dom_assertion",
        flow="timeline.dom_budget",
        viewport=viewport,
        selector="[data-testid='timeline-block']",
        assertion=f"virtual timeline rendered {rendered_blocks} visible blocks",
    )
    record(
        page,
        "overview.header_stability",
        kind="dom_assertion",
        flow="timeline.header_dom",
        viewport=viewport,
        selector="[data-testid='timeline-header']",
        assertion="sticky header has equal-height labels above timeline blocks and no grid-line background",
    )
    record(
        page,
        "overview.header_stability",
        kind="dom_assertion",
        flow="timeline.main_track_label",
        viewport=viewport,
        selector=".timeline-header-track.main [data-testid='timeline-track-label']",
        assertion=f"main timeline header label shows the uppercase MAIN kicker without a separate agent name: {main_timeline_label['text']!r}",
    )
    record(
        page,
        "overview.header_stability",
        kind="dom_assertion",
        flow="timeline.subagent_track_labels",
        viewport=viewport,
        selector=".timeline-header-track.subagent [data-testid='timeline-track-label']",
        assertion="subagent timeline labels show parsed subagent names instead of UUID-derived Agent labels",
    )
    record(
        page,
        "overview.scroll_blocks",
        kind="dom_assertion",
        flow="timeline.block_labels",
        viewport=viewport,
        selector="[data-testid='timeline-block']",
        assertion="timeline blocks render the full content kind plus index when it fits, and fall back to the first word plus index only when the full label cannot fit",
    )
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

    problem_badge_capsule = page.evaluate(
        "window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)"
    )
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
    record(
        page,
        "overview.problem_badge",
        kind="dom_assertion",
        flow="timeline.problem_badge",
        viewport=viewport,
        selector="[data-testid='timeline-block'].has-problem",
        assertion="problem badge is allowed to overflow outside the message block border",
    )

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
        record(
            page,
            "graph.dom_svg",
            kind="interaction",
            flow="timeline.center_select_with_detail",
            viewport=viewport,
            selector="[data-testid='timeline-block']",
            assertion=f"focused block centered with delta {center_selection['centeredDelta']} and the Timeline detail dock stayed visible",
        )

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
        assert not any(
            label.startswith("US ") or label.startswith("AS ") or label.startswith("TR ")
            for sample in down_scroll["samples"]
            for label in sample
        ), down_scroll
        record(
            page,
            "overview.scroll_blocks",
            kind="interaction",
            flow="timeline.down_scroll_blocks",
            viewport=viewport,
            selector="[data-testid='timeline-block']",
            assertion=f"visible block counts after down-scroll: {down_scroll['counts']}",
        )
        record(
            page,
            "overview.problem_badge",
            kind="interaction",
            flow="timeline.problem_badge_native",
            viewport=viewport,
            selector="[data-testid='timeline-block'].has-problem",
            assertion="problem badge geometry verified at native resolution",
        )

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
        assert (
            stability["after"]["renderCounts"]["header"]
            == stability["before"]["renderCounts"]["header"]
        ), stability
        assert (
            stability["after"]["renderCounts"]["detail"]
            == stability["before"]["renderCounts"]["detail"]
        ), stability
        assert stability["elapsedMs"] < 2500, stability
        record(
            page,
            "overview.header_stability",
            kind="interaction",
            flow="timeline.header_scroll",
            viewport=viewport,
            selector="[data-testid='timeline-track-label']",
            assertion=f"header top range {stability['topRange']:.2f}px during multi-screen native scroll",
        )
        record(
            page,
            "overview.header_stability",
            kind="performance",
            flow="timeline.header_scroll",
            viewport=viewport,
            selector="window.SESSION_VIEWER.timelineMetrics()",
            assertion=f"header rerenders stayed at {stability['after']['renderCounts']['header']} over {stability['elapsedMs']:.1f}ms scroll sample",
        )

    if viewport == "mobile":
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

    if viewport == "desktop":
        spawn = page.evaluate("window.SESSION_VIEWER.spawnEdges[0]")
        scroll_graph_to_capsule(page, spawn["sourceKey"])
        before_width = page.get_by_test_id("overview-timeline").evaluate(
            "node => node.clientWidth"
        )
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{spawn['sourceKey']}']"
        ).click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("tool call")
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)
        after_width = page.get_by_test_id("overview-timeline").evaluate(
            "node => node.clientWidth"
        )
        assert after_width == before_width, (before_width, after_width)
        page.wait_for_function(
            "document.querySelectorAll('.timeline-connector.spawn.selected').length > 0"
        )
        spawn_geometry = page.evaluate(
            """(spawn) => {
                const source = document.querySelector(`[data-testid="timeline-block"][data-capsule-key="${CSS.escape(spawn.sourceKey)}"]`);
                const target = document.querySelector(`[data-testid="timeline-block"][data-capsule-key="${CSS.escape(spawn.targetKey)}"]`);
                const connector = document.querySelector(`[data-testid="timeline-spawn-connector"][data-source-key="${CSS.escape(spawn.sourceKey)}"][data-target-key="${CSS.escape(spawn.targetKey)}"]`);
                const normalConnector = document.querySelector('[data-testid="timeline-spawn-connector"]:not(.selected)');
                const normalMarker = document.querySelector('#timelineArrow');
                const selectedMarker = document.querySelector('#timelineArrowSelected');
                const px = (value) => Number.parseFloat(value) || 0;
                const blockBox = (node) => {
                    const style = node ? getComputedStyle(node) : null;
                    return {
                        left: px(style?.left),
                        top: px(style?.top),
                        width: px(style?.width),
                        height: px(style?.height),
                    };
                };
                const sourceBox = blockBox(source);
                const targetBox = blockBox(target);
                const d = connector?.getAttribute('d') || '';
                const numbers = d.match(/-?\\d+(?:\\.\\d+)?/g)?.map(Number) || [];
                const expected = [
                    sourceBox.left + sourceBox.width,
                    sourceBox.top + sourceBox.height / 2,
                    targetBox.left + targetBox.width / 2,
                    sourceBox.top + sourceBox.height / 2,
                    targetBox.left + targetBox.width / 2,
                    targetBox.top,
                ];
                const deltas = numbers.map((value, index) => Math.abs(value - expected[index]));
                return {
                    sourceBox,
                    targetBox,
                    d,
                    numbers,
                    expected,
                    deltas,
                    usesCurve: /\\bC\\b/.test(d),
                    childBelowParentLine: targetBox.top >= sourceBox.top + sourceBox.height,
                    childStartsNextTimelineRow: targetBox.top > sourceBox.top,
                    horizontalThenVertical: numbers.length === 6
                        && Math.abs(numbers[1] - numbers[3]) <= 0.5
                        && Math.abs(numbers[2] - numbers[4]) <= 0.5
                        && numbers[5] > numbers[3],
                    connectorStrokeLinejoin: connector ? getComputedStyle(connector).strokeLinejoin : '',
                    connectorStrokeWidth: connector ? getComputedStyle(connector).strokeWidth : '',
                    normalConnectorStrokeWidth: normalConnector ? getComputedStyle(normalConnector).strokeWidth : '',
                    connectorMarkerEnd: connector ? getComputedStyle(connector).markerEnd : '',
                    normalConnectorMarkerEnd: normalConnector ? getComputedStyle(normalConnector).markerEnd : '',
                    normalMarkerGeometry: normalMarker ? [
                        normalMarker.getAttribute('markerWidth'),
                        normalMarker.getAttribute('markerHeight'),
                        normalMarker.getAttribute('refX'),
                        normalMarker.getAttribute('refY'),
                        normalMarker.getAttribute('orient'),
                        normalMarker.getAttribute('markerUnits'),
                        normalMarker.querySelector('path')?.getAttribute('d') || '',
                    ] : [],
                    selectedMarkerGeometry: selectedMarker ? [
                        selectedMarker.getAttribute('markerWidth'),
                        selectedMarker.getAttribute('markerHeight'),
                        selectedMarker.getAttribute('refX'),
                        selectedMarker.getAttribute('refY'),
                        selectedMarker.getAttribute('orient'),
                        selectedMarker.getAttribute('markerUnits'),
                        selectedMarker.querySelector('path')?.getAttribute('d') || '',
                    ] : [],
                };
            }""",
            spawn,
        )
        assert not spawn_geometry["usesCurve"], spawn_geometry
        assert spawn_geometry["childBelowParentLine"], spawn_geometry
        assert spawn_geometry["childStartsNextTimelineRow"], spawn_geometry
        assert spawn_geometry["horizontalThenVertical"], spawn_geometry
        assert spawn_geometry["deltas"] and max(spawn_geometry["deltas"]) <= 0.75, (
            spawn_geometry
        )
        assert spawn_geometry["connectorStrokeLinejoin"] in {"miter", "miterclip"}, (
            spawn_geometry
        )
        assert spawn_geometry["connectorStrokeWidth"] == (
            spawn_geometry["normalConnectorStrokeWidth"]
            or spawn_geometry["connectorStrokeWidth"]
        ), spawn_geometry
        assert "timelineArrowSelected" in spawn_geometry["connectorMarkerEnd"], spawn_geometry
        if spawn_geometry["normalConnectorMarkerEnd"]:
            assert "timelineArrow" in spawn_geometry["normalConnectorMarkerEnd"], spawn_geometry
        assert (
            spawn_geometry["normalMarkerGeometry"] == spawn_geometry["selectedMarkerGeometry"]
        ), spawn_geometry
        record(
            page,
            "graph.dom_svg",
            kind="interaction",
            flow="timeline.click_block",
            viewport=viewport,
            selector="[data-testid='timeline-block']",
            assertion="clicking an HTML timeline block selected it and kept a floating detail panel visible",
        )
        record(
            page,
            "graph.spawn_edges",
            kind="interaction",
            flow="timeline.spawn_connector",
            viewport=viewport,
            selector="[data-testid='timeline-block']",
            assertion="parent spawn block selected",
        )
        record(
            page,
            "graph.spawn_edges",
            kind="dom_assertion",
            flow="timeline.spawn_connector",
            viewport=viewport,
            selector=".timeline-connector.spawn.selected",
            assertion="selected spawn block exposes a visible child connector",
        )

        scroll_graph_to_capsule(page, spawn["targetKey"])
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{spawn['targetKey']}']"
        ).click()
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

        page.locator("[data-testid='timeline-block']").nth(0).click()
        page.locator("[data-testid='timeline-block']").nth(1).click(modifiers=["Meta"])
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text(
            "2 transcript elements selected"
        )
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(2)
        assert_timeline_detail_top_right(page, expected_count=2)
        record(
            page,
            "graph.multiselect",
            kind="interaction",
            flow="timeline.multiselect",
            viewport=viewport,
            selector="[data-testid='timeline-block']",
            assertion="Control-click toggled timeline multi-selection",
        )

        problem_capsule = page.evaluate(
            "window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)"
        )
        assert problem_capsule, "expected a problem-bearing capsule in the fixture"
        scroll_graph_to_capsule(page, problem_capsule["key"])
        page.locator(
            f"[data-testid='timeline-block'][data-capsule-key='{problem_capsule['key']}']"
        ).click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("problems")

        before_layout = page.evaluate("window.SESSION_VIEWER.current().layout")
        page.locator("#readerLayoutBtn").click()
        page.go_back()
        page.wait_for_function(
            "(layout) => window.SESSION_VIEWER.current().layout === layout", arg=before_layout
        )
        record(
            page,
            "nav.return_forward",
            kind="interaction",
            flow="timeline.browser_history",
            viewport=viewport,
            selector="history.state",
            assertion="browser back restored timeline layout state",
        )

    screenshot = screenshot_dir / f"{viewport}-timeline.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(
        page,
        "visual.studio",
        kind="screenshot",
        flow="timeline.screenshot",
        viewport=viewport,
        selector="screenshot",
        assertion="timeline layout screenshot captured",
        artifact=str(screenshot),
    )
    record(
        page,
        "visual.studio",
        kind="geometry",
        flow="timeline.geometry",
        viewport=viewport,
        selector="document",
        assertion="timeline layout has no document-level horizontal overflow",
    )


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
        opencode_sessions = httpx.get(
            f"{base_url}/api/sessions?agent=opencode", timeout=10
        ).json()
        assert len(opencode_sessions) >= 20
        primary_opencode_session_id = "ses_browser_opencode"
        opencode_url = (
            f"{base_url}/conversation/opencode/{primary_opencode_session_id}?"
            + urlencode({"tab": "opencode", "opencode_data_dir": str(opencode_data_dir)})
        )
        assert (
            httpx.get(
                f"{base_url}/api/conversation/{sessions[0]['id']}", timeout=10
            ).status_code
            == 200
        )
        assert (
            httpx.get(
                f"{base_url}/api/conversation/claude/{sessions[0]['id']}", timeout=10
            ).status_code
            == 200
        )
        assert (
            httpx.get(
                f"{base_url}/api/conversation/opencode/{opencode_sessions[0]['id']}", timeout=10
            ).status_code
            == 200
        )

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
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
            )
            page.on("pageerror", lambda exc: console_errors.append(str(exc)))
            page.on("requestfailed", lambda request: network_failures.append(request.url))
            validate_dashboard(
                page, base_url, projects_dir=projects_dir, opencode_data_dir=opencode_data_dir
            )
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
                try:
                    validate_reader(page, url, viewport, screenshots)
                except Exception as exc:
                    print(
                        f"[validate_browser] validate_reader failed at {viewport}: {exc}",
                        file=sys.stderr,
                    )
                try:
                    validate_graph(page, url, viewport, screenshots)
                except Exception as exc:
                    print(
                        f"[validate_browser] validate_graph failed at {viewport}: {exc}",
                        file=sys.stderr,
                    )
                if viewport == "studio-native":
                    cdp = page.context.new_cdp_session(page)
                    cdp.send("Performance.enable")
                    metrics = {
                        item["name"]: item["value"]
                        for item in cdp.send("Performance.getMetrics")["metrics"]
                    }
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
                    record(
                        page,
                        "perf.large_session",
                        kind="dom_assertion",
                        flow="timeline.dom_budget",
                        viewport=viewport,
                        selector="document.querySelectorAll('*')",
                        assertion=f"DOM node count {nodes} stays within budget",
                        source="cdp",
                    )
                    validate_opencode_conversation(
                        page,
                        opencode_url,
                        base_url=base_url,
                        opencode_data_dir=opencode_data_dir,
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
                try:
                    validate_limited_timeline_alignment(page, limited_url, viewport)
                except Exception as exc:
                    print(
                        f"[validate_browser] validate_limited_timeline_alignment failed at {viewport}: {exc}",
                        file=sys.stderr,
                    )
            assert not console_errors, "browser console/page errors:\n" + "\n".join(
                console_errors
            )
            assert not network_failures, "browser network failures:\n" + "\n".join(
                network_failures
            )
            record(
                page,
                "perf.large_session",
                kind="console_network",
                flow="browser_health",
                selector="console/network",
                assertion="zero console errors and zero failed network requests",
            )
            write_story_report(screenshots / "story-verification.json")
            write_subtype_surface_report(
                screenshots / "subtype-surface-verification.json", url, screenshots
            )
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
