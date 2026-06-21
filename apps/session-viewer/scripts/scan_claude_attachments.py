from __future__ import annotations

import argparse
import json
import os
import sys

from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_SAMPLE_CHARS = 240
DEFAULT_MAX_DEPTH = 4


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
class AttachmentStats:
    count: int = 0
    files: Counter[str] = field(default_factory=Counter)
    fields: dict[str, FieldStats] = field(default_factory=lambda: defaultdict(FieldStats))
    examples: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "count": self.count,
            "files": dict(self.files.most_common(10)),
            "fields": {key: value.to_json() for key, value in sorted(self.fields.items())},
            "examples": self.examples,
        }


@dataclass
class ScanResult:
    root: Path
    files_scanned: int = 0
    malformed_lines: int = 0
    attachment_events: int = 0
    types: dict[str, AttachmentStats] = field(default_factory=lambda: defaultdict(AttachmentStats))

    def to_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "filesScanned": self.files_scanned,
            "malformedLines": self.malformed_lines,
            "attachmentEvents": self.attachment_events,
            "types": {key: value.to_json() for key, value in sorted(self.types.items())},
        }


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


def walk_fields(
    value: Any,
    *,
    path: str,
    stats: AttachmentStats,
    depth: int,
    max_depth: int,
    parse_json_strings: bool,
    sample_limit: int,
    sample_chars: int,
) -> None:
    if path:
        stats.fields[path].add(value, sample_limit=sample_limit, sample_chars=sample_chars)
    if depth >= max_depth:
        return
    if isinstance(value, dict):
        for key, child in sorted(value.items()):
            child_path = f"{path}.{key}" if path else str(key)
            walk_fields(
                child,
                path=child_path,
                stats=stats,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )
    elif isinstance(value, list):
        for child in value[:10]:
            walk_fields(
                child,
                path=f"{path}[]",
                stats=stats,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )
    elif parse_json_strings and isinstance(value, str):
        parsed = maybe_parse_json_string(value)
        if parsed is not None:
            walk_fields(
                parsed,
                path=f"{path}.$json",
                stats=stats,
                depth=depth + 1,
                max_depth=max_depth,
                parse_json_strings=parse_json_strings,
                sample_limit=sample_limit,
                sample_chars=sample_chars,
            )


def scan_attachments(
    root: Path,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    sample_limit: int = 2,
    sample_chars: int = DEFAULT_SAMPLE_CHARS,
    parse_json_strings: bool = True,
) -> ScanResult:
    result = ScanResult(root=root)
    for path in iter_jsonl_files(root):
        result.files_scanned += 1
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    result.malformed_lines += 1
                    continue
                attachment = event.get("attachment")
                if event.get("type") != "attachment" or not isinstance(attachment, dict):
                    continue
                result.attachment_events += 1
                attachment_type = str(attachment.get("type") or "(missing)")
                stats = result.types[attachment_type]
                stats.count += 1
                stats.files[str(path)] += 1
                if len(stats.examples) < sample_limit:
                    stats.examples.append(compact_example(attachment, sample_chars))
                walk_fields(
                    attachment,
                    path="",
                    stats=stats,
                    depth=0,
                    max_depth=max_depth,
                    parse_json_strings=parse_json_strings,
                    sample_limit=sample_limit,
                    sample_chars=sample_chars,
                )
    return result


def compact_example(attachment: dict[str, Any], sample_chars: int) -> dict[str, Any]:
    example: dict[str, Any] = {}
    for key, value in sorted(attachment.items()):
        if isinstance(value, dict):
            example[key] = f"object({len(value)} keys)"
        elif isinstance(value, list):
            example[key] = f"array({len(value)} items)"
        elif isinstance(value, str):
            example[key] = compact(value, sample_chars)
        else:
            example[key] = value
    return example


def resolve_root(args: argparse.Namespace) -> Path:
    if args.projects_dir:
        return Path(args.projects_dir).expanduser()
    env_projects = os.environ.get("CLAUDE_PROJECTS_DIR")
    if env_projects:
        return Path(env_projects).expanduser()
    if args.claude_config_dir:
        return Path(args.claude_config_dir).expanduser() / "projects"
    env_config = os.environ.get("CLAUDE_CONFIG_DIR")
    if env_config:
        return Path(env_config).expanduser() / "projects"
    if args.claude_home:
        return Path(args.claude_home).expanduser() / "projects"
    env_home = os.environ.get("CLAUDE_CODE_HOME")
    if env_home:
        return Path(env_home).expanduser() / "projects"
    return Path.home() / ".claude" / "projects"


def render_text(result: ScanResult, *, field_limit: int) -> str:
    lines = [
        f"Root: {result.root}",
        f"Files scanned: {result.files_scanned}",
        f"Attachment events: {result.attachment_events}",
        f"Malformed JSONL lines: {result.malformed_lines}",
        "",
        "Attachment types:",
    ]
    if not result.types:
        lines.append("  none")
        return "\n".join(lines)

    for attachment_type, stats in sorted(
        result.types.items(),
        key=lambda item: (-item[1].count, item[0]),
    ):
        lines.append(f"  {stats.count:>7}  {attachment_type}")

    for attachment_type, stats in sorted(result.types.items()):
        lines.extend(["", f"{attachment_type}", "-" * len(attachment_type)])
        for field_name, field_stats in sorted(stats.fields.items())[:field_limit]:
            type_summary = ", ".join(
                f"{name}:{count}" for name, count in sorted(field_stats.types.items())
            )
            details = []
            if field_stats.max_length:
                details.append(f"max {field_stats.max_length} chars")
            if field_stats.max_items:
                details.append(f"max {field_stats.max_items} items")
            suffix = f" ({'; '.join(details)})" if details else ""
            lines.append(f"  {field_name}: {type_summary}{suffix}")
        if len(stats.fields) > field_limit:
            lines.append(f"  ... {len(stats.fields) - field_limit} more fields")
        if stats.examples:
            lines.append("  Example:")
            for key, value in stats.examples[0].items():
                lines.append(f"    {key}: {value}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scan Claude Code JSONL transcripts for attachment event types and payload shapes.",
    )
    parser.add_argument("--projects-dir", help="Claude projects directory or a single JSONL file.")
    parser.add_argument("--claude-config-dir", help="Claude config directory; scans <dir>/projects.")
    parser.add_argument("--claude-home", help="Claude home directory; scans <dir>/projects.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--sample-limit", type=int, default=2)
    parser.add_argument("--sample-chars", type=int, default=DEFAULT_SAMPLE_CHARS)
    parser.add_argument("--field-limit", type=int, default=40)
    parser.add_argument(
        "--no-parse-json-strings",
        action="store_true",
        help="Do not inspect JSON-looking string fields such as hook stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = resolve_root(args)
    if not root.exists():
        parser.error(f"Claude transcript path does not exist: {root}")
    result = scan_attachments(
        root,
        max_depth=args.max_depth,
        sample_limit=max(0, args.sample_limit),
        sample_chars=max(20, args.sample_chars),
        parse_json_strings=not args.no_parse_json_strings,
    )
    if args.json:
        print(json.dumps(result.to_json(), indent=2, sort_keys=True))
    else:
        print(render_text(result, field_limit=max(1, args.field_limit)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
