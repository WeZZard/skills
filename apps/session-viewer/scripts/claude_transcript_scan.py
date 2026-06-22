from __future__ import annotations

import argparse
import hashlib
import json
import os

from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_MAX_DEPTH = 4
DEFAULT_SAMPLE_CHARS = 240

@dataclass(frozen=True)
class SourceLocation:
    file: str
    line: int
    agent_scope: str

    def to_json(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "line": self.line,
            "agentScope": self.agent_scope,
        }


@dataclass(frozen=True)
class MessageKind:
    line_kind: str
    content_kind: str | None
    content_label: str | None
    raw_subtype: str
    raw_only: bool = False

    @property
    def key(self) -> str:
        if self.content_kind:
            return f"{self.line_kind}/{self.content_kind}"
        return self.line_kind

    @property
    def label(self) -> str:
        if self.content_label:
            return f"{human_label(self.line_kind)} / {self.content_label}"
        return human_label(self.line_kind)

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "lineKind": self.line_kind,
            "contentKind": self.content_kind,
            "contentLabel": self.content_label,
            "rawSubtype": self.raw_subtype,
            "rawOnly": self.raw_only,
        }


@dataclass(frozen=True)
class KindRecord:
    kind: MessageKind
    payload: Any
    location: SourceLocation
    event_type: str


@dataclass
class JsonlScan:
    root: Path
    files_scanned: int = 0
    malformed_lines: int = 0
    records: list[KindRecord] = field(default_factory=list)
    raw_event_counts: Counter[str] = field(default_factory=Counter)


@dataclass
class FieldStats:
    count: int = 0
    types: Counter[str] = field(default_factory=Counter)
    max_length: int = 0
    max_items: int = 0
    samples: list[str] = field(default_factory=list)

    def add(self, value: Any, *, sample_limit: int, sample_chars: int) -> None:
        self.count += 1
        self.types[type_name(value)] += 1
        if isinstance(value, str):
            self.max_length = max(self.max_length, len(value))
        elif isinstance(value, list):
            self.max_items = max(self.max_items, len(value))
        if len(self.samples) < sample_limit and not isinstance(value, dict | list):
            sample = compact(value, sample_chars)
            if sample and sample not in self.samples:
                self.samples.append(sample)

    def merge(self, other: FieldStats) -> None:
        self.count += other.count
        self.types.update(other.types)
        self.max_length = max(self.max_length, other.max_length)
        self.max_items = max(self.max_items, other.max_items)
        for sample in other.samples:
            if sample not in self.samples:
                self.samples.append(sample)

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "count": self.count,
            "types": dict(sorted(self.types.items())),
        }
        if self.max_length:
            data["maxLength"] = self.max_length
        if self.max_items:
            data["maxItems"] = self.max_items
        if self.samples:
            data["samples"] = self.samples
        return data


@dataclass
class FieldShape:
    fields: dict[str, FieldStats] = field(default_factory=lambda: defaultdict(FieldStats))

    def add_field(
        self,
        path: str,
        value: Any,
        *,
        sample_limit: int,
        sample_chars: int,
    ) -> None:
        if path:
            self.fields[path].add(
                value,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )

    def signature_parts(self) -> list[str]:
        parts = []
        for path, stats in sorted(self.fields.items()):
            types = "|".join(sorted(stats.types))
            parts.append(f"{path}:{types}")
        return parts


def type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def compact(value: Any, limit: int) -> str:
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    text = " ".join(text.strip().split())
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 3)].rstrip()}..."


def human_label(value: str) -> str:
    special = {
        "api_error": "API Error",
        "assistant": "assistant",
        "attachment": "attachment",
        "raw_event": "raw event",
        "system": "system",
        "tool_call": "tool call",
        "tool_result": "tool result",
        "user": "user",
    }
    if value in special:
        return special[value]
    return (
        str(value or "unknown")
        .replace("_", " ")
        .replace("-", " ")
        .title()
    )


def maybe_parse_json_string(value: str) -> Any | None:
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def iter_jsonl_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        if root.suffix == ".jsonl":
            yield root
        return
    yield from sorted(root.rglob("*.jsonl"))


def resolve_projects_root(args: argparse.Namespace) -> Path:
    if getattr(args, "projects_dir", None):
        return Path(args.projects_dir).expanduser()
    env_projects = os.environ.get("CLAUDE_PROJECTS_DIR")
    if env_projects:
        return Path(env_projects).expanduser()
    if getattr(args, "claude_config_dir", None):
        return Path(args.claude_config_dir).expanduser() / "projects"
    env_config = os.environ.get("CLAUDE_CONFIG_DIR")
    if env_config:
        return Path(env_config).expanduser() / "projects"
    if getattr(args, "claude_home", None):
        return Path(args.claude_home).expanduser() / "projects"
    env_home = os.environ.get("CLAUDE_CODE_HOME")
    if env_home:
        return Path(env_home).expanduser() / "projects"
    return Path.home() / ".claude" / "projects"


def add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--projects-dir", help="Claude projects directory or one JSONL file.")
    parser.add_argument("--claude-config-dir", help="Claude config directory; scans <dir>/projects.")
    parser.add_argument("--claude-home", help="Claude home directory; scans <dir>/projects.")


def agent_scope_for_path(path: Path) -> str:
    parts = path.parts
    if "subagents" not in parts:
        return "main"
    index = parts.index("subagents")
    suffix = list(parts[index + 1 :])
    if not suffix:
        return "subagent"
    suffix[-1] = Path(suffix[-1]).stem
    return "/".join(suffix)


