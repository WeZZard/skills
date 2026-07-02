from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from app.capsules import capsule_seeds
from app.claude_store import list_sessions, load_track
from app.session_index import SessionIndex, _scan_line_count

from tests.conftest import write_jsonl


@pytest.fixture()
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cache = tmp_path / "viewer-cache"
    monkeypatch.setenv("SESSION_VIEWER_CACHE_DIR", str(cache))
    return cache


def test_scan_line_count_handles_partial_final_line(tmp_path: Path):
    path = tmp_path / "events.jsonl"
    path.write_text('{"a":1}\n{"b":2}\n{"partial', encoding="utf-8")
    assert _scan_line_count(path) == 3


def test_line_count_caches_by_stat_and_invalidates(cache_dir: Path, tmp_path: Path):
    index = SessionIndex.open("session-x")
    assert index is not None
    path = tmp_path / "track.jsonl"
    write_jsonl(path, [{"n": i} for i in range(5)])
    assert index.line_count(path) == 5

    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"n": 5}\n{"n": 6}\n')
    assert index.line_count(path) == 7

    write_jsonl(path, [{"n": 0}])
    assert index.line_count(path) == 1
    index.close()


def test_boot_cache_roundtrip_and_prune(cache_dir: Path):
    index = SessionIndex.open("session-y")
    assert index is not None
    for generation in range(4):
        body = index.store_boot(f"fp-{generation}", {"protocol": 2, "generation": generation})
        assert json.loads(gzip.decompress(body))["generation"] == generation
    assert index.cached_boot("fp-3") is not None
    assert index.cached_boot("fp-0") is None, "old fingerprints are pruned"
    index.close()


def test_capsule_count_matches_line_count(populated_projects: Path, cache_dir: Path):
    """Geometry identity: one capsule seed per non-blank JSONL line, so the
    newline scan used for unloaded lanes matches parsed capsule counts."""
    session_id = list_sessions()[0].id
    index = SessionIndex.open(session_id)
    assert index is not None
    for track_id, file_name in [
        ("main", "sess-main.jsonl"),
        ("main/agent-a", "sess-main/subagents/agent-agent-a.jsonl"),
        ("main/agent-b", "sess-main/subagents/agent-agent-b.jsonl"),
    ]:
        export = load_track(session_id, track_id)
        assert export is not None
        seeds = capsule_seeds(export)
        path = populated_projects / "-tmp-project" / file_name
        assert len(seeds) == index.line_count(path), track_id
    index.close()


def test_seed_order_messages_then_leftover_raw(populated_projects: Path, tmp_path: Path, monkeypatch):
    session_id = list_sessions()[0].id
    main = load_track(session_id, "main")
    seeds = capsule_seeds(main)
    assert [seed["k"] for seed in seeds] == ["m", "m", "m"]
    assert [seed["ln"] for seed in seeds] == sorted(seed["ln"] for seed in seeds)


def test_raw_only_lines_become_raw_seeds(claude_projects: Path, cache_dir: Path):
    project = claude_projects / "-raw-heavy"
    session = "sess-raw"
    write_jsonl(
        project / f"{session}.jsonl",
        [
            {
                "type": "user",
                "uuid": "u1",
                "sessionId": session,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "cwd": "/tmp/p",
                "message": {"role": "user", "content": [{"type": "text", "text": "Hi"}]},
            },
            {"type": "summary", "summary": "A summary line", "leafUuid": "u1"},
        ],
    )
    session_id = list_sessions()[0].id
    export = load_track(session_id, "main")
    seeds = capsule_seeds(export)
    assert len(seeds) == 2
    assert seeds[0]["k"] == "m"
    assert seeds[1]["k"] == "r"
    assert seeds[1]["rt"] == "summary"
