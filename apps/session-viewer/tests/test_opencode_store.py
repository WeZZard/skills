from __future__ import annotations

import sqlite3

from pathlib import Path

from app.opencode_store import get_source_info, list_directories, list_sessions, load_conversation


def test_opencode_lists_sessions(opencode_data_dir: Path):
    sessions = list_sessions(source_path=opencode_data_dir)

    assert len(sessions) == 1
    assert sessions[0].id == "ses_opencode"
    assert sessions[0].title == "OpenCode smoke session"
    assert sessions[0].directory == "/tmp/opencode-project"
    assert sessions[0].model == "openai/gpt-5.5"
    assert sessions[0].message_count == 2
    assert sessions[0].subagent_count == 1


def test_opencode_search_and_directory_filter(opencode_data_dir: Path):
    assert [s.id for s in list_sessions(query="smoke", source_path=opencode_data_dir)] == ["ses_opencode"]
    assert [s.id for s in list_sessions(directory="opencode-project", source_path=opencode_data_dir)] == ["ses_opencode"]
    assert list_sessions(query="missing", source_path=opencode_data_dir) == []
    assert list_directories(source_path=opencode_data_dir) == ["/tmp/opencode-project"]


def test_opencode_loads_readable_conversation(opencode_data_dir: Path):
    export = load_conversation("ses_opencode", source_path=opencode_data_dir)

    assert export is not None
    assert export.agent_type == "opencode"
    assert export.summary.title == "OpenCode smoke session"
    assert export.summary.subagent_count == 1
    assert [message.role for message in export.messages] == ["user", "assistant"]
    assert len(export.subagent_transcripts) == 1
    child = export.subagent_transcripts[0]
    assert child.summary.id == "ses_opencode_child"
    assert child.summary.title == "OpenCode child session"
    assert child.agent_type == "reviewer"
    assert child.parent_task_nav is not None
    assert child.parent_task_nav.toolUseId == "call_task_1"
    assert child.parent_result_nav is not None
    assert child.relationship_basis == "OpenCode session.parent_id and task order"
    assert child.messages[0].nav is not None
    assert child.messages[0].nav.agentPath == "main/ses_opencode_child"

    parts = [part for message in export.messages for part in message.parts]
    types = [part.type for part in parts]
    assert "text" in types
    assert "reasoning" in types
    assert "tool" in types
    assert "tool_result" in types
    assert "patch" in types
    assert "file" in types
    assert "compaction" in types
    assert "step-start" in types
    assert "step-finish" in types
    assert any(part.text and "OpenCode" in part.text for part in parts)
    assert any(part.nav and part.nav.jsonlFile.endswith("opencode.db") for part in parts)


def test_opencode_part_state_is_enriched(opencode_data_dir: Path):
    export = load_conversation("ses_opencode", source_path=opencode_data_dir)
    parts = [part for message in export.messages for part in message.parts]
    by_type = {part.type: part for part in parts}

    text_part = by_type["text"]
    assert text_part.state["kind"] == "opencode_text"
    assert "preview" in text_part.state

    reasoning_part = by_type["reasoning"]
    assert reasoning_part.state["kind"] == "opencode_reasoning"
    assert "preview" in reasoning_part.state

    tool_parts = [part for part in parts if part.type == "tool"]
    read_tool = next(part for part in tool_parts if part.state["toolName"] == "read")
    assert read_tool.state["kind"] == "opencode_tool"
    assert read_tool.state["callID"] == "call_read_1"
    assert read_tool.state["title"] == "Read app/main.py"
    assert read_tool.state["status"] == "completed"
    assert read_tool.state["input"] == {"filePath": "app/main.py"}
    assert read_tool.state["output"] == "main.py contents"

    task_tool = next(part for part in tool_parts if part.state["toolName"] == "task")
    assert task_tool.state["kind"] == "opencode_tool"
    assert task_tool.state["callID"] == "call_task_1"

    result_parts = [part for part in parts if part.type == "tool_result"]
    read_result = next(part for part in result_parts if part.state["tool_use_id"] == "call_read_1")
    assert read_result.state["kind"] == "opencode_tool_result"
    assert read_result.state["is_error"] is False
    assert read_result.state["toolName"] == "read"

    patch_part = by_type["patch"]
    assert patch_part.state["kind"] == "opencode_patch"
    assert patch_part.state["path"] == "app/main.py"
    assert patch_part.state["language"] == "py"
    assert "+OpenCode" in patch_part.state["diff"]
    assert patch_part.state["added"] == 1
    assert patch_part.state["removed"] == 0

    file_part = by_type["file"]
    assert file_part.state["kind"] == "opencode_file"
    assert file_part.state["path"] == "app/main.py"
    assert file_part.state["language"] == "py"
    assert "FastAPI" in file_part.state["content"]
    assert file_part.state["lineCount"] == 1

    compaction_part = by_type["compaction"]
    assert compaction_part.state["kind"] == "opencode_compaction"
    assert compaction_part.state["summary"] == "Compacted prior context"

    step_start = next(part for part in parts if part.type == "step-start")
    assert step_start.state["kind"] == "opencode_step"
    assert step_start.state["stepType"] == "start"
    assert step_start.state["title"] == "Implement parser"
    assert step_start.state["status"] == "started"

    step_finish = next(part for part in parts if part.type == "step-finish")
    assert step_finish.state["kind"] == "opencode_step"
    assert step_finish.state["stepType"] == "finish"
    assert step_finish.state["title"] == "Parser done"
    assert step_finish.state["status"] == "completed"


def test_opencode_missing_db_source_info(tmp_path: Path):
    source = get_source_info(tmp_path / "missing")

    assert source["exists"] is False
    assert source["readable"] is False
    assert list_sessions(source_path=tmp_path / "missing") == []
    assert load_conversation("ses_missing", source_path=tmp_path / "missing") is None


def test_opencode_malformed_json_diagnostic(tmp_path: Path):
    data_dir = tmp_path / "bad-opencode"
    data_dir.mkdir()
    connection = sqlite3.connect(data_dir / "opencode.db")
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
                model text
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
        connection.execute(
            "insert into session (id, directory, title, model) values (?, ?, ?, ?)",
            ("ses_bad", "/tmp/bad", "Bad OpenCode", '{"id":"gpt-5.5","providerID":"openai"}'),
        )
        connection.execute(
            "insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)",
            ("msg_bad", "ses_bad", 1, '{"role": "assistant"'),
        )
        connection.commit()
    finally:
        connection.close()

    export = load_conversation("ses_bad", source_path=data_dir)

    assert export is not None
    assert any(d.kind == "invalid_json" for d in export.parser_diagnostics)
    assert any(f.kind == "parser_diagnostic" for f in export.problem_flags)
