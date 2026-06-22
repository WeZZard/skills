from __future__ import annotations

import json

from pathlib import Path

from scripts.scan_claude_message_shapes import render_text, scan_message_shapes

from tests.conftest import write_jsonl


def test_scan_message_shapes_groups_equivalent_structures(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "assistant",
                "uuid": "tool1",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "Bash",
                            "input": {"command": "pwd", "description": "Show path"},
                        }
                    ],
                },
            },
            {
                "type": "assistant",
                "uuid": "tool2",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_2",
                            "name": "Bash",
                            "input": {"command": "ls", "description": "List files"},
                        }
                    ],
                },
            },
            {
                "type": "assistant",
                "uuid": "tool3",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_3",
                            "name": "Bash",
                            "input": {"command": "git status"},
                            "metadata": {"agentId": "agent-a"},
                        }
                    ],
                },
            },
        ],
    )

    result = scan_message_shapes(projects, kind_filters={"assistant/tool_call"})
    tool_shapes = result.kinds["assistant/tool_call"].shapes

    assert result.total_records == 3
    assert len(tool_shapes) == 2
    assert sorted(shape.count for shape in tool_shapes.values()) == [1, 2]
    assert set(result.kinds) == {"assistant/tool_call"}


def test_scan_message_shapes_includes_system_and_json_string_paths(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "attachment",
                "uuid": "att1",
                "attachment": {
                    "type": "hook_success",
                    "stdout": json.dumps(
                        {
                            "hookSpecificOutput": {
                                "hookEventName": "SessionStart",
                                "additionalContext": "Extra context",
                            }
                        }
                    ),
                },
            },
            {
                "type": "system",
                "uuid": "sys1",
                "subtype": "api_error",
                "error": {"status": 529, "message": "overloaded"},
            },
        ],
    )

    result = scan_message_shapes(projects)

    attachment_shape = next(iter(result.kinds["attachment/hook_success"].shapes.values()))
    system_shape = next(iter(result.kinds["system/api_error"].shapes.values()))
    assert "stdout.$json.hookSpecificOutput.additionalContext" in attachment_shape.fields
    assert "error.status" in system_shape.fields
    assert "subtype" in system_shape.fields

    text = render_text(result, field_limit=8)
    assert "attachment / Hook Success" in text
    assert "system / API Error" in text
    assert "shape " in text


def test_scan_message_shapes_can_exclude_raw_only(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {"type": "queue-operation", "uuid": "raw1", "operation": "push"},
            {"type": "user", "uuid": "user1", "message": {"role": "user", "content": "hi"}},
        ],
    )

    result = scan_message_shapes(projects, include_raw_only=False)

    assert "user/message" in result.kinds
    assert "queue-operation" not in result.kinds
