from __future__ import annotations

import json

from pathlib import Path

from fastapi.testclient import TestClient

from app.claude_store import list_sessions, load_conversation
from app.main import app

from tests.conftest import user_event, write_jsonl


def test_malformed_jsonl_is_diagnostic(claude_projects: Path):
    project = claude_projects / "-broken"
    write_jsonl(
        project / "broken-session.jsonl",
        [
            user_event("u1", None, "broken-session", "Hello"),
            '{"type": "assistant",',
        ],
    )

    session = list_sessions()[0]
    export = load_conversation(session.id)

    assert export is not None
    assert any(d.kind == "invalid_json" for d in export.parser_diagnostics)
    assert any(f.kind == "parser_diagnostic" for f in export.problem_flags)


def test_partial_final_jsonl_is_warning_diagnostic(claude_projects: Path):
    project = claude_projects / "-partial"
    project.mkdir(parents=True)
    path = project / "partial-session.jsonl"
    path.write_text(
        json.dumps(user_event("u1", None, "partial-session", "Hello")) + "\n" + '{"type": "assistant",',
        encoding="utf-8",
    )

    session = list_sessions()[0]
    export = load_conversation(session.id)

    assert export is not None
    assert any(d.kind == "partial_json" and d.severity == "warning" for d in export.parser_diagnostics)
    assert not any(d.kind == "invalid_json" for d in export.parser_diagnostics)


def test_attachment_event_renders_compact_summary(claude_projects: Path):
    project = claude_projects / "-attachment"
    write_jsonl(
        project / "attachment-session.jsonl",
        [
            user_event("u1", None, "attachment-session", "Hello"),
            {
                "type": "attachment",
                "uuid": "att1",
                "timestamp": "2026-01-01T00:00:01.000Z",
                "cwd": "/tmp/project",
                "attachment": {
                    "type": "hook",
                    "hookEventName": "PostToolUse",
                    "hookName": "lint",
                    "exitCode": 1,
                    "stdout": "x" * 2000,
                    "stderr": "failed",
                },
            },
        ],
    )

    session = list_sessions()[0]
    export = load_conversation(session.id)

    assert export is not None
    rendered_parts = [part for message in export.messages for part in message.parts]
    rendered_text = "\n".join(part.text or "" for part in rendered_parts)
    attachment_part = next(part for part in rendered_parts if part.type == "attachment")
    assert "Hook: PostToolUse/lint" in rendered_text
    assert "stdout truncated" in rendered_text
    assert "Open raw JSON for the full payload." not in rendered_text
    assert attachment_part.state
    assert attachment_part.state["kind"] == "attachment_event"
    assert attachment_part.state["stdoutTruncated"] is True
    assert attachment_part.state["stdoutLength"] == 2000
    assert len(rendered_text) < 900


def test_tool_relationship_diagnostics(claude_projects: Path):
    project = claude_projects / "-tool-diagnostics"
    session = "tool-diagnostics-session"
    write_jsonl(
        project / f"{session}.jsonl",
        [
            {
                "type": "assistant",
                "uuid": "a1",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "cwd": "/tmp/project",
                "message": {
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [
                        {"type": "tool_use", "id": "dup", "name": "Bash", "input": {}},
                        {"type": "tool_use", "id": "dup", "name": "Bash", "input": {}},
                        {"type": "tool_use", "id": "pending", "name": "Bash", "input": {}},
                    ],
                },
            },
            {
                "type": "user",
                "uuid": "r1",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "cwd": "/tmp/project",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "missing", "content": "orphan"}],
                },
            },
            {
                "type": "user",
                "uuid": "r2",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:02.000Z",
                "cwd": "/tmp/project",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "dup", "content": "first"}],
                },
            },
            {
                "type": "user",
                "uuid": "r3",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:03.000Z",
                "cwd": "/tmp/project",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "dup", "content": "second"}],
                },
            },
            {
                "type": "user",
                "uuid": "r4",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:04.000Z",
                "cwd": "/tmp/project",
                "message": {"role": "user", "content": [{"type": "tool_result", "content": "no id"}]},
            },
        ],
    )

    session_ref = list_sessions()[0]
    export = load_conversation(session_ref.id)

    assert export is not None
    kinds = {diagnostic.kind for diagnostic in export.parser_diagnostics}
    assert "duplicate_tool_use_id" in kinds
    assert "orphan_tool_result" in kinds
    assert "duplicate_tool_result_id" in kinds
    assert "missing_tool_result_id" in kinds
    assert "missing_tool_result" in kinds
    assert any(flag.kind == "parser_diagnostic" for flag in export.problem_flags)


