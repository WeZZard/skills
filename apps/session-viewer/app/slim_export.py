from __future__ import annotations

from typing import Any

from app.models import ConversationExport, RawEvent


def _slim_raw_event(event: RawEvent) -> dict[str, Any]:
    raw = event.raw
    raw_type = ""
    raw_subtype = ""
    timestamp = None
    if isinstance(raw, dict):
        raw_type = str(raw.get("type") or "")
        raw_subtype = str(raw.get("subtype") or "")
        ts_value = raw.get("timestamp")
        if isinstance(ts_value, str):
            raw_type = raw_type or raw.get("type") or ""
    return {
        "id": event.id,
        "nav": event.nav.model_dump(mode="json"),
        "type": raw_type,
        "subtype": raw_subtype,
        "timestamp": timestamp,
        "parse_error": event.parse_error,
    }


def _slim_raw_events(events: list[RawEvent]) -> list[dict[str, Any]]:
    return [_slim_raw_event(event) for event in events]


def _track_skeleton(export: ConversationExport) -> dict[str, Any]:
    first_nav = export.messages[0].nav if export.messages else (
        export.raw_events[0].nav if export.raw_events else (
            export.nav_index[0] if export.nav_index else None
        )
    )
    capsule_count = sum(len(message.parts) for message in export.messages) + len(export.raw_events)
    return {
        "summary": export.summary.model_dump(mode="json"),
        "agent_type": export.agent_type,
        "agent_description": export.agent_description,
        "task_part_id": export.task_part_id,
        "task_message_id": export.task_message_id,
        "parent_task_nav": export.parent_task_nav.model_dump(mode="json") if export.parent_task_nav else None,
        "parent_result_nav": export.parent_result_nav.model_dump(mode="json") if export.parent_result_nav else None,
        "previous_sibling_nav": export.previous_sibling_nav.model_dump(mode="json") if export.previous_sibling_nav else None,
        "next_sibling_nav": export.next_sibling_nav.model_dump(mode="json") if export.next_sibling_nav else None,
        "relationship_hint": export.relationship_hint,
        "relationship_basis": export.relationship_basis,
        "message_count": len(export.messages),
        "raw_event_count": len(export.raw_events),
        "problem_flag_count": len(export.problem_flags),
        "capsule_count": capsule_count,
        "first_nav": first_nav.model_dump(mode="json") if first_nav else None,
        "subagent_transcripts": [_track_skeleton(child) for child in export.subagent_transcripts],
    }


def slim_export(export: ConversationExport) -> dict[str, Any]:
    return {
        "summary": export.summary.model_dump(mode="json"),
        "messages": [message.model_dump(mode="json") for message in export.messages],
        "raw_events": _slim_raw_events(export.raw_events),
        "problem_flags": [flag.model_dump(mode="json") for flag in export.problem_flags],
        "parser_diagnostics": [d.model_dump(mode="json") for d in export.parser_diagnostics],
        "task_part_id": export.task_part_id,
        "task_message_id": export.task_message_id,
        "parent_task_nav": export.parent_task_nav.model_dump(mode="json") if export.parent_task_nav else None,
        "parent_result_nav": export.parent_result_nav.model_dump(mode="json") if export.parent_result_nav else None,
        "previous_sibling_nav": export.previous_sibling_nav.model_dump(mode="json") if export.previous_sibling_nav else None,
        "next_sibling_nav": export.next_sibling_nav.model_dump(mode="json") if export.next_sibling_nav else None,
        "relationship_hint": export.relationship_hint,
        "relationship_basis": export.relationship_basis,
        "agent_type": export.agent_type,
        "agent_description": export.agent_description,
        "subagent_transcripts": [_track_skeleton(child) for child in export.subagent_transcripts],
    }


def _find_track_by_agent_path(export: ConversationExport, agent_path: str) -> ConversationExport | None:
    if _track_agent_path(export) == agent_path:
        return export
    for child in export.subagent_transcripts:
        found = _find_track_by_agent_path(child, agent_path)
        if found is not None:
            return found
    return None


def _track_agent_path(export: ConversationExport) -> str:
    if export.messages:
        return export.messages[0].nav.agentPath or "main"
    if export.raw_events:
        return export.raw_events[0].nav.agentPath or "main"
    return "main"


