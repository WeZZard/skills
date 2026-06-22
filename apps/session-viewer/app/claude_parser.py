from __future__ import annotations

import json
import re

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from app.models import GenericPart, Message, NavAddress, ParserDiagnostic, RawEvent


ERROR_WORD_RE = re.compile(r"\b(Error:|Failed|permission denied|not found)\b", re.I)
LOCAL_COMMAND_TITLE_RE = re.compile(
    r"^\s*<(?:local-command-caveat|bash-input|bash-stdout|bash-stderr)\b",
    re.I,
)
ATTACHMENT_PREVIEW_CHARS = 300


@dataclass
class ParsedTranscript:
    session_id: str
    jsonl_file: Path
    scope: str
    agent_path: str
    agent_id: str | None = None
    agent_type: str | None = None
    cwd: str | None = None
    git_branch: str | None = None
    model: str | None = None
    title: str | None = None
    messages: list[Message] = field(default_factory=list)
    raw_events: list[RawEvent] = field(default_factory=list)
    diagnostics: list[ParserDiagnostic] = field(default_factory=list)
    nav_index: list[NavAddress] = field(default_factory=list)
    tool_result_agent_ids: dict[str, str] = field(default_factory=dict)
    tool_result_navs: dict[str, NavAddress] = field(default_factory=dict)


def parse_timestamp(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return None


def json_pointer(*parts: str | int) -> str:
    encoded = []
    for part in parts:
        encoded.append(str(part).replace("~", "~0").replace("/", "~1"))
    return "/" + "/".join(encoded)


def _nav(
    *,
    session_id: str,
    path: Path,
    line_number: int,
    event_index: int,
    scope: str,
    agent_path: str,
    element_type: str,
    view: str = "rendered",
    message_id: str | None = None,
    content_index: int | None = None,
    tool_use_id: str | None = None,
    pointer: str | None = None,
) -> NavAddress:
    return NavAddress(
        sessionId=session_id,
        jsonlFile=str(path),
        lineNumber=line_number,
        eventIndex=event_index,
        scope=scope,
        agentPath=agent_path,
        elementType=element_type,
        view=view,
        messageId=message_id,
        contentIndex=content_index,
        toolUseId=tool_use_id,
        jsonPointer=pointer,
    )


def _text_from_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                out.append(item["text"])
            else:
                out.append(json.dumps(item, ensure_ascii=False, indent=2))
        return "\n".join(out)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value)


def title_candidate_from_text(text: str, raw: dict[str, Any] | None = None) -> str | None:
    stripped = text.strip()
    if not stripped:
        return None
    if raw and raw.get("isMeta"):
        return None
    if LOCAL_COMMAND_TITLE_RE.match(stripped):
        return None
    return stripped.splitlines()[0][:120]


def explicit_title_from_event(raw: dict[str, Any]) -> str | None:
    if raw.get("type") == "ai-title" and isinstance(raw.get("aiTitle"), str):
        return title_candidate_from_text(raw["aiTitle"])
    if raw.get("type") == "last-prompt" and isinstance(raw.get("lastPrompt"), str):
        return title_candidate_from_text(raw["lastPrompt"])
    return None


