from __future__ import annotations

import json

from pathlib import Path

from scripts.compile_claude_message_type_design import (
    CompileOptions,
    compile_type_array,
    render_design_markdown,
    write_design_markdown,
    write_json_array,
)

from tests.conftest import write_jsonl


def test_compile_type_array_attaches_shapes_and_surface_designs(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {"type": "user", "message": {"role": "user", "content": "Build this"}},
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "Need inspect first."},
                        {"type": "text", "text": "I will inspect it."},
                        {
                            "type": "tool_use",
                            "id": "toolu_task",
                            "name": "Task",
                            "input": {
                                "description": "Scan shapes",
                                "prompt": "Inspect transcript kinds",
                                "subagent_type": "general-purpose",
                            },
                        },
                    ],
                },
            },
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_task",
                            "content": "done",
                        }
                    ],
                },
            },
            {
                "type": "attachment",
                "attachment": {
                    "type": "hook_success",
                    "stdout": json.dumps(
                        {
                            "hookSpecificOutput": {
                                "hookEventName": "SessionStart",
                                "additionalContext": "Use project instructions",
                            }
                        }
                    ),
                },
            },
            {"type": "attachment", "attachment": {"type": "ultra_effort_exit"}},
            {
                "type": "system",
                "subtype": "api_error",
                "error": {"status": 529, "message": "overloaded"},
            },
            {"type": "queue-operation", "operation": "push"},
        ],
    )

    records = compile_type_array(projects, options=CompileOptions(sample_limit=1))
    by_key = {record["key"]: record for record in records}

    assert isinstance(records, list)
    assert by_key["assistant/tool_call"]["type"] == "assistant"
    assert by_key["assistant/tool_call"]["subtype"] == "tool_call"
    assert by_key["attachment/ultra_effort_exit"]["labels"]["subtype"] == "Ultra Effort Exit"
    assert by_key["system/api_error"]["shapeCount"] == 1
    assert by_key["queue-operation"]["rawOnly"] is True
    assert by_key["queue-operation"]["subtype"] is None
    assert by_key["queue-operation"]["labels"]["subtype"] is None
    assert by_key["queue-operation"]["intent"] == "Queue operation metadata"
    assert by_key["queue-operation"]["design"]["blockInTimelineView"]["label"] == "QUEUE"

    for record in records:
        design = record["design"]
        assert "messageCardInWaterfallView" in design
        assert "messageItemInWaterfallNavigation" in design
        assert "blockInTimelineView" in design
        assert "messageDetailCardInTimelineView" in design
        assert "Raw" in design["messageCardInWaterfallView"]["titleBar"]["right"]

    detail = by_key["system/api_error"]["design"]["messageDetailCardInTimelineView"]
    assert detail["sectionOne"]["purpose"] == "Category with optional second level"
    assert detail["sectionTwo"]["tabs"] == ["Contents", "Metadata", "Raw"]


def test_compile_type_array_writes_json_array_and_design_markdown(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "attachment",
                "attachment": {
                    "type": "mcp_instructions_delta",
                    "added": ["Use MCP tools"],
                    "removed": ["Old instruction"],
                },
            }
        ],
    )
    records = compile_type_array(projects, options=CompileOptions(sample_limit=1))

    array_path = tmp_path / "type-array.json"
    design_path = tmp_path / "design.md"
    write_json_array(records, array_path)
    write_design_markdown(records, design_path, root=projects)

    saved = json.loads(array_path.read_text())
    assert isinstance(saved, list)
    assert saved[0]["key"] == "attachment/mcp_instructions_delta"

    markdown = design_path.read_text()
    assert "# Claude Transcript Type/Subtype Design" in markdown
    assert "Waterfall message card:" in markdown
    assert "Waterfall navigation item:" in markdown
    assert "Timeline block:" in markdown
    assert "Timeline detail card:" in markdown
    assert "[Attachment] [MCP Instructions Delta]" in markdown

    rendered = render_design_markdown(records, root=projects)
    assert "MCP instruction additions and removals" in rendered
