from __future__ import annotations

from pathlib import Path

from scripts.scan_claude_message_kinds import render_text, scan_message_kinds

from tests.conftest import write_jsonl


def test_scan_message_kinds_counts_viewer_taxonomy_and_raw_events(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    root_file = projects / "-fixture" / "session.jsonl"
    subagent_file = projects / "-fixture" / "session" / "subagents" / "agent-a.jsonl"
    write_jsonl(
        root_file,
        [
            {
                "type": "assistant",
                "uuid": "asst1",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "hello"},
                        {"type": "thinking", "thinking": "consider"},
                        {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}},
                    ],
                },
            },
            {"type": "user", "uuid": "user1", "message": {"role": "user", "content": "hi"}},
            {
                "type": "attachment",
                "uuid": "att1",
                "attachment": {"type": "hook_success", "stdout": "{}"},
            },
            {"type": "system", "uuid": "sys1", "subtype": "turn_duration", "durationMs": 12},
            {"type": "queue-operation", "uuid": "raw1", "operation": "push"},
            "{not json",
        ],
    )
    write_jsonl(
        subagent_file,
        [
            {
                "type": "user",
                "uuid": "result1",
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "done"}
                    ],
                },
            },
            {
                "type": "user",
                "uuid": "image1",
                "message": {"role": "user", "content": [{"type": "image", "source": {}}]},
            },
        ],
    )

    result = scan_message_kinds(projects)

    assert result.files_scanned == 2
    assert result.malformed_lines == 1
    assert result.raw_event_counts["queue-operation"] == 1
    assert result.kinds["assistant/message"].count == 1
    assert result.kinds["assistant/reasoning"].count == 1
    assert result.kinds["assistant/tool_call"].count == 1
    assert result.kinds["user/message"].count == 1
    assert result.kinds["user/tool_result"].agent_scopes["agent-a"] == 1
    assert result.kinds["attachment/hook_success"].count == 1
    assert result.kinds["system/turn_duration"].count == 1
    assert result.kinds["queue-operation"].count == 1
    assert result.kinds["queue-operation"].kind.content_kind is None

    text = render_text(result)
    assert "assistant / tool call" in text
    assert "system / Turn Duration" in text
    assert "queue-operation" in text


def test_scan_message_kinds_can_exclude_raw_only(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {"type": "queue-operation", "uuid": "raw1", "operation": "push"},
            {"type": "user", "uuid": "user1", "message": {"role": "user", "content": "hi"}},
        ],
    )

    result = scan_message_kinds(projects, include_raw_only=False)

    assert "user/message" in result.kinds
    assert "queue-operation" not in result.kinds
    assert result.raw_event_counts["queue-operation"] == 1
