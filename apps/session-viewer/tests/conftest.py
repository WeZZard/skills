from __future__ import annotations

import json
import sqlite3
import sys

from pathlib import Path
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def write_jsonl(path: Path, events: list[dict[str, Any] | str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for event in events:
            if isinstance(event, str):
                fh.write(event + "\n")
            else:
                fh.write(json.dumps(event) + "\n")


def write_opencode_db(data_dir: Path) -> Path:
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
        connection.execute(
            """
            insert into session (
                id, project_id, slug, directory, title, version, time_created,
                time_updated, path, agent, model, input_tokens, output_tokens
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "ses_opencode",
                "proj_1",
                "opencode-smoke",
                "/tmp/opencode-project",
                "OpenCode smoke session",
                "1.17.9",
                1760000000000,
                1760000005000,
                "/tmp/opencode-project",
                "build",
                json.dumps({"id": "gpt-5.5", "providerID": "openai"}),
                10,
                20,
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
                "ses_opencode_child",
                "proj_1",
                "ses_opencode",
                "opencode-child",
                "/tmp/opencode-project",
                "OpenCode child session",
                "1.17.9",
                1760000001150,
                1760000003000,
                "/tmp/opencode-project",
                "reviewer",
                json.dumps({"id": "gpt-5.5", "providerID": "openai"}),
                5,
                8,
            ),
        )
        messages = [
            (
                "msg_user",
                "ses_opencode",
                1760000000001,
                1760000000001,
                {"role": "user", "agent": "build", "modelID": "gpt-5.5", "providerID": "openai"},
            ),
            (
                "msg_assistant",
                "ses_opencode",
                1760000001000,
                1760000002000,
                {"role": "assistant", "agent": "build", "modelID": "gpt-5.5", "providerID": "openai", "finish": "stop"},
            ),
            (
                "msg_child",
                "ses_opencode_child",
                1760000001200,
                1760000002000,
                {"role": "assistant", "agent": "reviewer", "modelID": "gpt-5.5", "providerID": "openai", "finish": "stop"},
            ),
        ]
        connection.executemany(
            "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
            [(mid, sid, created, updated, json.dumps(data)) for mid, sid, created, updated, data in messages],
        )
        parts = [
            ("part_user_text", "msg_user", "ses_opencode", 1760000000001, {"type": "text", "text": "Investigate OpenCode parser"}),
            ("part_reasoning", "msg_assistant", "ses_opencode", 1760000001000, {"type": "reasoning", "text": "Need inspect the database rows."}),
            (
                "part_tool",
                "msg_assistant",
                "ses_opencode",
                1760000001100,
                {
                    "type": "tool",
                    "tool": "read",
                    "callID": "call_read_1",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "app/main.py"},
                        "output": "main.py contents",
                        "title": "Read app/main.py",
                    },
                },
            ),
            (
                "part_task",
                "msg_assistant",
                "ses_opencode",
                1760000001125,
                {
                    "type": "tool",
                    "tool": "task",
                    "callID": "call_task_1",
                    "state": {
                        "status": "completed",
                        "input": {"description": "OpenCode child review"},
                        "output": "child complete",
                        "title": "Run reviewer",
                    },
                },
            ),
            (
                "part_patch",
                "msg_assistant",
                "ses_opencode",
                1760000001200,
                {"type": "patch", "patch": "--- a/app/main.py\n+++ b/app/main.py\n@@\n+OpenCode"},
            ),
            (
                "part_file",
                "msg_assistant",
                "ses_opencode",
                1760000001300,
                {"type": "file", "path": "app/main.py", "content": "from fastapi import FastAPI"},
            ),
            (
                "part_compaction",
                "msg_assistant",
                "ses_opencode",
                1760000001400,
                {"type": "compaction", "summary": "Compacted prior context"},
            ),
            (
                "part_step_start",
                "msg_assistant",
                "ses_opencode",
                1760000001500,
                {"type": "step-start", "title": "Implement parser"},
            ),
            (
                "part_step_finish",
                "msg_assistant",
                "ses_opencode",
                1760000001600,
                {"type": "step-finish", "title": "Parser done", "status": "completed"},
            ),
            (
                "part_child_text",
                "msg_child",
                "ses_opencode_child",
                1760000001300,
                {"type": "text", "text": "Child reviewer transcript"},
            ),
        ]
        connection.executemany(
            "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
            [(pid, mid, sid, created, created, json.dumps(data)) for pid, mid, sid, created, data in parts],
        )
        connection.commit()
    finally:
        connection.close()
    return db_path


def user_event(uuid: str, parent: str | None, session: str, text: str, *, ts: str = "2026-01-01T00:00:00.000Z", agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "parentUuid": parent,
        "isSidechain": bool(agent_id),
        "sessionId": session,
        "agentId": agent_id,
        "timestamp": ts,
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def assistant_tool(uuid: str, parent: str | None, session: str, tool_id: str, name: str = "Task", *, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": parent,
        "isSidechain": bool(agent_id),
        "sessionId": session,
        "agentId": agent_id,
        "timestamp": "2026-01-01T00:00:01.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "stop_reason": "tool_use",
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": name,
                    "input": {"description": f"Run {name}", "subagent_type": "general"},
                }
            ],
        },
    }


def tool_result(uuid: str, parent: str | None, session: str, tool_id: str, text: str, *, agent_id: str | None = None, is_error: bool = False, sidechain_agent: str | None = None) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "user",
        "uuid": uuid,
        "parentUuid": parent,
        "isSidechain": bool(sidechain_agent),
        "sessionId": session,
        "agentId": sidechain_agent,
        "timestamp": "2026-01-01T00:00:02.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": is_error}
            ],
        },
    }
    if agent_id:
        event["toolUseResult"] = {"agentId": agent_id}
    return event


@pytest.fixture()
def claude_projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    projects = tmp_path / "claude-home" / "projects"
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(projects))
    monkeypatch.delenv("CLAUDE_CODE_HOME", raising=False)
    return projects


@pytest.fixture()
def populated_projects(claude_projects: Path) -> Path:
    project = claude_projects / "-tmp-project"
    session = "sess-main"
    write_jsonl(
        project / f"{session}.jsonl",
        [
            user_event("u1", None, session, "Debug Amplify run"),
            assistant_tool("a1", "u1", session, "toolu_task"),
            tool_result("r1", "a1", session, "toolu_task", "Done", agent_id="agent-a"),
        ],
    )
    write_jsonl(
        project / session / "subagents" / "agent-agent-a.jsonl",
        [
            user_event("su1", None, session, "Subagent start", agent_id="agent-a"),
            assistant_tool("sa1", "su1", session, "toolu_nested", agent_id="agent-a"),
            tool_result(
                "sr1",
                "sa1",
                session,
                "toolu_nested",
                "Error: nested failed",
                agent_id="agent-b",
                is_error=True,
                sidechain_agent="agent-a",
            ),
        ],
    )
    write_jsonl(
        project / session / "subagents" / "agent-agent-b.jsonl",
        [user_event("bu1", None, session, "Nested subagent", agent_id="agent-b")],
    )
    return claude_projects


@pytest.fixture()
def opencode_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    data_dir = tmp_path / "opencode-data"
    write_opencode_db(data_dir)
    monkeypatch.setenv("OPENCODE_DATA_DIR", str(data_dir))
    return data_dir
