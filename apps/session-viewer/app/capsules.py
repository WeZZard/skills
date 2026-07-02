"""Capsule seed derivation for the timeline protocol v2 boot payload.

A "capsule" is one timeline block: a parsed message, or a raw event with no
rendered message on its line. Seeds carry just enough per capsule for the
client to run its existing kind/label logic and lay out blocks — no message
bodies, no tool inputs/outputs. Full content stays on demand (/track,
/message, /raw_event).

Seed order MUST match the client's buildModels() capsule order (all messages
in file order, then unrendered raw events in file order) so that ordinals —
and therefore block geometry — are identical before and after a track's full
payload loads.
"""

from __future__ import annotations

from typing import Any

from app.models import ConversationExport, GenericPart, Message, RawEvent

PREVIEW_CHARS = 140


def _compact(value: str | None, length: int = PREVIEW_CHARS) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= length:
        return text
    return text[: length - 1] + "…"


def _part_preview_text(part: GenericPart) -> str:
    if part.text:
        return str(part.text)
    state = part.state if isinstance(part.state, dict) else {}
    for key in ("input", "output", "content", "error"):
        value = state.get(key)
        if value:
            return str(value)
    return ""


def _message_preview(message: Message) -> str:
    for part in message.parts:
        text = _part_preview_text(part)
        if text.strip():
            return _compact(text)
    return _compact(message.role or "message")


def _part_seed(part: GenericPart) -> list[Any]:
    state = part.state if isinstance(part.state, dict) else {}
    subtype = None
    error = False
    if state.get("kind") == "attachment_event":
        subtype = state.get("attachmentType")
    elif state.get("kind") == "system_event":
        subtype = state.get("subtype")
    if part.type == "tool_result" and state.get("is_error"):
        error = True
    if part.type == "tool" and state.get("status") == "error":
        error = True
    # Positions 4-7 are the part nav's key ingredients (elementType,
    # contentIndex, toolUseId, jsonPointer): the client rebuilds each part's
    # nav key so parent-task lookups and tool-pair links resolve against seed
    # capsules exactly as they do against fully parsed ones.
    nav = part.nav
    return [
        part.type,
        part.tool,
        subtype,
        1 if error else 0,
        nav.elementType if nav else None,
        nav.contentIndex if nav else None,
        nav.toolUseId if nav else None,
        nav.jsonPointer if nav else None,
    ]


def _raw_type_fields(raw: Any) -> tuple[str | None, str | None]:
    if isinstance(raw, dict):
        raw_type = raw.get("type")
        raw_subtype = raw.get("subtype")
        return (
            raw_type if isinstance(raw_type, str) else None,
            raw_subtype if isinstance(raw_subtype, str) else None,
        )
    return None, None


def _raw_preview(event: RawEvent) -> str:
    if isinstance(event.raw, str):
        return _compact(event.raw)
    if isinstance(event.raw, dict):
        for key in ("content", "summary", "subtype", "type"):
            value = event.raw.get(key)
            if isinstance(value, str) and value.strip():
                return _compact(value)
    return _compact(event.id)


def capsule_seeds(export: ConversationExport) -> list[dict[str, Any]]:
    """Derive block seeds for one track of a parsed export, in capsule order."""
    raw_by_line: dict[int, RawEvent] = {}
    for event in export.raw_events:
        if event.nav and event.nav.lineNumber is not None:
            raw_by_line.setdefault(event.nav.lineNumber, event)

    seeds: list[dict[str, Any]] = []
    rendered_lines: set[int] = set()

    for message in export.messages:
        line_number = message.nav.lineNumber if message.nav else None
        rendered_lines.add(line_number)
        for part in message.parts:
            if part.nav and part.nav.lineNumber is not None:
                rendered_lines.add(part.nav.lineNumber)
        raw_event = raw_by_line.get(line_number) if line_number is not None else None
        raw_type, raw_subtype = _raw_type_fields(raw_event.raw if raw_event else None)
        seeds.append(
            {
                "k": "m",
                "ln": line_number,
                "ei": message.nav.eventIndex if message.nav else None,
                "mid": message.id,
                "role": message.role,
                "rt": raw_type,
                "rs": raw_subtype,
                "parts": [_part_seed(part) for part in message.parts],
                "ts": message.time_created,
                "pv": _message_preview(message),
            }
        )

    for event in export.raw_events:
        line_number = event.nav.lineNumber if event.nav else None
        if line_number in rendered_lines:
            continue
        raw_type, raw_subtype = _raw_type_fields(event.raw)
        seeds.append(
            {
                "k": "r",
                "ln": line_number,
                "ei": event.nav.eventIndex if event.nav else None,
                "rt": raw_type,
                "rs": raw_subtype,
                "ts": None,
                "pv": _raw_preview(event),
                "pe": bool(event.parse_error),
            }
        )

    return seeds
