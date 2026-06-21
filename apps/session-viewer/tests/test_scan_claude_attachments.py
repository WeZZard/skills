from __future__ import annotations

import json

from pathlib import Path

from scripts.scan_claude_attachments import render_text, scan_attachments

from tests.conftest import write_jsonl


def test_scan_attachments_counts_types_and_json_string_fields(tmp_path: Path) -> None:
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
                                "additionalContext": "Use semantic attachment cards.",
                            }
                        }
                    ),
                },
            },
            {
                "type": "attachment",
                "uuid": "att2",
                "attachment": {
                    "type": "deferred_tools_delta",
                    "addedNames": ["Read", "Grep"],
                    "removedNames": [],
                },
            },
            {"type": "user", "message": {"role": "user", "content": "ignored"}},
            "{not json",
        ],
    )

    result = scan_attachments(projects)

    assert result.files_scanned == 1
    assert result.malformed_lines == 1
    assert result.attachment_events == 2
    assert result.types["hook_success"].count == 1
    assert result.types["deferred_tools_delta"].count == 1
    assert "stdout.$json.hookSpecificOutput.additionalContext" in result.types["hook_success"].fields
    assert "addedNames[]" in result.types["deferred_tools_delta"].fields


def test_render_text_lists_attachment_type_counts(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    write_jsonl(
        projects / "-fixture" / "session.jsonl",
        [
            {
                "type": "attachment",
                "uuid": "att1",
                "attachment": {"type": "task_reminder", "content": ["Run verification"]},
            },
        ],
    )

    text = render_text(scan_attachments(projects), field_limit=5)

    assert "Attachment events: 1" in text
    assert "task_reminder" in text
    assert "content[]" in text
