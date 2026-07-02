from __future__ import annotations

import hashlib
import json
import sqlite3

from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.claude_parser import json_pointer, parse_timestamp, title_candidate_from_text
from app.config import opencode_source_info, resolve_opencode_data_dir
from app.models import (
    ConversationExport,
    ConversationSummary,
    GenericPart,
    Message,
    ModelInfo,
    NavAddress,
    ParserDiagnostic,
    RawEvent,
)
from app.problem_detector import attach_problem_flags


def _db_path(source_path: str | Path | None = None) -> Path:
    return resolve_opencode_data_dir(source_path) / "opencode.db"


def session_fingerprint(session_id: str, source_path: str | Path | None = None) -> str | None:
    """Cheap change-detection fingerprint: the OpenCode database file stats."""
    try:
        stat = _db_path(source_path).stat()
    except OSError:
        return None
    digest = hashlib.sha1(f"{session_id}:{stat.st_mtime_ns}:{stat.st_size}".encode())
    return digest.hexdigest()


def _connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{quote(str(db_path.resolve()), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    data = json.loads(value)
    return data if isinstance(data, dict) else {}


def _safe_json_dict(value: Any) -> dict[str, Any]:
    try:
        return _json_dict(value)
    except json.JSONDecodeError:
        return {}


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _time_from_row(row: dict[str, Any], data: dict[str, Any], key: str) -> int | None:
    value = _int_or_none(row.get(key))
    if value is not None:
        return value
    time_data = data.get("time")
    if isinstance(time_data, dict):
        for candidate in (key, key.removeprefix("time_"), "created", "updated"):
            value = _int_or_none(time_data.get(candidate))
            if value is not None:
                return value
    timestamp = data.get(key) or data.get(key.removeprefix("time_"))
    if isinstance(timestamp, str):
        return parse_timestamp(timestamp)
    return _int_or_none(timestamp)


def _model_label(value: Any) -> str:
    data = _safe_json_dict(value)
    provider = data.get("providerID") or data.get("provider")
    model = data.get("modelID") or data.get("id") or data.get("model")
    if provider and model:
        return f"{provider}/{model}"
    if model:
        return str(model)
    if provider:
        return str(provider)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "Unknown"


def _message_count(connection: sqlite3.Connection, session_id: str) -> int:
    row = connection.execute(
        "select count(*) as count from message where session_id = ?",
        (session_id,),
    ).fetchone()
    return int(row["count"] or 0) if row else 0


def _subagent_count(connection: sqlite3.Connection, session_id: str) -> int:
    row = connection.execute(
        "select count(*) as count from session where parent_id = ?",
        (session_id,),
    ).fetchone()
    return int(row["count"] or 0) if row else 0


def _summary_from_session_row(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
) -> ConversationSummary:
    data = _row_dict(row)
    model = _model_label(data.get("model"))
    title = data.get("title") or data.get("slug") or data.get("id")
    return ConversationSummary(
        id=str(data.get("id")),
        title=str(title) if title else str(data.get("id")),
        directory=str(data.get("directory")) if data.get("directory") else None,
        version=str(data.get("version")) if data.get("version") else None,
        projectID=str(data.get("project_id")) if data.get("project_id") else None,
        parent_id=str(data.get("parent_id")) if data.get("parent_id") else None,
        time_created=_int_or_none(data.get("time_created")),
        time_updated=_int_or_none(data.get("time_updated")),
        model=model,
        message_count=_message_count(connection, str(data.get("id"))),
        subagent_count=_subagent_count(connection, str(data.get("id"))),
    )


def list_sessions(
    query: str | None = None,
    directory: str | None = None,
    source_path: str | Path | None = None,
) -> list[ConversationSummary]:
    db_path = _db_path(source_path)
    if not db_path.is_file():
        return []
    try:
        with _connect_readonly(db_path) as connection:
            rows = connection.execute(
                """
                select *
                from session
                where parent_id is null or parent_id = ''
                order by coalesce(time_updated, time_created, 0) desc, id desc
                """
            ).fetchall()
            summaries = [_summary_from_session_row(connection, row) for row in rows]
    except sqlite3.Error:
        return []

    filtered: list[ConversationSummary] = []
    query_text = (query or "").lower()
    directory_text = (directory or "").lower()
    for summary in summaries:
        haystack = " ".join(
            [
                summary.title or "",
                summary.directory or "",
                summary.model or "",
                summary.id,
                summary.project_id or "",
                summary.parent_id or "",
            ]
        ).lower()
        if query_text and query_text not in haystack:
            continue
        if directory_text and directory_text not in (summary.directory or "").lower():
            continue
        filtered.append(summary)
    return filtered


def list_directories(source_path: str | Path | None = None) -> list[str]:
    return sorted({s.directory for s in list_sessions(source_path=source_path) if s.directory})


def get_summary(session_id: str, source_path: str | Path | None = None) -> ConversationSummary | None:
    db_path = _db_path(source_path)
    if not db_path.is_file():
        return None
    try:
        with _connect_readonly(db_path) as connection:
            row = connection.execute(
                "select * from session where id = ?", (session_id,)
            ).fetchone()
            if row is None:
                return None
            return _summary_from_session_row(connection, row)
    except sqlite3.Error:
        return None


class _OpenCodeParser:
    def __init__(
        self,
        db_path: Path,
        session_id: str,
        *,
        scope: str = "main",
        agent_path: str = "main",
    ) -> None:
        self.db_path = db_path
        self.session_id = session_id
        self.scope = scope
        self.agent_path = agent_path
        self.event_index = 0
        self.raw_events: list[RawEvent] = []
        self.diagnostics: list[ParserDiagnostic] = []
        self.nav_index: list[NavAddress] = []

    def nav(
        self,
        *,
        element_type: str,
        message_id: str | None = None,
        content_index: int | None = None,
        tool_use_id: str | None = None,
        pointer: str | None = None,
        view: str = "rendered",
        line_number: int | None = None,
    ) -> NavAddress:
        return NavAddress(
            sessionId=self.session_id,
            jsonlFile=str(self.db_path),
            lineNumber=line_number or self.event_index + 1,
            eventIndex=self.event_index,
            scope=self.scope,
            agentPath=self.agent_path,
            elementType=element_type,
            view=view,
            messageId=message_id,
            contentIndex=content_index,
            toolUseId=tool_use_id,
            jsonPointer=pointer,
        )

    def add_raw_row(self, table: str, row: dict[str, Any], parsed_data: dict[str, Any] | None = None) -> NavAddress:
        nav = self.nav(
            element_type=table,
            pointer=json_pointer(table),
            view="raw",
        )
        raw = {"table": table, "row": row}
        if parsed_data is not None:
            raw["data"] = parsed_data
        self.raw_events.append(RawEvent(id=f"{self.db_path}:{table}:{row.get('id', self.event_index)}", nav=nav, raw=raw))
        self.nav_index.append(nav)
        self.event_index += 1
        return nav

    def add_json_diagnostic(self, table: str, row: dict[str, Any], exc: json.JSONDecodeError, nav: NavAddress) -> None:
        self.diagnostics.append(
            ParserDiagnostic(
                id=f"opencode-json:{table}:{row.get('id', nav.lineNumber)}",
                severity="error",
                kind="invalid_json",
                message=f"OpenCode {table} row {row.get('id', nav.lineNumber)} has invalid JSON data: {exc}",
                nav=nav,
            )
        )


def _part_text(data: dict[str, Any], part_type: str) -> str:
    for key in ("text", "content", "summary", "message", "output", "diff", "patch"):
        value = data.get(key)
        if value is not None and value != "":
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    if part_type == "file":
        path = data.get("path") or data.get("filename") or data.get("name")
        body = data.get("content") or data.get("text")
        if path and body:
            return f"{path}\n\n{body}"
        if path:
            return str(path)
    if part_type in {"step-start", "step-finish"}:
        title = data.get("title") or data.get("name") or data.get("step")
        status = data.get("status")
        bits = [str(value) for value in (title, status) if value]
        if bits:
            return " · ".join(bits)
    return json.dumps(data, ensure_ascii=False, indent=2)


def _part_label_type(part_type: str) -> str:
    return part_type.replace("_", "-")


def _language_from_path(path: str | None) -> str | None:
    if not path:
        return None
    suffix = Path(path).suffix
    return suffix[1:] if suffix else None


def _line_count(value: Any) -> int | None:
    if isinstance(value, str):
        return len(value.splitlines())
    return None


def _diff_stats(diff: str) -> dict[str, int]:
    added = 0
    removed = 0
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++ "):
            added += 1
        elif line.startswith("-") and not line.startswith("--- "):
            removed += 1
    return {"added": added, "removed": removed}


def _path_from_diff(diff: str) -> str | None:
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            return line[6:].strip()
        if line.startswith("+++ "):
            return line[4:].strip()
    return None


def _patch_path(data: dict[str, Any]) -> str | None:
    return data.get("path") or data.get("filename") or _path_from_diff(data.get("patch") or "")


def _file_path(data: dict[str, Any]) -> str | None:
    return data.get("path") or data.get("filename") or data.get("name") or None


def _compact_text(value: Any, limit: int = 220) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    text = " ".join(text.split())
    return f"{text[: limit - 1]}..." if len(text) > limit else text


def _parts_for_row(
    parser: _OpenCodeParser,
    row: dict[str, Any],
    data: dict[str, Any],
    raw_nav: NavAddress,
    message_id: str,
    part_index: int,
) -> list[GenericPart]:
    part_type = str(data.get("type") or "raw_event")
    part_id = str(row.get("id") or data.get("id") or f"{message_id}:part:{part_index}")
    row_time = _time_from_row(row, data, "time_created")
    tool_call_id = str(data.get("callID") or data.get("callId") or data.get("id") or part_id)

    def part_nav(element_type: str, *, offset: int = 0, tool_use_id: str | None = None) -> NavAddress:
        return raw_nav.model_copy(
            update={
                "elementType": element_type,
                "view": "rendered",
                "messageId": message_id,
                "contentIndex": part_index + offset,
                "toolUseId": tool_use_id,
                "jsonPointer": json_pointer("part", "data"),
            }
        )

    def base_state(kind: str, **fields: Any) -> dict[str, Any]:
        return {"kind": kind, **fields}

    if part_type == "text":
        text = _part_text(data, part_type)
        if not text.strip():
            return []
        nav = part_nav("text")
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type="text",
                text=text,
                time_created=row_time,
                nav=nav,
                state=base_state("opencode_text", preview=_compact_text(text, 180)),
            )
        ]

    if part_type == "reasoning":
        text = _part_text(data, part_type)
        nav = part_nav("reasoning")
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type="reasoning",
                text=text,
                time_created=row_time,
                nav=nav,
                state=base_state("opencode_reasoning", preview=_compact_text(text, 180)),
            )
        ]

    if part_type == "tool":
        state = data.get("state") if isinstance(data.get("state"), dict) else {}
        tool_name = str(data.get("tool") or state.get("tool") or "tool").lower()
        status = str(state.get("status") or data.get("status") or "pending")
        input_data = state.get("input") if isinstance(state.get("input"), dict) else {}
        output = state.get("output")
        error = state.get("error")
        metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else data.get("metadata")
        title = state.get("title") or data.get("title") or tool_name
        tool_nav = part_nav("tool", tool_use_id=tool_call_id)
        parser.nav_index.append(tool_nav)
        parts = [
            GenericPart(
                id=tool_call_id,
                type="tool",
                tool=tool_name,
                time_created=row_time,
                nav=tool_nav,
                state=base_state(
                    "opencode_tool",
                    toolName=tool_name,
                    callID=tool_call_id,
                    title=title,
                    status=status,
                    input=input_data,
                    output=output if output is not None else None,
                    error=error if error is not None else None,
                    rawName=data.get("tool") or tool_name,
                    metadata=metadata if isinstance(metadata, dict) else None,
                ),
            )
        ]
        if output is not None or error is not None or status in {"completed", "error", "failed"}:
            result_text = error if error is not None else output
            result_nav = part_nav("tool_result", offset=10_000, tool_use_id=tool_call_id)
            parser.nav_index.append(result_nav)
            parts.append(
                GenericPart(
                    id=f"{tool_call_id}:result",
                    type="tool_result",
                    tool="tool_result",
                    text=result_text if isinstance(result_text, str) else json.dumps(result_text, ensure_ascii=False, indent=2),
                    time_created=row_time,
                    nav=result_nav,
                    state=base_state(
                        "opencode_tool_result",
                        tool_use_id=tool_call_id,
                        toolName=tool_name,
                        is_error=status in {"error", "failed"} or error is not None,
                        output=output if error is None else None,
                        error=error,
                    ),
                )
            )
        return parts

    if part_type == "patch":
        patch_text = data.get("patch") or data.get("diff") or ""
        path = _patch_path(data)
        stats = _diff_stats(patch_text) if isinstance(patch_text, str) else {"added": 0, "removed": 0}
        nav = part_nav("patch")
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type="patch",
                text=_part_text(data, part_type),
                time_created=row_time,
                nav=nav,
                state=base_state(
                    "opencode_patch",
                    path=path,
                    language=_language_from_path(path),
                    diff=patch_text,
                    added=stats["added"],
                    removed=stats["removed"],
                ),
            )
        ]

    if part_type == "file":
        path = _file_path(data)
        content = data.get("content") or data.get("text") or ""
        nav = part_nav("file")
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type="file",
                text=_part_text(data, part_type),
                time_created=row_time,
                nav=nav,
                state=base_state(
                    "opencode_file",
                    path=path,
                    language=_language_from_path(path),
                    content=content,
                    lineCount=_line_count(content),
                ),
            )
        ]

    if part_type == "compaction":
        nav = part_nav("compaction")
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type="compaction",
                text=_part_text(data, part_type),
                time_created=row_time,
                nav=nav,
                state=base_state(
                    "opencode_compaction",
                    summary=data.get("summary") or data.get("text") or "",
                    preTokens=data.get("preTokens"),
                    postTokens=data.get("postTokens"),
                ),
            )
        ]

    if part_type in {"step-start", "step-finish"}:
        title = data.get("title") or data.get("name") or data.get("step") or "Step"
        status = data.get("status") or ("started" if part_type == "step-start" else "finished")
        nav = part_nav(part_type.replace("_", "-"))
        parser.nav_index.append(nav)
        return [
            GenericPart(
                id=part_id,
                type=part_type.replace("_", "-"),
                text=_part_text(data, part_type),
                time_created=row_time,
                nav=nav,
                state=base_state(
                    "opencode_step",
                    stepType="start" if part_type == "step-start" else "finish",
                    title=title,
                    status=status,
                    durationMs=data.get("durationMs"),
                ),
            )
        ]

    visible_type = _part_label_type(part_type)
    nav = part_nav(visible_type)
    parser.nav_index.append(nav)
    return [
        GenericPart(
            id=part_id,
            type=visible_type,
            text=_part_text(data, part_type),
            time_created=row_time,
            nav=nav,
            state=base_state("opencode_part", partType=part_type, payload=data, preview=_compact_text(data, 180)),
        )
    ]


