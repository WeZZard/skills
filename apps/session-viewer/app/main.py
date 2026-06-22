from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import claude_store, opencode_store
from app.config import Config
from app.models import ConversationExport, ConversationSummary


app = FastAPI(title="Session Viewer")
app.mount("/static", StaticFiles(directory=str(Config.STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(Config.TEMPLATES_DIR))


AGENTS = {"claude": "Claude Code", "opencode": "Open Code"}
PORTFOLIO_CATEGORY_ORDER = ("user", "assistant", "attachment", "system", "raw_event")
PORTFOLIO_CATEGORY_LABELS = {
    "user": "User",
    "assistant": "Assistant",
    "attachment": "Attachment",
    "system": "System",
    "raw_event": "Raw Event",
}
DETAIL_DESIGN_ARRAY_PATH = (
    Config.ROOT_DIR
    / "reports"
    / "claude-transcript-scans"
    / "message-type-design-array-2026-06-22.json"
)
DETAIL_PLAN_DIR = Config.ROOT_DIR / ".plan" / "claude-detail-popup-content-design"
WATERFALL_PLAN_DIR = Config.ROOT_DIR / ".plan" / "waterfall-message-card-navigation-design"
PLAN_FIELD_ROW_RE = re.compile(
    r"^\|\s*(?P<label>[^|]+?)\s*\|\s*`(?P<path>[^`]+)`\s*\|.*\|\s*(?P<key>true|false)\s*\|\s*$",
    re.IGNORECASE,
)
PORTFOLIO_VIEW_HIERARCHY = (
    (
        "timeline",
        "Timeline",
        (
            ("timeline_block", "Block", "timeline-block"),
            ("timeline_detail_window", "Detailed Message Popup", "timeline-detail-window"),
        ),
    ),
    (
        "waterfall",
        "Waterfall",
        (
            ("waterfall_card", "Message Card", "waterfall-card"),
            ("waterfall_navigation_item", "Message Navigation Item", "waterfall-navigation-item"),
        ),
    ),
)
DASHBOARD_PARAM_KEYS = (
    "tab",
    "claude_q",
    "claude_directory",
    "opencode_q",
    "opencode_directory",
)


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _dashboard_params(request: Request) -> dict[str, str]:
    params = {key: _clean(request.query_params.get(key)) for key in DASHBOARD_PARAM_KEYS}
    params["tab"] = params["tab"] if params["tab"] in AGENTS else "claude"
    return params


def _href(path: str, params: dict[str, str], **updates: str | None) -> str:
    merged = {**params}
    for key, value in updates.items():
        merged[key] = _clean(value)
    query = urlencode({key: value for key, value in merged.items() if value})
    return f"{path}?{query}" if query else path


def _agent_or_404(agent: str) -> str:
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent}")
    return agent


def _source_path(agent: str, params: dict[str, str]) -> str | None:
    return None


def _query(agent: str, params: dict[str, str]) -> str | None:
    return params.get(f"{agent}_q") or None


def _directory(agent: str, params: dict[str, str]) -> str | None:
    return params.get(f"{agent}_directory") or None


def _source_info(agent: str, source_path: str | None) -> dict[str, Any]:
    if agent == "claude":
        return claude_store.get_source_info(source_path)
    return opencode_store.get_source_info(source_path)


def _list_sessions(agent: str, params: dict[str, str]) -> list[ConversationSummary]:
    kwargs = {
        "query": _query(agent, params),
        "directory": _directory(agent, params),
        "source_path": _source_path(agent, params),
    }
    if agent == "claude":
        return claude_store.list_sessions(**kwargs)
    return opencode_store.list_sessions(**kwargs)


def _list_directories(agent: str, source_path: str | None = None) -> list[str]:
    if agent == "claude":
        return claude_store.list_directories(source_path=source_path)
    return opencode_store.list_directories(source_path=source_path)


def _load_conversation(agent: str, session_id: str, source_path: str | None = None) -> ConversationExport | None:
    if agent == "claude":
        return claude_store.load_conversation(session_id, source_path=source_path)
    return opencode_store.load_conversation(session_id, source_path=source_path)


def _session_items(
    agent: str,
    sessions: list[ConversationSummary],
    params: dict[str, str],
) -> list[dict[str, Any]]:
    scoped_params = {**params, "tab": agent}
    return [
        {
            "summary": session,
            "href": _href(f"/conversation/{agent}/{session.id}", scoped_params),
        }
        for session in sessions
    ]


def _dashboard_context(request: Request) -> dict[str, Any]:
    params = _dashboard_params(request)
    panels: dict[str, dict[str, Any]] = {}
    for agent, label in AGENTS.items():
        source_path = _source_path(agent, params)
        sessions = _list_sessions(agent, params)
        source = _source_info(agent, source_path)
        panels[agent] = {
            "agent": agent,
            "label": label,
            "active": params["tab"] == agent,
            "tab_href": _href("/", params, tab=agent),
            "source": source,
            "query": _query(agent, params) or "",
            "directory": _directory(agent, params) or "",
            "source_value": source_path or "",
            "session_items": _session_items(agent, sessions, params),
        }
    return {
        "active_tab": params["tab"],
        "params": params,
        "panels": panels,
        "portfolio_href": _href("/portfolio", params),
    }


def _conversation_back_href(agent: str, request: Request) -> str:
    params = {key: _clean(request.query_params.get(key)) for key in DASHBOARD_PARAM_KEYS}
    params["tab"] = agent
    return _href("/", params)


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    return templates.TemplateResponse(request, "dashboard.html", _dashboard_context(request))


def _human_label(value: str | None) -> str:
    special = {
        "api_error": "API Error",
        "ai-title": "AI Title",
        "hook_success": "Hook Success",
        "hook_additional_context": "Hook Additional Context",
        "hook_non_blocking_error": "Hook Non-Blocking Error",
        "hook_blocking_error": "Hook Blocking Error",
        "mcp_instructions_delta": "MCP Instructions Delta",
        "tool_call": "Tool Call",
        "tool_result": "Tool Result",
        "raw_event": "Raw Event",
        "ultra_effort_enter": "Ultra Effort Enter",
        "ultra_effort_exit": "Ultra Effort Exit",
    }
    key = str(value or "unknown")
    if key in special:
        return special[key]
    key = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    return (
        key.replace("_", " ")
        .replace("-", " ")
        .title()
        .replace(" Ai ", " AI ")
        .replace(" Api ", " API ")
        .replace(" Json ", " JSON ")
        .replace("Uuids", "UUIDs")
        .replace("Uuid", "UUID")
        .replace(" Uuid", " UUID")
        .replace(" Uuids", " UUIDs")
        .replace(" Id", " ID")
        .replace(" Url", " URL")
        .replace(" Cwd", " CWD")
        .replace(" Mcp ", " MCP ")
        .replace(" Mcp", " MCP")
    )


def _compact_text(value: Any, limit: int = 220) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        text = str(value)
    text = " ".join(text.split())
    return f"{text[: limit - 1]}..." if len(text) > limit else text


def _read_jsonl_sample(file: str | None, line: int | None) -> dict[str, Any] | None:
    if not file or not line:
        return None
    try:
        with open(file, "r", encoding="utf-8", errors="replace") as fh:
            for line_number, raw_line in enumerate(fh, start=1):
                if line_number == line:
                    return json.loads(raw_line)
    except (OSError, json.JSONDecodeError):
        return None
    return None


def _load_detail_design_entries() -> list[dict[str, Any]]:
    try:
        data = json.loads(DETAIL_DESIGN_ARRAY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [entry for entry in data if isinstance(entry, dict)]


def _markdown_table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return []
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def _unquote_field_path(value: str) -> str:
    value = value.strip()
    if value.startswith("`") and value.endswith("`") and len(value) >= 2:
        return value[1:-1]
    return value


def _field_label_from_path(path: str) -> str:
    parts = [part for part in re.split(r"[.]", path) if part]
    if not parts:
        return "Value"
    leaf = parts[-1].replace("[]", "")
    if leaf.startswith("<") and leaf.endswith(">") and len(parts) > 1:
        leaf = parts[-2].replace("[]", "")
    return _human_label(leaf)


def _plan_fields_from_dir(category: str, subtype: str | None, plan_dir: Any) -> list[dict[str, str]]:
    filename = f"{subtype or 'raw_event'}.md"
    plan_file = plan_dir / category / filename
    try:
        text = plan_file.read_text(encoding="utf-8")
    except OSError:
        return []

    fields: list[dict[str, str]] = []
    in_fields = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "## Fields":
            in_fields = True
            continue
        if in_fields and stripped.startswith("## "):
            break
        if not in_fields or re.match(r"^\|\s*-", stripped):
            continue

        cells = _markdown_table_cells(line)
        if not cells:
            continue
        normalized = [cell.lower() for cell in cells]
        if normalized[:2] == ["field", "purpose"]:
            continue

        if len(cells) >= 5:
            path = _unquote_field_path(cells[0])
            key = cells[-2].lower()
            summary = cells[-1].lower()
            if key in {"true", "false"} and summary in {"true", "false"}:
                fields.append(
                    {
                        "label": _field_label_from_path(path),
                        "path": path,
                        "key": key,
                        "summary": summary,
                    }
                )
                continue

        match = PLAN_FIELD_ROW_RE.match(line)
        if match:
            fields.append(
                {
                    "label": match.group("label").strip(),
                    "path": match.group("path").strip(),
                    "key": match.group("key").lower(),
                    "summary": "false",
                }
            )
    return fields


def _plan_key_fields(category: str, subtype: str | None) -> list[dict[str, str]]:
    if not subtype:
        return []
    return [
        {"label": field["label"], "path": field["path"]}
        for field in _plan_fields_from_dir(category, subtype, DETAIL_PLAN_DIR)
        if field.get("key") == "true"
    ]


def _waterfall_plan_fields(category: str, subtype: str | None) -> list[dict[str, str]]:
    return _plan_fields_from_dir(category, subtype, WATERFALL_PLAN_DIR)


def _waterfall_key_fields(category: str, subtype: str | None) -> list[dict[str, str]]:
    return [
        {"label": field["label"], "path": field["path"]}
        for field in _waterfall_plan_fields(category, subtype)
        if field.get("key") == "true"
    ]


def _waterfall_summary_field(category: str, subtype: str | None) -> dict[str, str] | None:
    for field in _waterfall_plan_fields(category, subtype):
        if field.get("summary") == "true":
            return {"label": field["label"], "path": field["path"]}
    return None


def _entry_sample(entry: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    sample = (entry.get("samples") or [{}])[0]
    sample = sample if isinstance(sample, dict) else {}
    raw = _read_jsonl_sample(sample.get("file"), sample.get("line"))
    return raw, sample


def _content_item_for_subtype(raw: dict[str, Any], subtype: str) -> dict[str, Any]:
    message = raw.get("message") if isinstance(raw.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return {}
    if subtype == "tool_call":
        return next((item for item in content if isinstance(item, dict) and item.get("type") == "tool_use"), {})
    if subtype == "tool_result":
        return next((item for item in content if isinstance(item, dict) and item.get("type") == "tool_result"), {})
    if subtype == "reasoning":
        return next((item for item in content if isinstance(item, dict) and item.get("type") == "thinking"), {})
    if subtype == "image":
        return next((item for item in content if isinstance(item, dict) and item.get("type") == "image"), {})
    return next((item for item in content if isinstance(item, dict) and item.get("type") == "text"), {})


def _design_payload(entry: dict[str, Any], raw: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    category = str(entry.get("type") or "")
    subtype = str(entry.get("subtype") or "")
    if category == "attachment":
        attachment = raw.get("attachment")
        return attachment if isinstance(attachment, dict) else {}
    if category in {"assistant", "user"}:
        return _content_item_for_subtype(raw, subtype)
    return raw


def _raw_matches_design_entry(entry: dict[str, Any], raw: dict[str, Any]) -> bool:
    category = str(entry.get("type") or "")
    subtype = str(entry.get("subtype") or "")
    raw_type = str(raw.get("type") or "")
    if category == "attachment":
        attachment = raw.get("attachment") if isinstance(raw.get("attachment"), dict) else {}
        return raw_type == "attachment" and str(attachment.get("type") or "") == subtype
    if category == "system":
        return raw_type == "system" and str(raw.get("subtype") or "") == subtype
    if category in {"assistant", "user"}:
        return raw_type == category and bool(_content_item_for_subtype(raw, subtype))
    return raw_type == category


def _has_any_key_value(payload: dict[str, Any], fields: list[dict[str, str]]) -> bool:
    for field in fields:
        value = _value_at_path(payload, field["path"])
        if value not in (None, "", [], {}):
            return True
    return False


def _find_sample_with_content(
    entry: dict[str, Any],
    fields: list[dict[str, str]],
    sample: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    file = sample.get("file")
    if not file:
        return None, sample
    try:
        with open(file, "r", encoding="utf-8", errors="replace") as fh:
            for line_number, raw_line in enumerate(fh, start=1):
                try:
                    raw = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(raw, dict) or not _raw_matches_design_entry(entry, raw):
                    continue
                payload = _design_payload(entry, raw)
                if _has_any_key_value(payload, fields):
                    return raw, {**sample, "line": line_number}
    except OSError:
        return None, sample
    return None, sample


def _path_parts(raw_path: str) -> list[str]:
    return [part for part in raw_path.split(".") if part]


def _value_at_path(value: Any, raw_path: str) -> Any:
    current = value
    for part in _path_parts(raw_path):
        if part.endswith("[]"):
            part = part[:-2]
        if part.startswith("<") and part.endswith(">"):
            return current
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _array_base_path(raw_path: str) -> str | None:
    marker = raw_path.find("[]")
    if marker < 0:
        return None
    return raw_path[:marker]


def _array_child_path(raw_path: str) -> str:
    marker = raw_path.find("[]")
    if marker < 0:
        return ""
    return raw_path[marker + 2 :].removeprefix(".")


def _array_child_field_sort_key(field: dict[str, str]) -> tuple[int, str]:
    child_path = _array_child_path(field["path"])
    priority = {
        "name": 0,
        "title": 1,
        "type": 2,
        "path": 3,
        "content": 90,
        "text": 91,
    }
    return (priority.get(child_path, 50), field["label"])


def _placeholder_base_path(raw_path: str) -> str | None:
    parts = _path_parts(raw_path)
    out = []
    for part in parts:
        if part.startswith("<") and part.endswith(">"):
            return ".".join(out)
        out.append(part)
    return None


def _placeholder_child_path(raw_path: str) -> str:
    parts = _path_parts(raw_path)
    for index, part in enumerate(parts):
        if part.startswith("<") and part.endswith(">"):
            return ".".join(parts[index + 1 :])
    return ""


def _display_value(value: Any, limit: int = 900) -> dict[str, Any]:
    del limit
    if value is None:
        text_value = "Not provided"
    elif isinstance(value, bool):
        text_value = "Yes" if value else "No"
    elif isinstance(value, (int, float)):
        text_value = f"{value:,}" if isinstance(value, int) else str(value)
    elif isinstance(value, str):
        text_value = value
    else:
        text_value = json.dumps(value, indent=2, ensure_ascii=False, default=str)
    return {
        "text": text_value,
        "full": text_value,
        "truncated": False,
        "multiline": "\n" in text_value or len(text_value) > 90,
    }


def _summary_value_for_field(payload: dict[str, Any], field: dict[str, str] | None) -> str:
    if not field:
        return ""
    value = _value_at_path(payload, field["path"])
    if isinstance(value, list):
        if not value:
            return "None"
        first = value[0]
        if isinstance(first, dict):
            return _compact_text(json.dumps(first, ensure_ascii=False, default=str), 180)
        return _compact_text(first, 180)
    if isinstance(value, dict):
        return _compact_text(json.dumps(value, ensure_ascii=False, default=str), 180)
    return _compact_text(value, 180)


def _waterfall_summary_for_plan(
    category: str,
    subtype: str | None,
    payload: dict[str, Any],
    field: dict[str, str] | None,
) -> str:
    if category == "user" and subtype == "image":
        source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
        media_type = source.get("media_type") or "image"
        source_type = source.get("type") or "source"
        data = source.get("data")
        size = f"{len(data):,} chars" if isinstance(data, str) else "no data"
        return f"{media_type} | {source_type} | {size}"
    return _summary_value_for_field(payload, field)


def _portfolio_time_label(raw: dict[str, Any] | None, sample: dict[str, Any]) -> str:
    timestamp = raw.get("timestamp") if isinstance(raw, dict) else None
    if isinstance(timestamp, str) and timestamp:
        match = re.search(r"T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?", timestamp)
        if match:
            return match.group(1)
        match = re.search(r"\b(\d{1,2}:\d{2})(?::\d{2})?\b", timestamp)
        if match:
            return match.group(1)
    line = sample.get("line")
    return f"Line {line}" if line else "Line ?"


def _table_cell(value: Any) -> str:
    if value is None:
        return "Not provided"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return f"{value:,}" if isinstance(value, int) else str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return f"{len(value):,} item{'s' if len(value) != 1 else ''}"
    if isinstance(value, dict):
        return f"{len(value):,} field{'s' if len(value) != 1 else ''}"
    return str(value)


def _content_blocks_for_design(payload: dict[str, Any], fields: list[dict[str, str]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    used_paths: set[str] = set()

    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    if source.get("data") and source.get("media_type"):
        blocks.append(
            {
                "kind": "image",
                "label": "Image",
                "src": f"data:{source.get('media_type')};base64,{source.get('data')}",
                "rows": [
                    {"label": "Media Type", **_display_value(source.get("media_type"), 120)},
                    {"label": "Type", **_display_value(source.get("type"), 120)},
                ],
            }
        )
        used_paths.update({"source.data", "source.media_type", "source.type"})

    placeholder_groups: dict[str, list[dict[str, str]]] = {}
    array_groups: dict[str, list[dict[str, str]]] = {}
    for field in fields:
        path = field["path"]
        placeholder_base = _placeholder_base_path(path)
        if placeholder_base:
            placeholder_groups.setdefault(placeholder_base, []).append(field)
            continue
        array_base = _array_base_path(path)
        if array_base:
            array_groups.setdefault(array_base, []).append(field)

    for base, group_fields in placeholder_groups.items():
        value = _value_at_path(payload, base)
        if not isinstance(value, dict) or not value:
            continue
        child_fields = [field for field in group_fields if _placeholder_child_path(field["path"])]
        columns = ["File Path"] + [field["label"] for field in child_fields]
        rows = []
        for key, item in value.items():
            row = [_compact_text(key, 180)]
            for field in child_fields:
                child_path = _placeholder_child_path(field["path"])
                row.append(_table_cell(_value_at_path(item, child_path)))
                used_paths.add(field["path"])
            rows.append(row)
        blocks.append(
            {
                "kind": "table",
                "label": _human_label(base.split(".")[-1]),
                "columns": columns,
                "rows": rows,
                "count_label": f"{len(value):,} item{'s' if len(value) != 1 else ''}",
            }
        )
        used_paths.update(field["path"] for field in group_fields)

    for base, group_fields in array_groups.items():
        value = _value_at_path(payload, base)
        if not isinstance(value, list):
            continue
        child_fields = sorted(
            [field for field in group_fields if _array_child_path(field["path"])],
            key=_array_child_field_sort_key,
        )
        columns = [field["label"] for field in child_fields] or ["Item"]
        rows = []
        for item in value:
            if child_fields:
                rows.append([_table_cell(_value_at_path(item, _array_child_path(field["path"]))) for field in child_fields])
            else:
                rows.append([_table_cell(item)])
        blocks.append(
            {
                "kind": "table",
                "label": _human_label(base.split(".")[-1]),
                "columns": columns,
                "rows": rows,
                "count_label": f"{len(value):,} item{'s' if len(value) != 1 else ''}",
                "empty": "None" if not value else "",
            }
        )
        used_paths.update(field["path"] for field in group_fields)
        used_paths.add(base)

    for field in fields:
        raw_path = field["path"]
        if raw_path in used_paths or "[]" in raw_path or "<" in raw_path:
            continue
        value = _value_at_path(payload, raw_path)
        if value in (None, "", [], {}):
            continue
        blocks.append(
            {
                "kind": "row",
                "label": field["label"],
                "path": raw_path,
                **_display_value(value),
            }
        )

    return blocks[:18]


def _iter_exports(export: ConversationExport):
    yield export
    for child in export.subagent_transcripts:
        yield from _iter_exports(child)


def _nav_address(nav: Any) -> str:
    if nav is None:
        return ""
    return f"{nav.jsonlFile}:{nav.lineNumber}:{nav.eventIndex}"


def _raw_event_index(export: ConversationExport) -> dict[str, dict[str, Any] | str]:
    events: dict[str, dict[str, Any] | str] = {}
    for transcript in _iter_exports(export):
        for event in transcript.raw_events:
            events[_nav_address(event.nav)] = event.raw
    return events


def _scalar_rows(payload: dict[str, Any], *, omit: set[str] | None = None, limit: int = 6) -> list[tuple[str, str]]:
    omitted = omit or set()
    rows: list[tuple[str, str]] = []
    for key, value in payload.items():
        if key in omitted:
            continue
        if isinstance(value, (dict, list)):
            continue
        if value is None or value == "":
            continue
        rows.append((_human_label(key), _compact_text(value, 120)))
        if len(rows) >= limit:
            break
    return rows


def _section_from_value(label: str, value: Any) -> dict[str, str] | None:
    if value in (None, "", [], {}):
        return None
    if isinstance(value, list):
        text = "\n".join(_compact_text(item, 260) for item in value[:8])
    elif isinstance(value, dict):
        text = "\n".join(f"{_human_label(key)}: {_compact_text(item, 180)}" for key, item in list(value.items())[:8])
    else:
        text = str(value)
    if not text.strip():
        return None
    return {"label": label, "text": text.strip()}


def _portfolio_json_sample(value: Any, *, depth: int = 0) -> Any:
    del depth
    if isinstance(value, dict):
        return {str(key): _portfolio_json_sample(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_portfolio_json_sample(item) for item in value]
    return value


def _portfolio_interaction_data(card: dict[str, Any], raw: Any) -> dict[str, Any]:
    return {
        "key": card["key"],
        "category": card["category"],
        "categoryLabel": card["category_label"],
        "subtype": card["subtype"],
        "subtypeLabel": card["subtype_label"],
        "title": card["title"],
        "summary": card["summary"],
        "waterfallSummary": card.get("waterfall_summary", card["summary"]),
        "rows": card["rows"],
        "sections": card["sections"],
        "contentBlocks": card.get("content_blocks", []),
        "waterfallContentBlocks": card.get("waterfall_content_blocks", []),
        "source": card["source"],
        "raw": _portfolio_json_sample(raw),
    }


def _formatted_portfolio_json(value: Any) -> str:
    return json.dumps(_portfolio_json_sample(value), indent=2, ensure_ascii=False, default=str)


def _part_portfolio_kind(role: str, part: Any, raw: dict[str, Any] | str | None) -> tuple[str, str, str]:
    if part.type == "attachment":
        attachment = raw.get("attachment") if isinstance(raw, dict) else None
        subtype = ""
        if isinstance(attachment, dict):
            subtype = str(attachment.get("type") or "")
        subtype = subtype or str((part.state or {}).get("attachmentType") or "attachment")
        return "attachment", subtype, _human_label(subtype)
    if part.type == "system":
        subtype = str(raw.get("subtype") or (part.state or {}).get("subtype") or "system") if isinstance(raw, dict) else "system"
        return "system", subtype, _human_label(subtype)
    if role == "assistant":
        if part.type == "tool":
            return "assistant", "tool_call", "Tool Call"
        if part.type == "reasoning":
            return "assistant", "reasoning", "Reasoning"
        return "assistant", "message", "Message"
    if role == "user":
        if part.type == "tool_result":
            return "user", "tool_result", "Tool Result"
        if part.type == "image":
            return "user", "image", "Image"
        return "user", "message", "Message"
    return role or "system", part.type or "message", _human_label(part.type)


def _portfolio_timeline_block_class(category: str, subtype: str | None) -> str:
    if not subtype:
        return "no-subtype"
    if subtype == "reasoning":
        return "reasoning"
    if subtype in {"tool", "tool_call", "tool_use"}:
        return "tool"
    if subtype in {"tool_result", "tool_used"}:
        return "tool-result"
    if category == "raw_event":
        return "raw-event"
    if category in {"user", "assistant", "attachment", "system"}:
        return category
    return "system"


def _portfolio_timeline_block_label(
    category: str,
    category_label: str,
    subtype_label: str | None,
) -> str:
    if not subtype_label:
        return category_label
    if subtype_label == "Raw Event":
        return category_label
    if category == "raw_event":
        return subtype_label
    return subtype_label


def _portfolio_detail_kind_labels(
    category: str,
    category_label: str,
    subtype_label: str | None,
) -> tuple[str, str]:
    if not subtype_label:
        return category_label, ""
    if category == "raw_event":
        return subtype_label, ""
    if subtype_label == "Raw Event":
        return category_label, ""
    return category_label, subtype_label


def _message_kind_class(value: str | None) -> str:
    key = str(value or "").replace("_", "-")
    if key in {"tool-call", "tool-use"}:
        return "tool"
    if key in {"tool-result", "tool-used"}:
        return "tool-result"
    return key


def _portfolio_card_from_part(
    export: ConversationExport,
    message: Any,
    part: Any,
    raw: dict[str, Any] | str | None,
) -> dict[str, Any]:
    category, subtype, subtype_label = _part_portfolio_kind(message.role, part, raw)
    key = f"{category}/{subtype}"
    payload: dict[str, Any] = {}
    if category == "attachment" and isinstance(raw, dict) and isinstance(raw.get("attachment"), dict):
        payload = raw["attachment"]
    elif isinstance(raw, dict):
        payload = raw
    elif isinstance(part.state, dict):
        payload = part.state

    title = subtype_label
    if part.type == "tool":
        title = _human_label(part.tool or payload.get("rawName") or "Tool Call")
    elif part.type == "tool_result":
        title = "Tool Result"
    elif part.type == "image":
        title = "Image Attachment"

    summary = _compact_text(part.text or payload.get("command") or payload.get("description") or payload.get("content") or title)
    rows = [
        ("Line", str(part.nav.lineNumber if part.nav else "")),
        ("Agent", part.nav.agentPath if part.nav else message.agent or "main"),
        ("Session", export.summary.title or export.summary.id),
    ]
    rows.extend(_scalar_rows(payload, omit={"type", "content", "stdout", "stderr", "data"}, limit=4))
    rows = [(label, value) for label, value in rows if value]

    sections = []
    if part.type == "tool" and isinstance(part.state, dict):
        sections.append(_section_from_value("Input", part.state.get("input")))
    elif part.type in {"text", "reasoning", "tool_result", "image"}:
        sections.append(_section_from_value("Content", part.text or part.state))
    else:
        for section_key in ("content", "stdout", "stderr", "prompt", "condition", "reason", "blockingError"):
            if isinstance(payload, dict) and section_key in payload:
                sections.append(_section_from_value(_human_label(section_key), payload[section_key]))
    sections = [section for section in sections if section]
    detail_category_label, detail_subtype_label = _portfolio_detail_kind_labels(category, _human_label(category), subtype_label)

    card = {
        "key": key,
        "category": category,
        "category_label": _human_label(category),
        "subtype": subtype,
        "subtype_label": subtype_label,
        "subtype_class": _message_kind_class(subtype),
        "timeline_block_class": _portfolio_timeline_block_class(category, subtype),
        "timeline_block_label": _portfolio_timeline_block_label(category, _human_label(category), subtype_label),
        "detail_category_label": detail_category_label,
        "detail_subtype_label": detail_subtype_label,
        "title": title,
        "summary": summary or "Parsed sample from a real session",
        "waterfall_summary": summary or "Parsed sample from a real session",
        "rows": rows[:8],
        "sections": sections[:2],
        "content_blocks": [],
        "waterfall_content_blocks": [],
        "time_label": _portfolio_time_label(raw if isinstance(raw, dict) else None, {"line": part.nav.lineNumber if part.nav else None}),
        "source": {
            "session": export.summary.title or export.summary.id,
            "line": part.nav.lineNumber if part.nav else None,
            "path": part.nav.jsonlFile if part.nav else "",
        },
    }
    raw_sample = raw if raw is not None else payload or part.state or {"text": part.text}
    card["raw_json"] = _formatted_portfolio_json(raw_sample)
    card["interaction"] = _portfolio_interaction_data(card, raw_sample)
    return card


def _design_entry_card(entry: dict[str, Any]) -> dict[str, Any] | None:
    category = str(entry.get("type") or "")
    raw_subtype = entry.get("subtype")
    subtype = str(raw_subtype) if raw_subtype else None
    if not category:
        return None
    raw, sample = _entry_sample(entry)
    payload = _design_payload(entry, raw)
    labels = entry.get("labels") if isinstance(entry.get("labels"), dict) else {}
    category_label = str(labels.get("type") or PORTFOLIO_CATEGORY_LABELS.get(category) or _human_label(category))
    subtype_label = str(labels.get("subtype") or _human_label(subtype)) if subtype else ""
    key = f"{category}/{subtype}" if subtype else category
    fields = _plan_key_fields(category, subtype)
    waterfall_fields = _waterfall_key_fields(category, subtype)
    waterfall_summary_field = _waterfall_summary_field(category, subtype)
    content_blocks = _content_blocks_for_design(payload, fields)
    if fields and not content_blocks:
        alternate_raw, alternate_sample = _find_sample_with_content(entry, fields, sample)
        if alternate_raw is not None:
            raw = alternate_raw
            sample = alternate_sample
            payload = _design_payload(entry, raw)
            content_blocks = _content_blocks_for_design(payload, fields)
    waterfall_content_blocks = _content_blocks_for_design(payload, waterfall_fields)
    if waterfall_fields and not waterfall_content_blocks:
        alternate_raw, alternate_sample = _find_sample_with_content(entry, waterfall_fields, sample)
        if alternate_raw is not None:
            raw = alternate_raw
            sample = alternate_sample
            payload = _design_payload(entry, raw)
            content_blocks = _content_blocks_for_design(payload, fields)
            waterfall_content_blocks = _content_blocks_for_design(payload, waterfall_fields)
    summary_seed = (
        payload.get("text")
        or payload.get("thinking")
        or payload.get("content")
        or payload.get("summary")
        or payload.get("command")
        or payload.get("operation")
        or entry.get("intent")
        or subtype_label
        or category_label
        if isinstance(payload, dict)
        else entry.get("intent") or subtype_label or category_label
    )
    rows = [
        ("Line", str(sample.get("line") or "")),
        ("Agent", str(sample.get("agentScope") or "main")),
        ("Observations", f"{int(entry.get('count') or 0):,}"),
        ("Shapes", f"{int(entry.get('shapeCount') or 0):,}"),
    ]
    if isinstance(payload, dict):
        rows.extend(_scalar_rows(payload, omit={"type", "text", "thinking", "content", "stdout", "stderr", "data"}, limit=4))
    time_label = _portfolio_time_label(raw if isinstance(raw, dict) else None, sample)
    waterfall_summary = (
        _waterfall_summary_for_plan(category, subtype, payload, waterfall_summary_field)
        if isinstance(payload, dict)
        else ""
    )
    waterfall_summary = waterfall_summary or _compact_text(summary_seed) or f"{category_label} sample"
    sections = []
    for block in content_blocks:
        if block.get("kind") == "row" and block.get("multiline"):
            sections.append({"label": block["label"], "text": block["full"]})
        elif block.get("kind") == "table":
            table_lines = [" | ".join(block.get("columns") or [])]
            table_lines.extend(" | ".join(map(str, row)) for row in block.get("rows") or [])
            sections.append({"label": block["label"], "text": "\n".join(table_lines)})
        if len(sections) >= 2:
            break
    raw_sample = raw if raw is not None else payload
    detail_category_label, detail_subtype_label = _portfolio_detail_kind_labels(category, category_label, subtype_label)
    card = {
        "key": key,
        "category": category,
        "category_label": category_label,
        "subtype": subtype,
        "subtype_label": subtype_label,
        "subtype_class": _message_kind_class(subtype),
        "timeline_block_class": _portfolio_timeline_block_class(category, subtype),
        "timeline_block_label": _portfolio_timeline_block_label(category, category_label, subtype_label),
        "detail_category_label": detail_category_label,
        "detail_subtype_label": detail_subtype_label,
        "title": subtype_label or category_label,
        "summary": _compact_text(summary_seed) or f"{category_label} sample",
        "waterfall_summary": waterfall_summary,
        "rows": [(label, value) for label, value in rows if value],
        "sections": sections,
        "content_blocks": content_blocks,
        "waterfall_content_blocks": waterfall_content_blocks,
        "time_label": time_label,
        "source": {
            "session": sample.get("file", "").split("/")[-1],
            "line": sample.get("line"),
            "path": sample.get("file", ""),
        },
    }
    card["raw_json"] = _formatted_portfolio_json(raw_sample)
    card["interaction"] = _portfolio_interaction_data(card, raw_sample)
    return card


def _portfolio_card_from_raw_event(export: ConversationExport, event: Any) -> dict[str, Any] | None:
    raw = event.raw if isinstance(event.raw, dict) else {}
    raw_type = str(raw.get("type") or "")
    if raw_type in {"user", "assistant", "attachment", "system"} or not raw_type:
        return None
    key = f"raw_event/{raw_type}"
    summary_seed = (
        raw.get("agentName")
        or raw.get("aiTitle")
        or raw.get("mode")
        or raw.get("permissionMode")
        or raw.get("operation")
        or raw.get("prompt")
        or raw.get("result")
        or raw_type
    )
    rows = [
        ("Line", str(event.nav.lineNumber)),
        ("Agent", event.nav.agentPath),
        ("Session", export.summary.title or export.summary.id),
    ]
    rows.extend(_scalar_rows(raw, omit={"type", "data"}, limit=5))
    sections = []
    for section_key in ("content", "prompt", "result", "backups"):
        if section_key in raw:
            sections.append(_section_from_value(_human_label(section_key), raw[section_key]))
    card = {
        "key": key,
        "category": "raw_event",
        "category_label": PORTFOLIO_CATEGORY_LABELS["raw_event"],
        "subtype": raw_type,
        "subtype_label": _human_label(raw_type),
        "subtype_class": _message_kind_class(raw_type),
        "timeline_block_class": _portfolio_timeline_block_class("raw_event", raw_type),
        "timeline_block_label": _portfolio_timeline_block_label(
            "raw_event",
            PORTFOLIO_CATEGORY_LABELS["raw_event"],
            _human_label(raw_type),
        ),
        "detail_category_label": _human_label(raw_type),
        "detail_subtype_label": "",
        "title": _human_label(raw_type),
        "summary": _compact_text(summary_seed) or "Raw event sample from a real session",
        "waterfall_summary": _compact_text(summary_seed) or "Raw event sample from a real session",
        "rows": rows[:8],
        "sections": [section for section in sections if section][:2],
        "content_blocks": [],
        "waterfall_content_blocks": [],
        "time_label": _portfolio_time_label(raw, {"line": event.nav.lineNumber}),
        "source": {
            "session": export.summary.title or export.summary.id,
            "line": event.nav.lineNumber,
            "path": event.nav.jsonlFile,
        },
    }
    card["raw_json"] = _formatted_portfolio_json(raw)
    card["interaction"] = _portfolio_interaction_data(card, raw)
    return card


def _portfolio_type_tabs(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    categories = {card["category"] for card in cards}
    ordered_categories = [category for category in PORTFOLIO_CATEGORY_ORDER if category in categories]
    ordered_categories.extend(sorted(categories - set(ordered_categories)))
    return [
        {
            "id": category,
            "label": PORTFOLIO_CATEGORY_LABELS.get(category, _human_label(category)),
            "cards": [card for card in cards if card["category"] == category],
        }
        for category in ordered_categories
    ]


def _portfolio_cards(params: dict[str, str]) -> dict[str, Any]:
    source_path = None
    sessions = claude_store.list_sessions()
    design_entries = _load_detail_design_entries()
    cards_by_key: dict[str, dict[str, Any]] = {}
    sample_files: set[str] = set()
    for entry in design_entries:
        card = _design_entry_card(entry)
        if not card:
            continue
        cards_by_key[card["key"]] = card
        if card["source"]["path"]:
            sample_files.add(card["source"]["path"])
    cards = sorted(cards_by_key.values(), key=lambda card: (card["category"], card["subtype_label"] or "", card["key"]))
    category_counts: dict[str, int] = {}
    for card in cards:
        category_counts[card["category"]] = category_counts.get(card["category"], 0) + 1
    view_tabs = []
    for view_id, view_label, surfaces in PORTFOLIO_VIEW_HIERARCHY:
        surface_tabs = []
        for surface_id, surface_label, surface_value in surfaces:
            type_tabs = _portfolio_type_tabs(cards)
            surface_tabs.append(
                {
                    "id": surface_id,
                    "label": surface_label,
                    "surface": surface_value,
                    "type_tabs": type_tabs,
                    "card_count": sum(len(type_tab["cards"]) for type_tab in type_tabs),
                }
            )
        view_tabs.append(
            {
                "id": view_id,
                "label": view_label,
                "surfaces": surface_tabs,
                "card_count": sum(surface["card_count"] for surface in surface_tabs),
            }
        )
    return {
        "source": claude_store.get_source_info(source_path),
        "session_count": len(sessions),
        "scanned_sessions": len(sample_files),
        "card_count": len(cards_by_key),
        "cards": cards,
        "category_counts": category_counts,
        "view_tabs": view_tabs,
    }


@app.get("/portfolio", response_class=HTMLResponse)
async def portfolio(request: Request):
    params = _dashboard_params(request)
    return templates.TemplateResponse(
        request,
        "portfolio.html",
        {
            "params": params,
            "portfolio": _portfolio_cards(params),
            "back_href": _href("/", params),
        },
    )


@app.get("/api/sessions")
async def api_sessions(
    agent: str = Query("claude"),
    q: str | None = Query(None),
    directory: str | None = Query(None),
):
    agent = _agent_or_404(agent)
    params = {
        "tab": agent,
        "claude_q": q if agent == "claude" else "",
        "claude_directory": directory if agent == "claude" else "",
        "opencode_q": q if agent == "opencode" else "",
        "opencode_directory": directory if agent == "opencode" else "",
    }
    return JSONResponse(content=[s.model_dump(by_alias=True) for s in _list_sessions(agent, params)])


@app.get("/api/directories")
async def api_directories(
    agent: str = Query("claude"),
):
    agent = _agent_or_404(agent)
    return JSONResponse(content=_list_directories(agent))


@app.get("/conversation/{agent}/{session_id}", response_class=HTMLResponse)
async def conversation_agent(request: Request, agent: str, session_id: str):
    agent = _agent_or_404(agent)
    params = _dashboard_params(request)
    source_path = _source_path(agent, params)
    data = _load_conversation(agent, session_id, source_path=source_path)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return templates.TemplateResponse(
        request,
        "conversation.html",
        {
            "conversation": data,
            "conversation_json": data.model_dump_json().replace("</", "<\\/"),
            "source": _source_info(agent, source_path),
            "agent": agent,
            "agent_label": AGENTS[agent],
            "back_href": _conversation_back_href(agent, request),
        },
    )


@app.get("/conversation/{session_id}", response_class=HTMLResponse)
async def conversation(request: Request, session_id: str):
    return await conversation_agent(request, "claude", session_id)


@app.get("/api/conversation/{agent}/{session_id}")
async def api_conversation_agent(
    agent: str,
    session_id: str,
):
    agent = _agent_or_404(agent)
    data = _load_conversation(agent, session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(content=data.model_dump(mode="json"))


@app.get("/api/conversation/{session_id}")
async def api_conversation(session_id: str):
    data = _load_conversation("claude", session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(content=data.model_dump(mode="json"))
