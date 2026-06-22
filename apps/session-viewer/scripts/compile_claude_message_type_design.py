from __future__ import annotations

import argparse
import json
import re
import sys

from dataclasses import dataclass
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.claude_transcript_scan import (
    DEFAULT_MAX_DEPTH,
    DEFAULT_SAMPLE_CHARS,
    MessageKind,
    add_source_args,
    resolve_projects_root,
)
from scripts.scan_claude_message_kinds import KindStats, scan_message_kinds
from scripts.scan_claude_message_shapes import KindShapeStats, ShapeStats, scan_message_shapes


FIELD_LIMIT = 14
SHAPE_PREVIEW_LIMIT = 5

LINE_KIND_TOKENS = {
    "assistant": {
        "badge": "Assistant",
        "tone": "assistant-blue",
        "timeline": "ASST",
        "description": "assistant-generated content",
    },
    "user": {
        "badge": "User",
        "tone": "user-green",
        "timeline": "USER",
        "description": "user-originated content or tool result feedback",
    },
    "attachment": {
        "badge": "Attachment",
        "tone": "attachment-teal",
        "timeline": "ATT",
        "description": "Claude Code attachment payload",
    },
    "system": {
        "badge": "System",
        "tone": "system-slate",
        "timeline": "SYS",
        "description": "Claude Code system event",
    },
}

TIMELINE_CODES = {
    "agent-name": "AGENT",
    "ai-title": "TITLE",
    "api_error": "API",
    "assistant": "MSG",
    "auto_mode": "AUTO+",
    "auto_mode_exit": "AUTO-",
    "away_summary": "AWAY",
    "bridge-session": "BRIDGE",
    "bridge_status": "BRIDGE",
    "command_permissions": "PERM",
    "compact_boundary": "COMPACT",
    "compact_file_reference": "CFILE",
    "date_change": "DATE",
    "deferred_tools_delta": "TOOLS",
    "edited_text_file": "EDIT",
    "file": "FILE",
    "file-history-snapshot": "SNAP",
    "goal_status": "GOAL",
    "hook_additional_context": "CTX",
    "hook_blocking_error": "BLOCK",
    "hook_non_blocking_error": "HOK!",
    "hook_success": "HOK+",
    "image": "IMG",
    "informational": "INFO",
    "invoked_skills": "SKILL",
    "last-prompt": "PROMPT",
    "local_command": "CMD",
    "mcp_instructions_delta": "MCP",
    "message": "MSG",
    "mode": "MODE",
    "nested_memory": "MEM",
    "permission-mode": "PERM",
    "plan_file_reference": "PFILE",
    "plan_mode": "PLAN+",
    "plan_mode_exit": "PLAN-",
    "plan_mode_reentry": "PLAN~",
    "queued_command": "QUEUE",
    "queue-operation": "QUEUE",
    "raw_event": "RAW",
    "reasoning": "THINK",
    "result": "RESULT",
    "scheduled_task_fire": "SCHED",
    "skill_listing": "SKILL",
    "started": "START",
    "stop_hook_summary": "STOP",
    "task_reminder": "TASK",
    "task_status": "TASK",
    "todo_reminder": "TODO",
    "tool_call": "TOOL",
    "tool_result": "RESULT",
    "turn_duration": "TURN",
    "ultra_effort_enter": "UE+",
    "ultra_effort_exit": "UE-",
}