def test_dashboard_and_api_routes(populated_projects: Path, opencode_data_dir: Path):
    client = TestClient(app)

    dashboard = client.get("/")
    assert dashboard.status_code == 200
    assert "Claude Code sessions" in dashboard.text
    assert "Open Code sessions" in dashboard.text
    assert "Debug Amplify run" in dashboard.text
    assert "sources configured when the server starts" in dashboard.text
    assert "data-testid=\"claude-source-form\"" not in dashboard.text
    assert "data-testid=\"claude-open-source-button\"" not in dashboard.text
    assert "data-location-browser" not in dashboard.text
    assert ">Choose</button>" not in dashboard.text
    assert "claude_home" not in dashboard.text
    assert "opencode_data_dir" not in dashboard.text
    assert "claude_q" in dashboard.text
    assert "opencode_q" in dashboard.text

    fs_directories = client.get("/api/fs/directories", params={"path": str(populated_projects.parent)})
    assert fs_directories.status_code == 404

    sessions = client.get("/api/sessions")
    assert sessions.status_code == 200
    session_id = sessions.json()[0]["id"]

    conversation = client.get(f"/conversation/{session_id}")
    assert conversation.status_code == 200
    assert "data-testid=\"conversation-workbench\"" in conversation.text
    assert "data-testid=\"transcript-root\"" in conversation.text
    assert 'data-agent="claude"' in conversation.text
    assert 'data-default-layout="graph"' in conversation.text

    api = client.get(f"/api/conversation/{session_id}")
    assert api.status_code == 200
    data = api.json()
    assert data["summary"]["title"] == "Debug Amplify run"
    assert data["subagent_transcripts"]

    agent_conversation = client.get(f"/conversation/claude/{session_id}")
    assert agent_conversation.status_code == 200
    assert "data-testid=\"conversation-workbench\"" in agent_conversation.text

    agent_api = client.get(f"/api/conversation/claude/{session_id}")
    assert agent_api.status_code == 200
    assert agent_api.json()["summary"]["title"] == "Debug Amplify run"

    opencode_sessions = client.get(
        "/api/sessions",
        params={"agent": "opencode"},
    )
    assert opencode_sessions.status_code == 200
    opencode_session_id = opencode_sessions.json()[0]["id"]

    opencode_dashboard = client.get(
        "/",
        params={
            "tab": "opencode",
            "opencode_q": "smoke",
            "claude_q": "Debug",
        },
    )
    assert opencode_dashboard.status_code == 200
    assert "OpenCode smoke session" in opencode_dashboard.text
    assert "Open Code Home" not in opencode_dashboard.text
    assert "data-testid=\"opencode-read-path\"" not in opencode_dashboard.text
    assert "data-testid=\"opencode-open-source-button\"" not in opencode_dashboard.text
    assert f"/conversation/opencode/{opencode_session_id}" in opencode_dashboard.text
    assert "name=\"claude_q\" value=\"Debug\"" in opencode_dashboard.text

    opencode_conversation = client.get(f"/conversation/opencode/{opencode_session_id}")
    assert opencode_conversation.status_code == 200
    assert "data-testid=\"conversation-workbench\"" in opencode_conversation.text
    assert "data-testid=\"transcript-root\"" in opencode_conversation.text
    assert 'data-agent="opencode"' in opencode_conversation.text
    assert 'data-default-layout="reader"' in opencode_conversation.text

    opencode_api = client.get(f"/api/conversation/opencode/{opencode_session_id}")
    assert opencode_api.status_code == 200
    assert opencode_api.json()["summary"]["title"] == "OpenCode smoke session"


def test_missing_source_empty_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(tmp_path / "missing"))
    client = TestClient(app)

    response = client.get("/")
    assert response.status_code == 200
    assert "No readable Claude projects directory" in response.text
