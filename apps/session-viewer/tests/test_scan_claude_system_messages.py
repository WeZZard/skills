from __future__ import annotations

import json

from pathlib import Path

from scripts.scan_claude_system_messages import render_text, scan_system_messages

from tests.conftest import write_jsonl


def test_scan_system_messages_counts_subtypes_and_nested_fields(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "system",
                "uuid": "sys1",
                "subtype": "turn_duration",
                "durationMs": 1200,
                "messageCount": 3,
                "pendingBackgroundAgentCount": 1,
            },
            {
                "type": "system",
                "uuid": "sys2",
                "subtype": "compact_boundary",
                "compactMetadata": {
                    "trigger": "auto",
                    "preTokens": 120000,
                    "postTokens": 30000,
                    "preCompactDiscoveredTools": ["Read", "Grep"],
                },
            },
            {
                "type": "attachment",
                "uuid": "ignored",
                "attachment": {"type": "hook_success"},
            },
            "{not json",
        ],
    )

    result = scan_system_messages(projects)

    assert result.files_scanned == 1
    assert result.malformed_lines == 1
    assert result.system_events == 2
    assert result.subtypes["turn_duration"].count == 1
    assert result.subtypes["compact_boundary"].count == 1
    assert "durationMs" in result.subtypes["turn_duration"].fields
    assert "compactMetadata.preTokens" in result.subtypes["compact_boundary"].fields
    assert "compactMetadata.preCompactDiscoveredTools[]" in result.subtypes["compact_boundary"].fields


def test_scan_system_messages_parses_json_string_fields(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "system",
                "uuid": "sys1",
                "subtype": "informational",
                "content": json.dumps({"status": {"message": "Bridge connected"}}),
            },
        ],
    )

    result = scan_system_messages(projects)

    assert "content.$json.status.message" in result.subtypes["informational"].fields


def test_render_text_lists_system_subtype_counts(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "system",
                "uuid": "sys1",
                "subtype": "api_error",
                "error": {"status": 529, "message": "overloaded"},
            },
        ],
    )

    text = render_text(scan_system_messages(projects), field_limit=6)

    assert "System events: 1" in text
    assert "api_error" in text
    assert "error.status" in text