def track_payload(export: ConversationExport, agent_path: str) -> dict[str, Any] | None:
    track = _find_track_by_agent_path(export, agent_path)
    if track is None:
        return None
    return {
        "summary": track.summary.model_dump(mode="json"),
        "messages": [message.model_dump(mode="json") for message in track.messages],
        "raw_events": [event.model_dump(mode="json") for event in track.raw_events],
        "problem_flags": [flag.model_dump(mode="json") for flag in track.problem_flags],
        "parser_diagnostics": [d.model_dump(mode="json") for d in track.parser_diagnostics],
        "agent_type": track.agent_type,
        "agent_description": track.agent_description,
        "task_part_id": track.task_part_id,
        "task_message_id": track.task_message_id,
        "parent_task_nav": track.parent_task_nav.model_dump(mode="json") if track.parent_task_nav else None,
        "parent_result_nav": track.parent_result_nav.model_dump(mode="json") if track.parent_result_nav else None,
        "relationship_hint": track.relationship_hint,
        "relationship_basis": track.relationship_basis,
    }


def _find_raw_event(export: ConversationExport, jsonl_file: str, line_number: int) -> RawEvent | None:
    for event in export.raw_events:
        if event.nav.jsonlFile == jsonl_file and event.nav.lineNumber == line_number:
            return event
    for child in export.subagent_transcripts:
        found = _find_raw_event(child, jsonl_file, line_number)
        if found is not None:
            return found
    return None


def raw_event_payload(export: ConversationExport, jsonl_file: str, line_number: int) -> dict[str, Any] | None:
    event = _find_raw_event(export, jsonl_file, line_number)
    if event is None:
        return None
    return {
        "id": event.id,
        "nav": event.nav.model_dump(mode="json"),
        "raw": event.raw,
        "parse_error": event.parse_error,
    }


def _collect_search_strings(value: Any) -> list[str]:
    out: list[str] = []
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            out.extend(_collect_search_strings(item))
    elif isinstance(value, list):
        for item in value:
            out.extend(_collect_search_strings(item))
    elif value is not None:
        out.append(str(value))
    return out


def _track_search_hits(
    export: ConversationExport,
    agent_path: str,
    is_root: bool,
    query_lower: str,
    scope: str,
    results: list[dict[str, Any]],
    max_results: int,
) -> None:
    if scope == "main" and not is_root:
        return
    if scope == "subagents" and is_root:
        pass

    for message in export.messages:
        if len(results) >= max_results:
            return
        haystack_parts: list[str] = []
        if hasattr(message, "parts") and message.parts:
            for part in message.parts:
                if part.text:
                    haystack_parts.append(part.text)
                if part.state and isinstance(part.state, dict):
                    haystack_parts.extend(_collect_search_strings(part.state))
        if hasattr(message, "nav") and message.nav:
            haystack_parts.append(message.nav.agentPath or "")
        haystack = " ".join(haystack_parts).lower()
        if query_lower in haystack:
            nav = message.nav.model_dump(mode="json") if hasattr(message.nav, "model_dump") else message.nav
            key = nav.get("agentPath", agent_path) + ":" + str(nav.get("lineNumber", 0))
            if not any(r["key"] == key for r in results):
                results.append({
                    "key": key,
                    "trackId": agent_path,
                    "messageIndex": 0,
                    "kindLabel": getattr(message, "role", None) or "message",
                    "lineLabel": getattr(message, "role", None) or "message",
                    "sourceText": " ".join(haystack_parts[:3])[:200],
                    "nav": nav,
                })

    for event in export.raw_events:
        if len(results) >= max_results:
            return
        raw = event.raw
        if isinstance(raw, dict):
            haystack = " ".join(_collect_search_strings(raw)).lower()
            raw_type = str(raw.get("type", "raw_event"))
        else:
            haystack = str(raw).lower()
            raw_type = "raw_event"
        if query_lower in haystack:
            nav = event.nav.model_dump(mode="json") if hasattr(event.nav, "model_dump") else event.nav
            key = nav.get("agentPath", agent_path) + ":" + str(nav.get("lineNumber", 0))
            if not any(r["key"] == key for r in results):
                results.append({
                    "key": key,
                    "trackId": agent_path,
                    "messageIndex": 0,
                    "kindLabel": raw_type,
                    "lineLabel": "raw_event",
                    "sourceText": haystack[:200],
                    "nav": nav,
                })

    for child in export.subagent_transcripts:
        if len(results) >= max_results:
            return
        child_path = _track_agent_path(child)
        _track_search_hits(child, child_path, False, query_lower, scope, results, max_results)


def search_export(
    export: ConversationExport,
    query: str,
    scope: str = "all",
    max_results: int = 200,
) -> list[dict[str, Any]]:
    if not query.strip():
        return []
    query_lower = query.lower().strip()
    results: list[dict[str, Any]] = []
    _track_search_hits(export, "main", True, query_lower, scope, results, max_results)
    return results