SUBTYPE_INTENTS = {
    "ai-title": "Session title metadata",
    "agent-name": "Agent identity metadata",
    "agent_listing_delta": "Agent listing additions and removals",
    "api_error": "API failure details",
    "assistant": "Assistant text content",
    "attachment": "Attachment payload",
    "auto_mode": "Auto mode entered",
    "auto_mode_exit": "Auto mode exited",
    "away_summary": "Away-mode summary",
    "bridge-session": "Bridge session metadata",
    "bridge_status": "Bridge status update",
    "command_permissions": "Command permission decision",
    "compact_boundary": "Compaction boundary marker",
    "compact_file_reference": "Compact transcript file reference",
    "date_change": "Date boundary",
    "deferred_tools_delta": "Deferred tool additions and removals",
    "edited_text_file": "Edited text file metadata",
    "file": "File attachment",
    "file-history-snapshot": "File history snapshot",
    "goal_status": "Goal status update",
    "hook_additional_context": "Hook-provided execution context",
    "hook_blocking_error": "Blocking hook failure",
    "hook_non_blocking_error": "Non-blocking hook failure",
    "hook_success": "Successful hook result with extracted context",
    "image": "User-provided image",
    "informational": "Informational system message",
    "invoked_skills": "Invoked skill list",
    "last-prompt": "Last prompt metadata",
    "local_command": "Local command caveat",
    "mcp_instructions_delta": "MCP instruction additions and removals",
    "message": "Natural-language message",
    "mode": "Mode metadata",
    "nested_memory": "Nested memory reference",
    "permission-mode": "Permission mode metadata",
    "plan_file_reference": "Plan file reference",
    "plan_mode": "Plan mode state",
    "plan_mode_exit": "Plan mode exit",
    "plan_mode_reentry": "Plan mode re-entry",
    "queued_command": "Queued command details",
    "queue-operation": "Queue operation metadata",
    "raw_event": "Raw JSONL event",
    "reasoning": "Assistant reasoning content",
    "result": "Workflow result metadata",
    "scheduled_task_fire": "Scheduled task execution",
    "skill_listing": "Available skill listing",
    "started": "Workflow start metadata",
    "stop_hook_summary": "Stop hook summary",
    "task_reminder": "Task reminder",
    "task_status": "Task status update",
    "todo_reminder": "Todo reminder",
    "tool_call": "Tool call request",
    "tool_result": "Tool call result",
    "turn_duration": "Turn timing summary",
    "ultra_effort_enter": "Ultra Effort mode entered",
    "ultra_effort_exit": "Ultra Effort mode exited",
}

ACTION_FIELDS = {
    "Copy JSON": "copy the raw JSON for the current payload",
    "Raw": "open formatted raw JSON in a popup",
    "Open Subagent": "open the spawned subagent transcript",
    "Jump to First": "jump to the first message in the spawned subagent transcript",
}


@dataclass(frozen=True)
class CompileOptions:
    max_depth: int = DEFAULT_MAX_DEPTH
    sample_limit: int = 1
    sample_chars: int = DEFAULT_SAMPLE_CHARS
    parse_json_strings: bool = True
    include_raw_only: bool = True


def humanize_identifier(value: str | None) -> str:
    if not value:
        return "Unknown"
    normalized = value.replace("$json", "parsed_json")
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", normalized)
    normalized = normalized.replace("_", " ").replace("-", " ").replace(".", " ")
    words = [word for word in normalized.split() if word]
    special = {
        "ai": "AI",
        "api": "API",
        "id": "ID",
        "json": "JSON",
        "mcp": "MCP",
        "url": "URL",
        "uuid": "UUID",
    }
    return " ".join(special.get(word.lower(), word.capitalize()) for word in words)


def label_for_kind(kind: MessageKind) -> dict[str, str | None]:
    type_label = humanize_identifier(kind.line_kind)
    subtype_label = humanize_identifier(kind.content_kind) if kind.content_kind else None
    return {
        "type": type_label,
        "subtype": subtype_label,
        "rawSubtype": humanize_identifier(kind.raw_subtype),
        "combined": f"{type_label} / {subtype_label}" if subtype_label else type_label,
    }


def line_token(kind: MessageKind) -> dict[str, str]:
    return LINE_KIND_TOKENS.get(
        kind.line_kind,
        {
            "badge": humanize_identifier(kind.line_kind),
            "tone": "raw-slate",
            "timeline": acronym(kind.line_kind),
            "description": "raw Claude Code JSONL event",
        },
    )


def acronym(value: str) -> str:
    words = re.split(r"[_\-\s]+", value.strip())
    letters = "".join(word[:1] for word in words if word)
    return (letters or "RAW").upper()[:4]


def sorted_shapes(kind_shapes: KindShapeStats | None) -> list[ShapeStats]:
    if not kind_shapes:
        return []
    return sorted(
        kind_shapes.shapes.values(),
        key=lambda shape: (-shape.count, shape.signature_id),
    )


def all_field_names(kind_shapes: KindShapeStats | None) -> list[str]:
    fields: set[str] = set()
    for shape in sorted_shapes(kind_shapes):
        fields.update(shape.fields)
    return sorted(fields)


def shape_to_array_json(shape: ShapeStats) -> dict[str, Any]:
    return {
        "signatureId": shape.signature_id,
        "count": shape.count,
        "requiredFields": shape.required_fields(),
        "optionalFields": shape.optional_fields(),
        "fields": {
            key: value.to_json()
            for key, value in sorted(shape.fields.items())
        },
        "samples": [sample.to_json() for sample in shape.samples],
        "examples": shape.examples,
    }


def field_label(path: str) -> str:
    return humanize_identifier(path.split(".$json.", 1)[-1])


