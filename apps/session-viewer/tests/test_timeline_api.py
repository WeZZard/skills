from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.claude_store import list_sessions
from app.main import app


@pytest.fixture()
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cache = tmp_path / "viewer-cache"
    monkeypatch.setenv("SESSION_VIEWER_CACHE_DIR", str(cache))
    return cache


def _session_id() -> str:
    return list_sessions()[0].id


def test_timeline_payload_shape(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    response = client.get(f"/api/conversation/claude/{_session_id()}/timeline")
    assert response.status_code == 200
    payload = response.json()

    assert payload["protocol"] == 2
    assert payload["messages"] == []
    assert payload["raw_events"] == []
    assert payload["jsonl_file"].endswith("sess-main.jsonl")

    seeds = payload["capsule_seeds"]
    assert [seed["ln"] for seed in seeds] == [1, 2, 3]
    assert all(seed["k"] == "m" for seed in seeds)
    # The Task tool part carries its nav ingredients so the client can rebuild
    # the part nav key (spawn-edge + tool-pair resolution).
    task_parts = seeds[1]["parts"]
    assert task_parts[0][0] == "tool"
    assert task_parts[0][4] == "tool_use"
    assert task_parts[0][6] == "toolu_task"

    children = payload["subagent_transcripts"]
    assert len(children) == 2
    by_path = {child["first_nav"]["agentPath"]: child for child in children}
    assert by_path["main/agent-a"]["capsule_count"] == 3
    assert by_path["main/agent-b"]["capsule_count"] == 1


def test_timeline_etag_roundtrip(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    url = f"/api/conversation/claude/{_session_id()}/timeline"
    first = client.get(url)
    assert first.status_code == 200
    etag = first.headers["etag"]
    revalidated = client.get(url, headers={"If-None-Match": etag})
    assert revalidated.status_code == 304


def test_timeline_served_from_index_cache(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    url = f"/api/conversation/claude/{_session_id()}/timeline"
    assert client.get(url).status_code == 200
    index_files = list(cache_dir.rglob("*.sqlite3"))
    assert index_files, "expected a persistent per-session index database"
    again = client.get(url)
    assert again.status_code == 200
    assert again.json()["protocol"] == 2


def test_track_endpoint_parses_single_file(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    response = client.get(f"/api/conversation/claude/{_session_id()}/track/main/agent-a")
    assert response.status_code == 200
    payload = response.json()
    assert payload["agentPath"] == "main/agent-a"
    assert len(payload["messages"]) == 3
    assert payload["agent_type"] == "Explore"
    # raw_events are slim: the verbatim raw line never ships in track payloads
    assert payload["raw_events"]
    assert all("raw" not in event for event in payload["raw_events"])


def test_track_endpoint_rejects_traversal_ids(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    response = client.get(f"/api/conversation/claude/{_session_id()}/track/main/..%2F..%2Fescape")
    assert response.status_code == 404


def test_message_endpoint_returns_full_message(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    response = client.get(
        f"/api/conversation/claude/{_session_id()}/message",
        params={"track_id": "main", "line_number": 2},
    )
    assert response.status_code == 200
    payload = response.json()
    message = payload["message"]
    assert message["parts"][0]["type"] == "tool"
    assert message["parts"][0]["state"]["input"]["description"] == "Run Task"
    assert payload["raw_event"]["raw"]["uuid"] == "a1"


def test_raw_event_direct_read_and_containment(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    session_id = _session_id()
    main_file = populated_projects / "-tmp-project" / "sess-main.jsonl"
    ok = client.get(
        f"/api/conversation/claude/{session_id}/raw_event",
        params={"jsonl_file": str(main_file), "line_number": 1},
    )
    assert ok.status_code == 200
    assert ok.json()["raw"]["uuid"] == "u1"
    assert ok.json()["nav"]["agentPath"] == "main"

    outside = client.get(
        f"/api/conversation/claude/{session_id}/raw_event",
        params={"jsonl_file": "/etc/hosts", "line_number": 1},
    )
    assert outside.status_code == 403


def test_boot_endpoint_still_serves_v1(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    response = client.get(f"/api/conversation/claude/{_session_id()}/boot")
    assert response.status_code == 200
    payload = response.json()
    assert payload["messages"], "v1 boot keeps full main messages for compatibility"


def test_timeline_gzip_bytes_are_valid(populated_projects: Path, cache_dir: Path):
    client = TestClient(app)
    url = f"/api/conversation/claude/{_session_id()}/timeline"
    assert client.get(url).status_code == 200
    index_files = list(cache_dir.rglob("*.sqlite3"))
    assert index_files
    import sqlite3

    connection = sqlite3.connect(index_files[0])
    row = connection.execute("SELECT payload FROM boot_cache").fetchone()
    connection.close()
    payload = json.loads(gzip.decompress(row[0]))
    assert payload["protocol"] == 2