def _preview_state(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return {
        "preview": text[:ATTACHMENT_PREVIEW_CHARS],
        "truncated": len(text) > ATTACHMENT_PREVIEW_CHARS,
        "length": len(text),
    }


def _attachment_event_state(raw: dict[str, Any]) -> dict[str, Any]:
    attachment = raw.get("attachment") if isinstance(raw.get("attachment"), dict) else {}
    state: dict[str, Any] = {
        "kind": "attachment_event",
        "attachmentType": attachment.get("type") or raw.get("subtype") or "unknown",
        "sourceEventType": raw.get("type") or "attachment",
        "hasRawPayload": True,
    }
    for key in ("hookEventName", "hookName", "matcher", "toolName"):
        if attachment.get(key):
            state[key] = str(attachment[key])
    if attachment.get("exitCode") is not None:
        state["exitCode"] = attachment["exitCode"]
    stdout = _preview_state(attachment.get("stdout"))
    stderr = _preview_state(attachment.get("stderr"))
    if stdout:
        state["stdoutPreview"] = stdout["preview"]
        state["stdoutTruncated"] = stdout["truncated"]
        state["stdoutLength"] = stdout["length"]
    if stderr:
        state["stderrPreview"] = stderr["preview"]
        state["stderrTruncated"] = stderr["truncated"]
        state["stderrLength"] = stderr["length"]
    return state


def _attachment_event_summary(raw: dict[str, Any]) -> str:
    state = _attachment_event_state(raw)
    hook_name = "/".join(
        str(state[key]) for key in ("hookEventName", "hookName") if state.get(key)
    )
    if hook_name:
        parts = [f"Hook: {hook_name}"]
    elif state.get("toolName"):
        parts = [f"Attachment for {state['toolName']}"]
    else:
        parts = [f"Attachment event: {state['attachmentType']}"]
    if state.get("exitCode") is not None:
        parts.append(f"exit {state['exitCode']}")
    if state.get("stderrPreview"):
        suffix = " truncated" if state.get("stderrTruncated") else ""
        parts.append(f"stderr{suffix}")
    if state.get("stdoutPreview"):
        suffix = " truncated" if state.get("stdoutTruncated") else ""
        parts.append(f"stdout{suffix}")
    return " · ".join(parts)


def _system_event_state(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "system_event",
        "subtype": raw.get("subtype") or "system",
        "sourceEventType": raw.get("type") or "system",
        "hasRawPayload": True,
    }


def _system_event_summary(raw: dict[str, Any]) -> str:
    subtype = str(raw.get("subtype") or "system")
    content = raw.get("content")
    if subtype == "turn_duration":
        duration = raw.get("durationMs")
        message_count = raw.get("messageCount")
        if duration is not None and message_count is not None:
            return f"Turn completed in {duration:,} ms across {message_count:,} messages"
        if duration is not None:
            return f"Turn completed in {duration:,} ms"
    if subtype == "stop_hook_summary":
        hook_count = raw.get("hookCount")
        error_count = len(raw.get("hookErrors") or []) if isinstance(raw.get("hookErrors"), list) else 0
        if raw.get("preventedContinuation"):
            return f"Stop hooks prevented continuation with {error_count:,} errors"
        if hook_count is not None:
            return f"Stop hooks completed with {hook_count:,} hooks"
    if subtype == "api_error":
        retry = raw.get("retryAttempt")
        max_retries = raw.get("maxRetries")
        retry_text = f"; retry {retry} of {max_retries}" if retry is not None and max_retries is not None else ""
        return f"API request failed{retry_text}"
    if subtype == "compact_boundary":
        trigger = raw.get("compactMetadata", {}).get("trigger") if isinstance(raw.get("compactMetadata"), dict) else None
        return f"Conversation compacted{f' by {trigger} trigger' if trigger else ''}"
    if content:
        text = _text_from_content(content).strip()
        return text[:600] + ("..." if len(text) > 600 else "")
    return f"System event: {subtype}"


def _compact_event_text(raw: dict[str, Any], event_type: str) -> str:
    if event_type == "attachment":
        return _attachment_event_summary(raw)

    if event_type == "system":
        return _system_event_summary(raw)

    return _text_from_content(raw.get("content") or raw.get("subtype") or event_type)


def _part_tool_name(name: Any) -> str:
    if not isinstance(name, str) or not name:
        return "tool"
    return name.lower()


def parse_jsonl_file(
    path: Path,
    *,
    session_id: str,
    scope: str = "main",
    agent_path: str = "main",
    agent_type: str | None = None,
) -> ParsedTranscript:
    parsed = ParsedTranscript(
        session_id=session_id,
        jsonl_file=path,
        scope=scope,
        agent_path=agent_path,
        agent_type=agent_type,
    )
    tool_parts: dict[str, GenericPart] = {}
    tool_use_navs: dict[str, NavAddress] = {}
    tool_result_seen_navs: dict[str, NavAddress] = {}
    has_ai_title = False

    if not path.exists():
        nav = _nav(
            session_id=session_id,
            path=path,
            line_number=0,
            event_index=0,
            scope=scope,
            agent_path=agent_path,
            element_type="diagnostic",
            view="diagnostic",
        )
        parsed.diagnostics.append(
            ParserDiagnostic(
                id=f"missing:{path}",
                severity="error",
                kind="missing_file",
                message=f"JSONL file does not exist: {path}",
                nav=nav,
            )
        )
        return parsed

    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError as exc:
        nav = _nav(
            session_id=session_id,
            path=path,
            line_number=0,
            event_index=0,
            scope=scope,
            agent_path=agent_path,
            element_type="diagnostic",
            view="diagnostic",
        )
        parsed.diagnostics.append(
            ParserDiagnostic(
                id=f"unreadable:{path}",
                severity="error",
                kind="unreadable_file",
                message=f"JSONL file could not be read: {path}: {exc}",
                nav=nav,
            )
        )
        return parsed

    for event_index, line in enumerate(lines):
        line_number = event_index + 1
        stripped = line.strip()
        event_nav = _nav(
            session_id=session_id,
            path=path,
            line_number=line_number,
            event_index=event_index,
            scope=scope,
            agent_path=agent_path,
            element_type="event",
            view="raw",
        )
        if not stripped:
            continue
        try:
            raw: dict[str, Any] = json.loads(stripped)
        except json.JSONDecodeError as exc:
            is_partial_final_line = event_index == len(lines) - 1 and not line.endswith("\n")
            kind = "partial_json" if is_partial_final_line else "invalid_json"
            severity = "warning" if is_partial_final_line else "error"
            prefix = "Partial final JSONL" if is_partial_final_line else "Invalid JSONL"
            parsed.raw_events.append(
                RawEvent(
                    id=f"{path}:{line_number}",
                    nav=event_nav,
                    raw=stripped,
                    parse_error=str(exc),
                )
            )
            parsed.diagnostics.append(
                ParserDiagnostic(
                    id=f"parse:{path}:{line_number}",
                    severity=severity,
                    kind=kind,
                    message=f"{prefix} at line {line_number}: {exc}",
                    nav=event_nav,
                )
            )
            parsed.nav_index.append(event_nav)
            continue

        parsed.raw_events.append(RawEvent(id=f"{path}:{line_number}", nav=event_nav, raw=raw))
        parsed.nav_index.append(event_nav)
        explicit_title = explicit_title_from_event(raw)
        if explicit_title and raw.get("type") == "ai-title":
            parsed.title = explicit_title
            has_ai_title = True
        elif explicit_title and not has_ai_title and parsed.title is None:
            parsed.title = explicit_title
        parsed.agent_id = parsed.agent_id or raw.get("agentId")
        parsed.cwd = parsed.cwd or raw.get("cwd")
        branch = raw.get("gitBranch") or raw.get("branch")
        if parsed.git_branch is None and isinstance(branch, str) and branch.strip():
            parsed.git_branch = branch.strip()
        event_type = raw.get("type") or "unknown"
        timestamp = parse_timestamp(raw.get("timestamp"))
        version = raw.get("version")
        message = raw.get("message") if isinstance(raw.get("message"), dict) else None
        role = (message or {}).get("role") or (
            "system" if event_type in {"system", "attachment"} else event_type
        )
        model = (message or {}).get("model")
        if isinstance(model, str):
            parsed.model = parsed.model or model

        message_nav = _nav(
            session_id=session_id,
            path=path,
            line_number=line_number,
            event_index=event_index,
            scope=scope,
            agent_path=agent_path,
            element_type="message",
            message_id=raw.get("uuid"),
        )
        msg = Message(
            id=raw.get("uuid") or f"{path.name}:{line_number}",
            role=role if role in {"user", "assistant", "system"} else "system",
            agent=agent_path,
            model=model,
            modelID=model if isinstance(model, str) else None,
            time_created=timestamp,
            time_updated=timestamp,
            finish=(message or {}).get("stop_reason"),
            parts=[],
            nav=message_nav,
        )
        if version:
            msg.summary = None

        content = (message or {}).get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        elif not isinstance(content, list):
            content = []

        for content_index, item in enumerate(content):
            if not isinstance(item, dict):
                continue
            ctype = item.get("type")
            pointer = json_pointer("message", "content", content_index)
            part_nav = _nav(
                session_id=session_id,
                path=path,
                line_number=line_number,
                event_index=event_index,
                scope=scope,
                agent_path=agent_path,
                element_type=str(ctype or "part"),
                message_id=msg.id,
                content_index=content_index,
                tool_use_id=item.get("id") or item.get("tool_use_id"),
                pointer=pointer,
            )
            if ctype == "text":
                text = item.get("text") or ""
                msg.parts.append(
                    GenericPart(
                        id=f"{msg.id}:{content_index}",
                        type="text",
                        text=text,
                        time_created=timestamp,
                        nav=part_nav,
                    )
                )
                title_candidate = title_candidate_from_text(text, raw)
                if parsed.title is None and role == "user" and title_candidate:
                    parsed.title = title_candidate
            elif ctype == "thinking":
                msg.parts.append(
                    GenericPart(
                        id=f"{msg.id}:thinking:{content_index}",
                        type="reasoning",
                        text=item.get("thinking") or item.get("text") or "",
                        time_created=timestamp,
                        nav=part_nav,
                    )
                )
            elif ctype == "tool_use":
                tool_id = item.get("id") or f"{msg.id}:tool:{content_index}"
                tool_id_text = str(tool_id)
                part = GenericPart(
                    id=tool_id_text,
                    type="tool",
                    tool=_part_tool_name(item.get("name")),
                    time_created=timestamp,
                    nav=part_nav,
                    state={
                        "input": item.get("input")
                        if isinstance(item.get("input"), dict)
                        else {},
                        "status": "pending",
                        "title": item.get("name") or "tool",
                        "rawName": item.get("name"),
                        "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else None,
                    },
                )
                if tool_id_text in tool_use_navs:
                    parsed.diagnostics.append(
                        ParserDiagnostic(
                            id=f"duplicate-tool-use:{path}:{line_number}:{tool_id_text}",
                            kind="duplicate_tool_use_id",
                            message=f"Duplicate tool_use id {tool_id_text}.",
                            nav=part_nav,
                            related=[tool_use_navs[tool_id_text]],
                        )
                    )
                else:
                    tool_use_navs[tool_id_text] = part_nav
                    tool_parts[tool_id_text] = part
                msg.parts.append(part)
            elif ctype == "tool_result":
                tool_id = str(item.get("tool_use_id") or "")
                result_text = _text_from_content(item.get("content"))
                is_error = bool(item.get("is_error"))
                result_part = GenericPart(
                    id=f"{tool_id}:result:{line_number}",
                    type="tool_result",
                    tool="tool_result",
                    text=result_text,
                    time_created=timestamp,
                    nav=part_nav,
                    state={
                        "tool_use_id": tool_id,
                        "is_error": is_error,
                        "output": None if is_error else result_text,
                        "error": result_text if is_error else None,
                    },
                )
                msg.parts.append(result_part)
                if not tool_id:
                    parsed.diagnostics.append(
                        ParserDiagnostic(
                            id=f"missing-tool-result-id:{path}:{line_number}:{content_index}",
                            kind="missing_tool_result_id",
                            message="tool_result is missing tool_use_id.",
                            nav=part_nav,
                        )
                    )
                elif tool_id in tool_result_seen_navs:
                    parsed.diagnostics.append(
                        ParserDiagnostic(
                            id=f"duplicate-tool-result:{path}:{line_number}:{tool_id}",
                            kind="duplicate_tool_result_id",
                            message=f"Duplicate tool_result for tool_use_id {tool_id}.",
                            nav=part_nav,
                            related=[tool_result_seen_navs[tool_id]],
                        )
                    )
                else:
                    tool_result_seen_navs[tool_id] = part_nav
                    parsed.tool_result_navs[tool_id] = part_nav
                if tool_id and tool_id not in tool_use_navs:
                    parsed.diagnostics.append(
                        ParserDiagnostic(
                            id=f"orphan-tool-result:{path}:{line_number}:{tool_id}",
                            kind="orphan_tool_result",
                            message=f"tool_result references unknown tool_use_id {tool_id}.",
                            nav=part_nav,
                        )
                    )
                if tool_id in tool_parts:
                    state = tool_parts[tool_id].state or {}
                    state["status"] = "error" if is_error else "completed"
                    if is_error:
                        state["error"] = result_text
                    else:
                        state["output"] = result_text
                    tool_parts[tool_id].state = state
                tool_use_result = raw.get("toolUseResult")
                if isinstance(tool_use_result, dict) and isinstance(
                    tool_use_result.get("agentId"), str
                ):
                    parsed.tool_result_agent_ids[tool_id] = tool_use_result["agentId"]
                    if tool_id in tool_parts:
                        state = tool_parts[tool_id].state or {}
                        metadata = (
                            state.get("metadata")
                            if isinstance(state.get("metadata"), dict)
                            else {}
                        )
                        metadata["agentId"] = tool_use_result["agentId"]
                        state["metadata"] = metadata
                        tool_parts[tool_id].state = state
            elif ctype == "image":
                source = item.get("source") if isinstance(item.get("source"), dict) else {}
                media_type = source.get("media_type") or source.get("type") or item.get("media_type")
                source_type = source.get("type") or item.get("source_type")
                summary = "Image"
                if isinstance(media_type, str) and media_type:
                    summary = f"{summary}: {media_type}"
                elif isinstance(source_type, str) and source_type:
                    summary = f"{summary}: {source_type}"
                msg.parts.append(
                    GenericPart(
                        id=f"{msg.id}:image:{content_index}",
                        type="image",
                        text=summary,
                        time_created=timestamp,
                        nav=part_nav,
                        state={
                            "media_type": media_type,
                            "source_type": source_type,
                            "has_data": bool(source.get("data")),
                        },
                    )
                )

            parsed.nav_index.append(part_nav)

        if not msg.parts and event_type in {"system", "attachment"}:
            text = _compact_event_text(raw, str(event_type))
            state = _attachment_event_state(raw) if event_type == "attachment" else _system_event_state(raw)
            part_nav = _nav(
                session_id=session_id,
                path=path,
                line_number=line_number,
                event_index=event_index,
                scope=scope,
                agent_path=agent_path,
                element_type=event_type,
                message_id=msg.id,
                pointer="/" + event_type if event_type in raw else None,
            )
            msg.parts.append(
                GenericPart(
                    id=f"{msg.id}:raw",
                    type="attachment" if event_type == "attachment" else "system",
                    text=text,
                    state=state,
                    time_created=timestamp,
                    nav=part_nav,
                )
            )
            parsed.nav_index.append(part_nav)

        if msg.parts:
            parsed.messages.append(msg)

    if parsed.title is None:
        parsed.title = parsed.agent_type or parsed.agent_id or path.stem
    for tool_id, tool_nav in tool_use_navs.items():
        if tool_id not in tool_result_seen_navs:
            parsed.diagnostics.append(
                ParserDiagnostic(
                    id=f"missing-tool-result:{path}:{tool_nav.lineNumber}:{tool_id}",
                    kind="missing_tool_result",
                    message=f"tool_use id {tool_id} has no matching tool_result.",
                    nav=tool_nav,
                )
            )
    return parsed