def first_matching_fields(fields: list[str], terms: list[str], *, limit: int = 6) -> list[str]:
    matches = []
    lowered_terms = [term.lower() for term in terms]
    for field in fields:
        lowered = field.lower()
        if any(term in lowered for term in lowered_terms):
            matches.append(field)
        if len(matches) >= limit:
            break
    return matches


def generic_fields(fields: list[str], *, limit: int = FIELD_LIMIT) -> list[str]:
    preferred = [
        field
        for field in fields
        if field
        and "[]" not in field
        and not field.endswith(".$json")
        and field.count(".") <= 2
    ]
    return preferred[:limit] or fields[:limit]


def content_sections(kind: MessageKind, kind_shapes: KindShapeStats | None) -> list[dict[str, Any]]:
    fields = all_field_names(kind_shapes)
    content_kind = kind.content_kind or ""
    line_kind = kind.line_kind

    def section(title: str, source_fields: list[str], presentation: str) -> dict[str, Any]:
        return {
            "title": title,
            "sourceFields": source_fields,
            "presentation": presentation,
        }

    if kind.raw_only:
        return raw_event_sections(line_kind, fields, section)

    if line_kind == "assistant" and content_kind == "tool_call":
        sections = [
            section(
                "Tool Call",
                first_matching_fields(fields, ["name", "id", "caller"]),
                "Show tool name, tool-call ID, caller, and status as compact badges.",
            ),
            section(
                "Input",
                first_matching_fields(fields, ["input"], limit=10),
                "Render recognized inputs semantically; use compact monospace for bash commands.",
            ),
        ]
        if first_matching_fields(fields, ["subagent", "prompt"]):
            sections.append(
                section(
                    "Subagent",
                    first_matching_fields(fields, ["subagent", "prompt", "description"]),
                    "Keep Open Subagent and Jump to First actions; do not render a prompt banner.",
                )
            )
        return sections

    if line_kind == "assistant" and content_kind == "reasoning":
        return [
            section(
                "Reasoning",
                first_matching_fields(fields, ["thinking", "text", "signature"]),
                "Use the reasoning color token and preserve expandable long text in place.",
            )
        ]

    if line_kind == "assistant":
        return [
            section(
                "Message",
                first_matching_fields(fields, ["text"]),
                "Render assistant text with normal transcript typography.",
            )
        ]

    if line_kind == "user" and content_kind == "tool_result":
        return [
            section(
                "Tool Result",
                first_matching_fields(fields, ["tool_use_id", "content", "is_error"]),
                "Show result state, paired tool-call ID, and complete result body with expansion.",
            )
        ]

    if line_kind == "user" and content_kind == "image":
        return [
            section(
                "Image",
                first_matching_fields(fields, ["source", "media_type", "data"]),
                "Show image metadata and a thumbnail when the source is renderable.",
            )
        ]

    if line_kind == "user":
        return [
            section(
                "Message",
                first_matching_fields(fields, ["text"]),
                "Render user-authored text as the primary content.",
            )
        ]

    if line_kind == "attachment":
        return attachment_sections(content_kind, fields, section)

    if line_kind == "system":
        return system_sections(content_kind, fields, section)

    return [
        section(
            "Raw Event",
            generic_fields(fields),
            "Render a compact semantic header and rely on Raw for full JSON inspection.",
        )
    ]


