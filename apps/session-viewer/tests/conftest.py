from __future__ import annotations

import json
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