def content_item_kind(line_kind: str, item_type: str) -> tuple[str, str]:
    if line_kind == "assistant":
        if item_type == "text":
            return "message", "message"
        if item_type == "thinking":
            return "reasoning", "reasoning"
        if item_type == "tool_use":
            return "tool_call", "tool call"
    if line_kind == "user":
        if item_type == "text":
            return "message", "message"
        if item_type == "tool_result":
            return "tool_result", "tool result"
    key = item_type or "(missing)"
    return key, human_label(key)


def classify_event(event: dict[str, Any], location: SourceLocation) -> list[KindRecord]:
    line_kind = str(event.get("type") or "(missing)")
    message = event.get("message") if isinstance(event.get("message"), dict) else None
    records: list[KindRecord] = []

    if line_kind == "attachment" and isinstance(event.get("attachment"), dict):
        attachment = event["attachment"]
        subtype = str(attachment.get("type") or "(missing)")
        kind = MessageKind(line_kind, subtype, human_label(subtype), subtype)
        return [KindRecord(kind, attachment, location, line_kind)]

    if line_kind == "system":
        subtype = str(event.get("subtype") or "(missing)")
        kind = MessageKind(line_kind, subtype, human_label(subtype), subtype)
        return [KindRecord(kind, event, location, line_kind)]

    if message and line_kind in {"assistant", "user"}:
        content = message.get("content")
        if isinstance(content, str):
            kind = MessageKind(line_kind, "message", "message", "text")
            payload = {"type": "text", "text": content}
            return [KindRecord(kind, payload, location, line_kind)]
        if isinstance(content, list):
            for index, item in enumerate(content):
                if not isinstance(item, dict):
                    key = "non_object_content"
                    payload = {"type": key, "index": index, "value": item}
                    records.append(
                        KindRecord(
                            MessageKind(line_kind, key, human_label(key), key),
                            payload,
                            location,
                            line_kind,
                        )
                    )
                    continue
                item_type = str(item.get("type") or "(missing)")
                content_kind, label = content_item_kind(line_kind, item_type)
                records.append(
                    KindRecord(
                        MessageKind(line_kind, content_kind, label, item_type),
                        item,
                        location,
                        line_kind,
                    )
                )
            return records
        key = "missing_content"
        kind = MessageKind(line_kind, key, human_label(key), key)
        return [KindRecord(kind, message, location, line_kind)]

    return [
        KindRecord(
            MessageKind(line_kind, None, None, line_kind, raw_only=True),
            event,
            location,
            line_kind,
        )
    ]


def scan_jsonl_records(
    root: Path,
    *,
    include_raw_only: bool = True,
    record_filter: Callable[[KindRecord], bool] | None = None,
) -> JsonlScan:
    result = JsonlScan(root=root)
    for path in iter_jsonl_files(root):
        result.files_scanned += 1
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    result.malformed_lines += 1
                    continue
                if not isinstance(event, dict):
                    result.malformed_lines += 1
                    continue
                event_type = str(event.get("type") or "(missing)")
                result.raw_event_counts[event_type] += 1
                location = SourceLocation(str(path), line_number, agent_scope_for_path(path))
                for record in classify_event(event, location):
                    if record.kind.raw_only and not include_raw_only:
                        continue
                    if record_filter and not record_filter(record):
                        continue
                    result.records.append(record)
    return result


def compact_example(payload: Any, sample_chars: int) -> Any:
    if not isinstance(payload, dict):
        return compact(payload, sample_chars)
    example: dict[str, Any] = {}
    for key, value in sorted(payload.items()):
        if isinstance(value, dict):
            example[key] = f"object({len(value)} keys)"
        elif isinstance(value, list):
            example[key] = f"array({len(value)} items)"
        elif isinstance(value, str):
            example[key] = compact(value, sample_chars)
        else:
            example[key] = value
    return example


def walk_shape(
    value: Any,
    *,
    path: str,
    shape: FieldShape,
    depth: int,
    max_depth: int,
    parse_json_strings: bool,
    sample_limit: int,
    sample_chars: int,
) -> None:
    shape.add_field(path, value, sample_limit=sample_limit, sample_chars=sample_chars)
    if depth >= max_depth:
        return
    if isinstance(value, dict):
        for key, child in sorted(value.items()):
            child_path = f"{path}.{key}" if path else str(key)
            walk_shape(
                child,
                path=child_path,
                shape=shape,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )
    elif isinstance(value, list):
        for child in value[:10]:
            walk_shape(
                child,
                path=f"{path}[]",
                shape=shape,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )
    elif parse_json_strings and isinstance(value, str):
        parsed = maybe_parse_json_string(value)
        if parsed is not None:
            walk_shape(
                parsed,
                path=f"{path}.$json",
                shape=shape,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )


def shape_for_payload(
    payload: Any,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    parse_json_strings: bool = True,
    sample_limit: int = 2,
    sample_chars: int = DEFAULT_SAMPLE_CHARS,
) -> FieldShape:
    shape = FieldShape()
    walk_shape(
        payload,
        path="",
        shape=shape,
        depth=0,
        max_depth=max_depth,
        parse_json_strings=parse_json_strings,
        sample_limit=sample_limit,
        sample_chars=sample_chars,
    )
    return shape


def shape_signature_id(shape: FieldShape) -> str:
    payload = "\n".join(shape.signature_parts()).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:12]