def attachment_sections(
    content_kind: str,
    fields: list[str],
    section: Any,
) -> list[dict[str, Any]]:
    if "delta" in content_kind:
        return [
            section(
                "Added",
                first_matching_fields(fields, ["added", "add", "created", "new"]),
                "Render additions as a positive list, not as an opaque delta blob.",
            ),
            section(
                "Removed",
                first_matching_fields(fields, ["removed", "remove", "deleted", "old"]),
                "Render removals as a separate negative list.",
            ),
            section(
                "Delta Metadata",
                generic_fields(fields, limit=8),
                "Show counts and source identifiers when available.",
            ),
        ]

    if content_kind.startswith("hook_"):
        return [
            section(
                "Hook",
                first_matching_fields(
                    fields,
                    ["hookEventName", "hookName", "hookEvent", "command", "exitCode"],
                ),
                "Extract hook event, hook name, command, exit code, and duration.",
            ),
            section(
                "Additional Context",
                first_matching_fields(
                    fields,
                    ["additionalContext", "hookSpecificOutput", "context", "message"],
                ),
                "Show useful human-facing context extracted from stdout; do not repeat stdout.",
            ),
            section(
                "Failure",
                first_matching_fields(fields, ["blockingError", "error", "stderr", "reason"]),
                "For error hooks, show blocking status and concise failure details.",
            ),
        ]

    if content_kind in {"task_reminder", "todo_reminder"}:
        return [
            section(
                "Reminder",
                first_matching_fields(fields, ["message", "reminder", "todo", "task"]),
                "Render reminder text and associated todo/task status.",
            )
        ]

    if content_kind in {"plan_mode", "plan_mode_exit", "plan_mode_reentry"}:
        return [
            section(
                "Plan Mode",
                first_matching_fields(fields, ["plan", "allowedPrompts", "planFilePath", "mode"]),
                "Show current plan-mode state, plan file, and allowed prompts.",
            )
        ]

    if content_kind in {"auto_mode", "auto_mode_exit", "ultra_effort_enter", "ultra_effort_exit"}:
        return [
            section(
                "Mode Change",
                first_matching_fields(fields, ["mode", "effort", "reason", "timestamp"]),
                "Show the mode transition and any reason or trigger fields.",
            )
        ]

    if content_kind in {
        "compact_file_reference",
        "edited_text_file",
        "file",
        "nested_memory",
        "plan_file_reference",
    }:
        return [
            section(
                "File Reference",
                first_matching_fields(fields, ["file", "path", "name", "content", "text"]),
                "Show file path, operation, and concise content preview with expansion.",
            )
        ]

    if content_kind in {"command_permissions", "queued_command"}:
        return [
            section(
                "Command",
                first_matching_fields(fields, ["command", "permission", "queued", "decision"]),
                "Show command text, permission state, and queue metadata.",
            )
        ]

    if content_kind in {"goal_status", "task_status"}:
        return [
            section(
                "Status",
                first_matching_fields(fields, ["status", "goal", "task", "progress"]),
                "Show status, target, and progress fields.",
            )
        ]

    if content_kind in {"skill_listing", "invoked_skills"}:
        return [
            section(
                "Skills",
                first_matching_fields(fields, ["skill", "name", "description"]),
                "Show skill names with concise descriptions and counts.",
            )
        ]

    return [
        section(
            humanize_identifier(content_kind),
            generic_fields(fields),
            "Use a semantic field/value layout with expandable long fields.",
        )
    ]


def system_sections(
    content_kind: str,
    fields: list[str],
    section: Any,
) -> list[dict[str, Any]]:
    if content_kind == "api_error":
        return [
            section(
                "API Error",
                first_matching_fields(fields, ["error", "status", "message", "code"]),
                "Show status, code, provider message, and retryability if present.",
            )
        ]

    if content_kind == "turn_duration":
        return [
            section(
                "Duration",
                first_matching_fields(fields, ["duration", "ms", "tokens", "cost"]),
                "Right-align numeric timing/token values in a compact metric row.",
            )
        ]

    if content_kind in {"away_summary", "stop_hook_summary"}:
        fields_to_show = ["summary", "message", "hook", "result"]
        if content_kind == "stop_hook_summary":
            fields_to_show.extend(["hookCount", "hookErrors", "hookInfos", "stopReason"])
        return [
            section(
                humanize_identifier(content_kind),
                first_matching_fields(fields, fields_to_show),
                "Show the generated summary and any hook outcome metadata.",
            )
        ]

    if content_kind == "local_command":
        return [
            section(
                "Local Command",
                first_matching_fields(fields, ["command", "caveat", "message", "content"]),
                "Show the local-command caveat and command metadata without over-emphasis.",
            )
        ]

    if content_kind == "compact_boundary":
        return [
            section(
                "Compact Boundary",
                first_matching_fields(
                    fields,
                    [
                        "compactMetadata",
                        "preTokens",
                        "postTokens",
                        "preservedMessages",
                        "trigger",
                    ],
                    limit=10,
                ),
                "Show compaction trigger, token counts, preserved segment, and sidechain marker.",
            )
        ]

    if content_kind == "bridge_status":
        return [
            section(
                "Bridge Status",
                first_matching_fields(fields, ["content", "url", "sessionId"]),
                "Show bridge URL and status text as a compact connection card.",
            )
        ]

    if content_kind == "scheduled_task_fire":
        return [
            section(
                "Scheduled Task",
                first_matching_fields(fields, ["content", "timestamp", "sessionId"]),
                "Show task-fire text and timestamp metadata.",
            )
        ]

    if content_kind == "informational":
        return [
            section(
                "Information",
                first_matching_fields(fields, ["level", "content", "timestamp"]),
                "Show level and informational content with subdued system styling.",
            )
        ]

    return [
        section(
            humanize_identifier(content_kind),
            generic_fields(fields),
            "Use a compact semantic field/value layout, with Raw available for full JSON.",
        )
    ]


