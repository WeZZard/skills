from __future__ import annotations

import argparse
import json
import sys

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.claude_transcript_scan import (
    DEFAULT_MAX_DEPTH,
    DEFAULT_SAMPLE_CHARS,
    FieldStats,
    add_source_args,
    compact_example,
    resolve_projects_root,
    scan_jsonl_records,
    shape_for_payload,
)


@dataclass
class SystemSubtypeStats:
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
    system_events: int = 0
    subtypes: dict[str, SystemSubtypeStats] = field(
        default_factory=lambda: defaultdict(SystemSubtypeStats)
    )

    def to_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "filesScanned": self.files_scanned,
            "malformedLines": self.malformed_lines,
            "systemEvents": self.system_events,
            "subtypes": {key: value.to_json() for key, value in sorted(self.subtypes.items())},
        }


def scan_system_messages(
    root: Path,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    sample_limit: int = 2,
    sample_chars: int = DEFAULT_SAMPLE_CHARS,
    parse_json_strings: bool = True,
) -> ScanResult:
    scan = scan_jsonl_records(
        root,
        include_raw_only=False,
        record_filter=lambda record: record.kind.line_kind == "system",
    )
    result = ScanResult(
        root=scan.root,
        files_scanned=scan.files_scanned,
        malformed_lines=scan.malformed_lines,
    )
    for record in scan.records:
        subtype = record.kind.content_kind
        stats = result.subtypes[subtype]
        stats.count += 1
        stats.files[record.location.file] += 1
        result.system_events += 1
        if len(stats.examples) < sample_limit:
            stats.examples.append(compact_example(record.payload, sample_chars))
        shape = shape_for_payload(
            record.payload,
            max_depth=max_depth,
            parse_json_strings=parse_json_strings,
            sample_limit=sample_limit,
            sample_chars=sample_chars,
        )
        for field_name, field_stats in shape.fields.items():
            stats.fields[field_name].merge(field_stats)
    return result


def render_text(result: ScanResult, *, field_limit: int) -> str:
    lines = [
        f"Root: {result.root}",
        f"Files scanned: {result.files_scanned}",
        f"System events: {result.system_events}",
        f"Malformed JSONL lines: {result.malformed_lines}",
        "",
        "System subtypes:",
    ]
    if not result.subtypes:
        lines.append("  none")
        return "\n".join(lines)

    for subtype, stats in sorted(
        result.subtypes.items(),
        key=lambda item: (-item[1].count, item[0]),
    ):
        lines.append(f"  {stats.count:>7}  {subtype}")

    for subtype, stats in sorted(result.subtypes.items()):
        lines.extend(["", f"{subtype}", "-" * len(subtype)])
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
        description="Compatibility wrapper for scanning Claude Code system event shapes.",
    )
    add_source_args(parser)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--sample-limit", type=int, default=2)
    parser.add_argument("--sample-chars", type=int, default=DEFAULT_SAMPLE_CHARS)
    parser.add_argument("--field-limit", type=int, default=40)
    parser.add_argument(
        "--no-parse-json-strings",
        action="store_true",
        help="Do not inspect JSON-looking string fields.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = resolve_projects_root(args)
    if not root.exists():
        parser.error(f"Claude transcript path does not exist: {root}")
    result = scan_system_messages(
        root,
        max_depth=max(0, args.max_depth),
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
