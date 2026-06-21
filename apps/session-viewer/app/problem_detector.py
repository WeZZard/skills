from __future__ import annotations

import json
import re

from datetime import datetime
from typing import Any

from app.models import ConversationExport, NavAddress, ProblemFlag, RawEvent


FAILURE_RE = re.compile(r"(Error:|Failed|permission denied|not found)", re.I)


def _raw_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    return json.dumps(raw, ensure_ascii=False, default=str)


def _flag(kind: str, reason: str, nav: NavAddress, *, path: str | None = None, severity: str = "warning") -> ProblemFlag:
    return ProblemFlag(
        id=f"{kind}:{nav.jsonlFile}:{nav.lineNumber}:{nav.contentIndex if nav.contentIndex is not None else ''}",
        severity=severity,
        kind=kind,
        reason=reason,
        nav=nav,
        jsonPath=path,
    )


def flags_from_raw_event(event: RawEvent) -> list[ProblemFlag]:
    flags: list[ProblemFlag] = []
    raw = event.raw
    text = _raw_text(raw)

    if event.parse_error:
        flags.append(_flag("parser_diagnostic", event.parse_error, event.nav, severity="error"))
        return flags

    if "[Request interrupted by user]" in text:
        flags.append(_flag("interrupted_request", "Request interrupted by user", event.nav))

    if isinstance(raw, dict):
        if raw.get("table") == "part" and isinstance(raw.get("row"), dict):
            row = raw["row"]
            data = raw.get("data")
            if not isinstance(data, dict):
                try:
                    data = json.loads(row.get("data") or "{}")
                except (TypeError, json.JSONDecodeError):
                    data = {}
            if isinstance(data, dict) and data.get("type") == "tool":
                state = data.get("state") if isinstance(data.get("state"), dict) else {}
                status = str(state.get("status") or data.get("status") or "").lower()
                if status in {"error", "failed"}:
                    flags.append(_flag("tool_result_error", "OpenCode tool state is failed/error", event.nav, path="/row/data/state/status", severity="error"))
                for key in ("error", "output"):
                    if FAILURE_RE.search(_raw_text(state.get(key))):
                        flags.append(_flag("command_failure", f"OpenCode tool {key} contains failure text", event.nav, path=f"/row/data/state/{key}"))

        tool_use_result = raw.get("toolUseResult")
        if tool_use_result is not None and FAILURE_RE.search(_raw_text(tool_use_result)):
            flags.append(_flag("tool_use_result_error", "toolUseResult contains failure text", event.nav, path="/toolUseResult"))

        attachment = raw.get("attachment")
        if isinstance(attachment, dict):
            attachment_type = str(attachment.get("type") or "")
            stderr = str(attachment.get("stderr") or "")
            exit_code = attachment.get("exitCode")
            if "hook" in attachment_type and (exit_code not in {None, 0} or stderr):
                flags.append(_flag("hook_error", "Hook attachment reported an error", event.nav, path="/attachment", severity="error"))

        if raw.get("type") == "system" and raw.get("hookErrors"):
            flags.append(_flag("hook_error", "System hook summary contains hookErrors", event.nav, path="/hookErrors", severity="error"))

        message = raw.get("message")
        if isinstance(message, dict):
            for index, item in enumerate(message.get("content") or []):
                if isinstance(item, dict) and item.get("type") == "tool_result":
                    pointer = f"/message/content/{index}"
                    part_nav = event.nav.model_copy(
                        update={
                            "elementType": "tool_result",
                            "view": "rendered",
                            "contentIndex": index,
                            "toolUseId": item.get("tool_use_id"),
                            "jsonPointer": pointer,
                        }
                    )
                    if item.get("is_error") is True:
                        flags.append(
                            _flag(
                                "tool_result_error",
                                "tool_result has is_error=true",
                                part_nav,
                                path=f"{pointer}/is_error",
                                severity="error",
                            )
                        )
                    if FAILURE_RE.search(_raw_text(item.get("content"))):
                        flags.append(
                            _flag(
                                "command_failure",
                                "tool_result content contains failure text",
                                part_nav,
                                path=f"{pointer}/content",
                            )
                        )

    return flags


def _event_timestamp(raw: dict[str, Any] | str) -> int | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("timestamp"), str):
        return None
    try:
        return int(datetime.fromisoformat(raw["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _nav_order(export: ConversationExport) -> dict[tuple[str, int], tuple[int, int]]:
    order: dict[tuple[str, int], tuple[int, int]] = {}
    counter = 0

    def visit(node: ConversationExport) -> None:
        nonlocal counter
        for event in node.raw_events:
            timestamp = _event_timestamp(event.raw)
            order[(event.nav.jsonlFile, event.nav.lineNumber)] = (
                timestamp if timestamp is not None else 9_223_372_036_854_775_807,
                counter,
            )
            counter += 1
        for child in node.subagent_transcripts:
            visit(child)

    visit(export)
    return order


def attach_problem_flags(export: ConversationExport) -> None:
    flags: list[ProblemFlag] = []
    for event in export.raw_events:
        flags.extend(flags_from_raw_event(event))
    for diagnostic in export.parser_diagnostics:
        if diagnostic.nav:
            flags.append(
                _flag(
                    "parser_diagnostic",
                    diagnostic.message,
                    diagnostic.nav,
                    severity=diagnostic.severity,
                )
            )
    for child in export.subagent_transcripts:
        attach_problem_flags(child)
        flags.extend(child.problem_flags)

    seen: set[str] = set()
    deduped: list[ProblemFlag] = []
    order = _nav_order(export)
    for flag in sorted(
        flags,
        key=lambda f: (
            *order.get((f.nav.jsonlFile, f.nav.lineNumber), (9_223_372_036_854_775_807, f.nav.eventIndex)),
            f.nav.jsonlFile,
            f.nav.lineNumber,
            f.kind,
        ),
    ):
        if flag.id in seen:
            continue
        seen.add(flag.id)
        deduped.append(flag)
    export.problem_flags = deduped
    export.summary.first_problem = deduped[0].reason if deduped else None