def raw_event_sections(
    line_kind: str,
    fields: list[str],
    section: Any,
) -> list[dict[str, Any]]:
    if line_kind == "queue-operation":
        return [
            section(
                "Queue Operation",
                first_matching_fields(fields, ["operation", "content", "timestamp", "sessionId"]),
                "Show queue operation and task-notification content; parse XML-like content when present.",
            )
        ]

    if line_kind == "file-history-snapshot":
        return [
            section(
                "File History Snapshot",
                first_matching_fields(
                    fields,
                    [
                        "messageId",
                        "isSnapshotUpdate",
                        "snapshot",
                        "trackedFileBackups",
                        "backupFileName",
                    ],
                ),
                "Treat trackedFileBackups as a path-keyed map and list changed backup entries.",
            )
        ]

    if line_kind == "result":
        return [
            section(
                "Workflow Result",
                first_matching_fields(fields, ["agentId", "key", "result"], limit=8),
                "Show agent/key and result object keyset before an expandable JSON preview.",
            )
        ]

    if line_kind == "last-prompt":
        return [
            section(
                "Last Prompt",
                first_matching_fields(fields, ["leafUuid", "lastPrompt", "sessionId"]),
                "Show prompt text when present and keep missing-prompt rows as metadata.",
            )
        ]

    if line_kind in {"ai-title", "agent-name", "mode", "permission-mode", "bridge-session"}:
        return [
            section(
                humanize_identifier(line_kind),
                generic_fields(fields, limit=8),
                "Show the scalar status value as the primary body with session metadata secondary.",
            )
        ]

    if line_kind == "started":
        return [
            section(
                "Workflow Started",
                first_matching_fields(fields, ["agentId", "key"]),
                "Show workflow agent ID and key as a compact start marker.",
            )
        ]

    return [
        section(
            humanize_identifier(line_kind),
            generic_fields(fields),
            "Show a compact typed summary and keep Raw available for the full event.",
        )
    ]


def implementation_notes(kind: MessageKind) -> list[str]:
    if kind.line_kind == "assistant" and kind.content_kind == "tool_call":
        return [
            "Top-level tool-call shape is stable; branch the body by `name` and `input` fields.",
            "For Task/Agent calls, keep Open Subagent and Jump to First actions but omit prompt banners.",
        ]
    if kind.line_kind == "user" and kind.content_kind == "tool_result":
        return [
            "`content` can be a string or typed array; render both semantically.",
            "Use the raw JSONL event for sibling `toolUseResult` details when implementing the renderer.",
        ]
    if kind.line_kind == "user" and kind.content_kind == "image":
        return ["Render thumbnail from `source.data` when media type is supported."]
    if kind.line_kind == "assistant" and kind.content_kind == "reasoning":
        return ["Do not show the reasoning `signature` in normal content; keep it in metadata/raw."]
    if kind.line_kind == "attachment" and "delta" in kind.content_kind:
        return ["Render additions and removals separately; do not collapse deltas into one preview."]
    if kind.line_kind == "attachment" and kind.content_kind.startswith("hook_"):
        return ["Parse JSON-looking stdout for hookSpecificOutput, then show extracted context only."]
    if kind.line_kind == "system":
        return ["System detail cards keep the same two-section shell as other Timeline details."]
    if kind.raw_only:
        return [
            "Raw-only events should still be reachable in Waterfall navigation and Timeline details.",
            "Use the top-level JSONL type as the only category badge; there is no second-level category.",
        ]
    return []


def waterfall_card_design(
    kind: MessageKind,
    kind_shapes: KindShapeStats | None,
) -> dict[str, Any]:
    labels = label_for_kind(kind)
    actions = ["Raw", "Copy JSON"]
    fields = all_field_names(kind_shapes)
    if kind.line_kind == "assistant" and first_matching_fields(fields, ["subagent"]):
        actions.extend(["Open Subagent", "Jump to First"])
    left = [
        "status dot",
        f"{labels['type']} badge",
    ]
    if labels["subtype"]:
        left.append(f"{labels['subtype']} badge")
    left.extend(["timestamp", "agent path"])
    return {
        "titleBar": {
            "left": left,
            "right": actions,
            "badgeStyle": "same visual treatment for first-level and optional second-level badges",
        },
        "body": content_sections(kind, kind_shapes),
        "density": "message typography; use smaller balanced monospace for bash commands",
        "raw": "Raw button opens formatted raw JSON for this timeline item.",
        "notes": implementation_notes(kind),
    }


