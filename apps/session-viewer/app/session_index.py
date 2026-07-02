"""Persistent per-session index for the timeline protocol v2.

One SQLite file per Claude session under the viewer's cache directory (never
inside ~/.claude/projects). It stores:

- ``file_lines``: newline counts per transcript file keyed by (mtime_ns,
  size), so a boot only re-scans files that changed. One capsule == one
  non-blank JSONL line, so these counts give full timeline geometry without
  parsing.
- ``boot_cache``: the fully built /timeline JSON payload, gzip-compressed,
  keyed by the session fingerprint. A warm boot is a single SELECT.

The index is a cache: deleting it only costs a rebuild.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
_SCAN_CHUNK = 1 << 20


def _resolve_cache_dir() -> Path:
    import os

    override = os.environ.get("SESSION_VIEWER_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path("~/.cache/session-viewer").expanduser()


def index_db_path(opaque_id: str) -> Path:
    digest = hashlib.sha1(opaque_id.encode()).hexdigest()[:16]
    return _resolve_cache_dir() / "index" / f"v{SCHEMA_VERSION}" / f"{digest}.sqlite3"


class SessionIndex:
    def __init__(self, connection: sqlite3.Connection):
        self._db = connection

    @classmethod
    def open(cls, opaque_id: str) -> "SessionIndex | None":
        path = index_db_path(opaque_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(str(path), timeout=5.0)
        except (OSError, sqlite3.Error):
            return None
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS file_lines ("
                "path TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER, line_count INTEGER)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS boot_cache ("
                "fingerprint TEXT PRIMARY KEY, payload BLOB, created_at TEXT)"
            )
            db.commit()
        except sqlite3.Error:
            db.close()
            return None
        return cls(db)

    def close(self) -> None:
        try:
            self._db.close()
        except sqlite3.Error:
            pass

    # -- line counts -------------------------------------------------------

    def line_count(self, path: Path) -> int:
        """Newline count for a transcript file, cached by (mtime_ns, size)."""
        try:
            stat = path.stat()
        except OSError:
            return 0
        key = str(path)
        row = self._db.execute(
            "SELECT mtime_ns, size, line_count FROM file_lines WHERE path = ?", (key,)
        ).fetchone()
        if row and row[0] == stat.st_mtime_ns and row[1] == stat.st_size:
            return int(row[2])
        count = _scan_line_count(path)
        try:
            self._db.execute(
                "INSERT INTO file_lines (path, mtime_ns, size, line_count) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET mtime_ns=excluded.mtime_ns, "
                "size=excluded.size, line_count=excluded.line_count",
                (key, stat.st_mtime_ns, stat.st_size, count),
            )
            self._db.commit()
        except sqlite3.Error:
            pass
        return count

    # -- boot payload cache --------------------------------------------------

    def cached_boot(self, fingerprint: str) -> bytes | None:
        """Gzip-compressed /timeline payload for this fingerprint, if stored."""
        row = self._db.execute(
            "SELECT payload FROM boot_cache WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        return bytes(row[0]) if row else None

    def store_boot(self, fingerprint: str, payload: dict[str, Any]) -> bytes:
        body = gzip.compress(
            json.dumps(payload, separators=(",", ":")).encode("utf-8"), compresslevel=6
        )
        try:
            self._db.execute(
                "INSERT OR REPLACE INTO boot_cache (fingerprint, payload, created_at) "
                "VALUES (?, ?, datetime('now'))",
                (fingerprint, body),
            )
            # A session rarely has more than one live fingerprint; keep the
            # two most recent so a mid-write reload does not thrash. rowid
            # order is insertion order (REPLACE assigns a fresh rowid).
            self._db.execute(
                "DELETE FROM boot_cache WHERE fingerprint NOT IN ("
                "SELECT fingerprint FROM boot_cache ORDER BY rowid DESC LIMIT 2)"
            )
            self._db.commit()
        except sqlite3.Error:
            pass
        return body


def _scan_line_count(path: Path) -> int:
    count = 0
    ends_with_newline = True
    try:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(_SCAN_CHUNK)
                if not chunk:
                    break
                count += chunk.count(b"\n")
                ends_with_newline = chunk.endswith(b"\n")
    except OSError:
        return 0
    if not ends_with_newline:
        count += 1
    return count