def _iter_tool_parts(export: ConversationExport) -> list[tuple[str | None, GenericPart]]:
    pairs: list[tuple[str | None, GenericPart]] = []
    for message in export.messages:
        for part in message.parts:
            if part.type == "tool":
                pairs.append((message.id, part))
    return pairs


def _tool_result_navs(export: ConversationExport) -> dict[str, NavAddress]:
    navs: dict[str, NavAddress] = {}
    for message in export.messages:
        for part in message.parts:
            if part.type != "tool_result":
                continue
            state = part.state if isinstance(part.state, dict) else {}
            tool_id = state.get("tool_use_id")
            if isinstance(tool_id, str) and part.nav:
                navs[tool_id] = part.nav
    return navs


def _attach_child_sessions(
    connection: sqlite3.Connection,
    *,
    db_path: Path,
    parent: ConversationExport,
    parent_session_id: str,
    root_session_id: str,
    parent_agent_path: str,
    visited: set[str],
) -> None:
    child_rows = connection.execute(
        """
        select *
        from session
        where parent_id = ?
        order by coalesce(time_created, 0), id
        """,
        (parent_session_id,),
    ).fetchall()
    task_parts = [
        (message_id, part)
        for message_id, part in sorted(
            _iter_tool_parts(parent),
            key=lambda item: item[1].time_created or 0,
        )
        if part.tool == "task"
    ]
    result_navs = _tool_result_navs(parent)

    for index, child_row in enumerate(child_rows):
        child_id = str(child_row["id"])
        if child_id in visited:
            continue
        child_agent = str(child_row["agent"] or "opencode-subagent")
        child_agent_path = f"{parent_agent_path}/{child_id}"
        child = _load_session_export(
            connection,
            db_path=db_path,
            session_id=child_id,
            root_session_id=root_session_id,
            agent_path=child_agent_path,
            scope="subagent",
            visited=visited,
        )
        if child is None:
            continue
        child.agent_type = child_agent
        child.relationship_basis = "OpenCode session.parent_id"
        child.relationship_hint = f"attached by OpenCode parent_id {parent_session_id}"
        if index < len(task_parts):
            task_message_id, task_part = task_parts[index]
            child.task_part_id = task_part.id
            child.task_message_id = task_message_id
            child.parent_task_nav = task_part.nav
            child.parent_result_nav = result_navs.get(str(task_part.id)) if task_part.id else None
            child.relationship_basis = "OpenCode session.parent_id and task order"
            child.relationship_hint = "attached by OpenCode parent_id and matching task tool order"
        parent.subagent_transcripts.append(child)