def navigation_item_design(kind: MessageKind) -> dict[str, Any]:
    labels = label_for_kind(kind)
    token = line_token(kind)
    layout = [
        "activity dot",
        f"{labels['type']} badge",
    ]
    if labels["subtype"]:
        layout.append(f"{labels['subtype']} badge")
    layout.extend(["timestamp", "one-line preview"])
    return {
        "label": labels["combined"],
        "layout": layout,
        "tone": token["tone"],
        "badgeStyle": "consistent full badge style for first-level and optional second-level categories",
        "preview": navigation_preview_strategy(kind),
    }


def timeline_block_design(kind: MessageKind) -> dict[str, Any]:
    labels = label_for_kind(kind)
    token = line_token(kind)
    if kind.raw_only:
        block_code = TIMELINE_CODES.get(kind.line_kind, acronym(kind.line_kind))
        content = "Use the first-level type as the visible block noun because no second-level category exists."
    else:
        content_kind = kind.content_kind or kind.line_kind
        block_code = TIMELINE_CODES.get(content_kind, acronym(content_kind))
        content = "Use the second-level subtype as the visible block noun and keep count/index text compact."
    return {
        "label": block_code,
        "title": labels["combined"],
        "tone": token["tone"],
        "content": content,
    }


def timeline_detail_design(kind: MessageKind, kind_shapes: KindShapeStats | None) -> dict[str, Any]:
    labels = label_for_kind(kind)
    section_one_content = [f"First level: {labels['type']}"]
    if labels["subtype"]:
        section_one_content.append(f"Second level: {labels['subtype']}")
    section_one_content.append("Timestamp, agent, line, and path metadata")
    return {
        "sectionOne": {
            "purpose": "Category with optional second level",
            "content": section_one_content,
        },
        "sectionTwo": {
            "purpose": "Tabs and actions",
            "tabs": ["Contents", "Metadata", "Raw"],
            "actions": ["Copy JSON", "Pin", "Close"],
            "contentsTab": content_sections(kind, kind_shapes),
        },
        "notes": implementation_notes(kind),
    }


def navigation_preview_strategy(kind: MessageKind) -> str:
    if kind.line_kind == "assistant" and kind.content_kind == "tool_call":
        return "tool name plus primary input summary"
    if kind.line_kind == "user" and kind.content_kind == "tool_result":
        return "tool_use_id plus error/output preview"
    if kind.line_kind == "user" and kind.content_kind == "image":
        return "source media type and image size"
    if kind.line_kind == "attachment" and kind.content_kind.startswith("hook_"):
        return "hook event/name and status"
    if kind.line_kind == "attachment" and "delta" in kind.content_kind:
        return "added and removed counts"
    if kind.line_kind == "attachment" and kind.content_kind in {
        "ultra_effort_enter",
        "ultra_effort_exit",
    }:
        return "UE+ or UE- state transition"
    if kind.line_kind == "system":
        return "system subtype summary and primary metric"
    if kind.raw_only:
        return "event-specific scalar summary before raw JSON"
    return "first meaningful content line"


def intent_for_kind(kind: MessageKind) -> str:
    if kind.raw_only:
        return (
            SUBTYPE_INTENTS.get(kind.raw_subtype)
            or SUBTYPE_INTENTS.get(kind.line_kind)
            or "Raw JSONL event"
        )
    return SUBTYPE_INTENTS.get(kind.content_kind or kind.line_kind, line_token(kind)["description"])


def design_for_kind(kind: MessageKind, kind_shapes: KindShapeStats | None) -> dict[str, Any]:
    return {
        "messageCardInWaterfallView": waterfall_card_design(kind, kind_shapes),
        "messageItemInWaterfallNavigation": navigation_item_design(kind),
        "blockInTimelineView": timeline_block_design(kind),
        "messageDetailCardInTimelineView": timeline_detail_design(kind, kind_shapes),
        "implementationNotes": implementation_notes(kind),
    }


def compile_type_array(
    root: Path,
    *,
    options: CompileOptions,
) -> list[dict[str, Any]]:
    kind_result = scan_message_kinds(
        root,
        include_raw_only=options.include_raw_only,
        sample_limit=options.sample_limit,
    )
    shape_result = scan_message_shapes(
        root,
        include_raw_only=options.include_raw_only,
        max_depth=options.max_depth,
        sample_limit=options.sample_limit,
        sample_chars=options.sample_chars,
        parse_json_strings=options.parse_json_strings,
    )

    records = []
    for key, kind_stats in sorted(
        kind_result.kinds.items(),
        key=lambda item: (-item[1].count, item[0]),
    ):
        kind_shapes = shape_result.kinds.get(key)
        records.append(
            compiled_record(
                kind_stats,
                kind_shapes,
                files_scanned=kind_result.files_scanned,
                malformed_lines=kind_result.malformed_lines,
            )
        )
    return records