def _load_session_export(
    connection: sqlite3.Connection,
    *,
    db_path: Path,
    session_id: str,
    root_session_id: str,
    agent_path: str,
    scope: str,
    visited: set[str],
) -> ConversationExport | None:
    session_row = connection.execute(
        "select * from session where id = ?",
        (session_id,),
    ).fetchone()
    if session_row is None:
        return None
    visited.add(session_id)
    message_rows = connection.execute(
        "select * from message where session_id = ? order by coalesce(time_created, 0), id",
        (session_id,),
    ).fetchall()
    part_rows = connection.execute(
        "select * from part where session_id = ? order by coalesce(time_created, 0), id",
        (session_id,),
    ).fetchall()
    summary = _summary_from_session_row(connection, session_row)

    parser = _OpenCodeParser(db_path, root_session_id, scope=scope, agent_path=agent_path)
    session_data = _row_dict(session_row)
    parser.add_raw_row("session", session_data, _safe_json_dict(session_data.get("model")))

    parts_by_message: dict[str, list[tuple[dict[str, Any], dict[str, Any], NavAddress]]] = {}
    for row in part_rows:
        row_data = _row_dict(row)
        raw_nav = parser.add_raw_row("part", row_data)
        try:
            part_data = _json_dict(row_data.get("data"))
        except json.JSONDecodeError as exc:
            parser.add_json_diagnostic("part", row_data, exc, raw_nav)
            continue
        message_id = str(row_data.get("message_id") or part_data.get("messageID") or "")
        if not message_id:
            parser.diagnostics.append(
                ParserDiagnostic(
                    id=f"opencode-part-missing-message:{row_data.get('id', raw_nav.lineNumber)}",
                    severity="error",
                    kind="missing_message_id",
                    message=f"OpenCode part row {row_data.get('id')} has no message_id.",
                    nav=raw_nav,
                )
            )
            continue
        parts_by_message.setdefault(message_id, []).append((row_data, part_data, raw_nav))

    messages: list[Message] = []
    title = summary.title
    model_info = _safe_json_dict(session_data.get("model"))
    default_model = ModelInfo(
        providerID=model_info.get("providerID") or model_info.get("provider"),
        modelID=model_info.get("modelID") or model_info.get("id") or model_info.get("model"),
    )
    for row in message_rows:
        row_data = _row_dict(row)
        raw_nav = parser.add_raw_row("message", row_data)
        try:
            message_data = _json_dict(row_data.get("data"))
        except json.JSONDecodeError as exc:
            parser.add_json_diagnostic("message", row_data, exc, raw_nav)
            continue
        message_id = str(row_data.get("id") or message_data.get("id") or raw_nav.lineNumber)
        role = str(message_data.get("role") or "system")
        if role not in {"user", "assistant", "system"}:
            role = "system"
        provider_id = message_data.get("providerID") or default_model.providerID
        model_id = message_data.get("modelID") or default_model.modelID
        message_nav = raw_nav.model_copy(
            update={
                "elementType": "message",
                "view": "rendered",
                "messageId": message_id,
                "jsonPointer": json_pointer("message", "data"),
            }
        )
        parser.nav_index.append(message_nav)
        message_parts: list[GenericPart] = []
        for part_index, (part_row, part_data, part_raw_nav) in enumerate(parts_by_message.get(message_id, [])):
            message_parts.extend(_parts_for_row(parser, part_row, part_data, part_raw_nav, message_id, part_index))
        if not message_parts:
            continue
        if title in {None, "", session_id} and role == "user":
            candidate = title_candidate_from_text("\n".join(part.text or "" for part in message_parts))
            if candidate:
                title = candidate
                summary.title = candidate
        messages.append(
            Message(
                id=message_id,
                role=role,
                agent=str(message_data.get("agent") or session_data.get("agent") or "main"),
                model=ModelInfo(providerID=provider_id, modelID=model_id),
                modelID=str(model_id) if model_id else None,
                time_created=_time_from_row(row_data, message_data, "time_created"),
                time_updated=_time_from_row(row_data, message_data, "time_updated"),
                finish=str(message_data.get("finish")) if message_data.get("finish") else None,
                parts=message_parts,
                nav=message_nav,
            )
        )

    summary.message_count = len(messages)
    export = ConversationExport(
        summary=summary,
        messages=messages,
        agent_type="opencode" if scope == "main" else str(session_data.get("agent") or "opencode-subagent"),
        raw_events=parser.raw_events,
        parser_diagnostics=parser.diagnostics,
        nav_index=parser.nav_index,
    )
    _attach_child_sessions(
        connection,
        db_path=db_path,
        parent=export,
        parent_session_id=session_id,
        root_session_id=root_session_id,
        parent_agent_path=agent_path,
        visited=visited,
    )
    export.summary.subagent_count = len(export.subagent_transcripts)
    return export


def load_conversation(
    session_id: str,
    source_path: str | Path | None = None,
) -> ConversationExport | None:
    db_path = _db_path(source_path)
    if not db_path.is_file():
        return None
    try:
        with _connect_readonly(db_path) as connection:
            export = _load_session_export(
                connection,
                db_path=db_path,
                session_id=session_id,
                root_session_id=session_id,
                agent_path="main",
                scope="main",
                visited=set(),
            )
    except sqlite3.Error:
        return None
    if export is None:
        return None
    attach_problem_flags(export)
    return export


def get_source_info(source_path: str | Path | None = None) -> dict[str, Any]:
    return opencode_source_info(source_path)