def compiled_record(
    kind_stats: KindStats,
    kind_shapes: KindShapeStats | None,
    *,
    files_scanned: int,
    malformed_lines: int,
) -> dict[str, Any]:
    kind = kind_stats.kind
    shapes = sorted_shapes(kind_shapes)
    labels = label_for_kind(kind)
    return {
        "key": kind.key,
        "type": kind.line_kind,
        "subtype": kind.content_kind,
        "rawSubtype": kind.raw_subtype,
        "labels": labels,
        "intent": intent_for_kind(kind),
        "count": kind_stats.count,
        "agentScopes": dict(kind_stats.agent_scopes.most_common()),
        "rawOnly": kind.raw_only,
        "shapeCount": len(shapes),
        "shapeIds": [shape.signature_id for shape in shapes],
        "shapes": [shape_to_array_json(shape) for shape in shapes],
        "samples": [sample.to_json() for sample in kind_stats.samples],
        "scan": {
            "filesScanned": files_scanned,
            "malformedLines": malformed_lines,
        },
        "design": design_for_kind(kind, kind_shapes),
    }


def write_json_array(records: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def render_design_markdown(records: list[dict[str, Any]], *, root: Path) -> str:
    total_count = sum(int(record["count"]) for record in records)
    lines = [
        "# Claude Transcript Type/Subtype Design",
        "",
        f"Source: `{root}`",
        f"Compiled records: {len(records)}",
        f"Message-kind records: {total_count}",
        "",
        "This document is generated from the compiled type/subtype array. "
        "It is intended to drive renderer implementation for observed Claude Code "
        "transcript shapes instead of relying on hand-written summaries.",
        "",
        "## Compiler Program",
        "",
        "`scripts/compile_claude_message_type_design.py` scans Claude Code main and "
        "subagent JSONL transcripts, compiles each `type` plus optional second-level "
        "category into a top-level JSON array, attaches structural shape data, and emits this "
        "surface design document from the same records.",
        "",
        "## Global Surface Rules",
        "",
        "- Waterfall cards show the first-level JSONL type and only show a second "
        "badge when the message actually has a second-level category.",
        "- Every Waterfall card has a `Raw` action that opens formatted raw JSON for "
        "that timeline item.",
        "- Waterfall navigation items use the same optional category badge treatment.",
        "- Timeline blocks use the second-level category when present; otherwise they "
        "use the first-level type.",
        "- Timeline detail cards keep exactly two sections: category metadata, then "
        "tabs/actions.",
        "- Long semantic content may be truncated only when the section title bar "
        "contains an in-place expand control.",
        "- Raw-only JSONL events remain reachable and receive typed summary bodies "
        "before the Raw tab.",
        "- Hook cards extract useful context from parsed stdout and avoid repeating "
        "stdout as a generic content section.",
        "- Delta cards show added and removed content as separate semantic sections.",
        "",
        "## Type Array Summary",
        "",
        "| Key | Count | Shapes | Intent |",
        "| --- | ---: | ---: | --- |",
    ]
    for record in records:
        lines.append(
            f"| `{record['key']}` | {record['count']} | {record['shapeCount']} | "
            f"{record['intent']} |"
        )

    lines.extend(["", "## Type Designs", ""])
    for record in records:
        lines.extend(render_record_design(record))
    return "\n".join(lines).rstrip() + "\n"


def render_record_design(record: dict[str, Any]) -> list[str]:
    design = record["design"]
    labels = record["labels"]
    lines = [
        f"### {labels['combined']}",
        "",
        f"- Key: `{record['key']}`",
        f"- Count: {record['count']}",
        f"- Shapes: {record['shapeCount']}",
        f"- Intent: {record['intent']}",
        "",
        "Observed shape preview:",
    ]
    if not record["shapes"]:
        lines.append("- none")
    for shape in record["shapes"][:SHAPE_PREVIEW_LIMIT]:
        required = ", ".join(f"`{field}`" for field in shape["requiredFields"][:FIELD_LIMIT])
        optional = ", ".join(f"`{field}`" for field in shape["optionalFields"][:FIELD_LIMIT])
        lines.append(
            f"- `{shape['signatureId']}`: {shape['count']} records; "
            f"required {required or 'none'}; optional {optional or 'none'}"
        )
    if record["shapeCount"] > SHAPE_PREVIEW_LIMIT:
        remaining = record["shapeCount"] - SHAPE_PREVIEW_LIMIT
        lines.append(f"- ... {remaining} more shapes in the JSON array")

    lines.extend(
        [
            "",
            "Waterfall message card:",
            "",
            "```text",
            ascii_waterfall_card(record),
            "```",
            "",
            "Waterfall navigation item:",
            "",
            "```text",
            ascii_navigation_item(record),
            "```",
            "",
            "Timeline block:",
            "",
            "```text",
            ascii_timeline_block(record),
            "```",
            "",
            "Timeline detail card:",
            "",
            "```text",
            ascii_timeline_detail(record),
            "```",
            "",
            "Content sections:",
        ]
    )
    for section in design["messageCardInWaterfallView"]["body"]:
        fields = ", ".join(f"`{field}`" for field in section["sourceFields"]) or "shape fields"
        lines.append(f"- {section['title']}: {section['presentation']} Source: {fields}.")
    if design["implementationNotes"]:
        lines.extend(["", "Implementation notes:"])
        for note in design["implementationNotes"]:
            lines.append(f"- {note}")
    lines.append("")
    return lines


def ascii_waterfall_card(record: dict[str, Any]) -> str:
    labels = record["labels"]
    body = record["design"]["messageCardInWaterfallView"]["body"]
    sections = " | ".join(section["title"] for section in body) or "Contents"
    badge_text = f"[{labels['type']}]"
    if labels.get("subtype"):
        badge_text += f" [{labels['subtype']}]"
    return "\n".join(
        [
            "+------------------------------------------------------+",
            f"| o {badge_text} time path | Raw |",
            "+------------------------------------------------------+",
            f"| {sections[:52]:<52} |",
            "| expandable semantic fields, metadata, and actions     |",
            "+------------------------------------------------------+",
        ]
    )


def ascii_navigation_item(record: dict[str, Any]) -> str:
    labels = record["labels"]
    badge_text = f"[{labels['type']}]"
    if labels.get("subtype"):
        badge_text += f" [{labels['subtype']}]"
    return (
        f"o {badge_text} "
        "time  one-line semantic preview"
    )


def ascii_timeline_block(record: dict[str, Any]) -> str:
    block = record["design"]["blockInTimelineView"]
    label = record["labels"].get("subtype") or record["labels"]["type"]
    return "\n".join(
        [
            "+----------------+",
            f"| {block['label'][:14]:<14} |",
            f"| {label[:14]:<14} |",
            "+----------------+",
        ]
    )


def ascii_timeline_detail(record: dict[str, Any]) -> str:
    labels = record["labels"]
    badge_text = f"[{labels['type']}]"
    if labels.get("subtype"):
        badge_text += f" [{labels['subtype']}]"
    return "\n".join(
        [
            "+------------------------------------------------------+",
            "| Section 1: category                                  |",
            f"| {badge_text} time agent line |",
            "+------------------------------------------------------+",
            "| Section 2: tabs and actions                         |",
            "| Contents | Metadata | Raw                 Copy Pin X |",
            "+------------------------------------------------------+",
        ]
    )


def write_design_markdown(records: list[dict[str, Any]], path: Path, *, root: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_design_markdown(records, root=root), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compile Claude Code transcript type/subtype records into a JSON array "
            "with observed shapes and renderer design guidance."
        ),
    )
    add_source_args(parser)
    parser.add_argument("--array-output", help="Write the compiled JSON array to this path.")
    parser.add_argument("--design-output", help="Write a Markdown design report to this path.")
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--sample-limit", type=int, default=1)
    parser.add_argument("--sample-chars", type=int, default=DEFAULT_SAMPLE_CHARS)
    parser.add_argument(
        "--no-parse-json-strings",
        action="store_true",
        help="Do not inspect JSON-looking string fields such as hook stdout.",
    )
    parser.add_argument(
        "--no-raw-only",
        action="store_true",
        help="Exclude raw-only JSONL event types from compiled records.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = resolve_projects_root(args)
    if not root.exists():
        parser.error(f"Claude transcript path does not exist: {root}")
    options = CompileOptions(
        max_depth=max(0, args.max_depth),
        sample_limit=max(0, args.sample_limit),
        sample_chars=max(20, args.sample_chars),
        parse_json_strings=not args.no_parse_json_strings,
        include_raw_only=not args.no_raw_only,
    )
    records = compile_type_array(root, options=options)

    if args.array_output:
        write_json_array(records, Path(args.array_output).expanduser())
    if args.design_output:
        write_design_markdown(records, Path(args.design_output).expanduser(), root=root)

    if not args.array_output and not args.design_output:
        print(json.dumps(records, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
