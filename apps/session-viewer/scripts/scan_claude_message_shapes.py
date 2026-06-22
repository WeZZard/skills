from __future__ import annotations

import argparse
import json
import sys

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.claude_transcript_scan import (
    DEFAULT_MAX_DEPTH,
    DEFAULT_SAMPLE_CHARS,
    FieldStats,
    MessageKind,
    SourceLocation,
    add_source_args,
    compact_example,
    resolve_projects_root,
    scan_jsonl_records,
    shape_for_payload,
    shape_signature_id,
)


@dataclass
class ShapeStats:
    kind: MessageKind
    signature_id: str
    count: int = 0
    fields: dict[str, FieldStats] = field(default_factory=dict)
    examples: list[Any] = field(default_factory=list)
    samples: list[SourceLocation] = field(default_factory=list)

    def add(
        self,
        payload: Any,
        fields: dict[str, FieldStats],
        location: SourceLocation,
        *,
        sample_limit: int,
        sample_chars: int,
    ) -> None:
        self.count += 1
        for name, stats in fields.items():
            if name not in self.fields:
                self.fields[name] = FieldStats()
            self.fields[name].merge(stats)
        if len(self.examples) < sample_limit:
            self.examples.append(compact_example(payload, sample_chars))
        if len(self.samples) < sample_limit:
            self.samples.append(location)

    def required_fields(self) -> list[str]:
        return sorted(name for name, stats in self.fields.items() if stats.count == self.count)

    def optional_fields(self) -> list[str]:
        return sorted(name for name, stats in self.fields.items() if stats.count < self.count)

    def to_json(self) -> dict[str, Any]:
        return {
            "signatureId": self.signature_id,
            "count": self.count,
            "requiredFields": self.required_fields(),
            "optionalFields": self.optional_fields(),
            "fields": {
                key: value.to_json()
                for key, value in sorted(self.fields.items())
            },
            "examples": self.examples,
            "samples": [sample.to_json() for sample in self.samples],
        }


@dataclass
class KindShapeStats:
    kind: MessageKind
    count: int = 0
    shapes: dict[str, ShapeStats] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            **self.kind.to_json(),
            "count": self.count,
            "shapeCount": len(self.shapes),
            "shapes": {
                key: shape.to_json()
                for key, shape in sorted(
                    self.shapes.items(),
                    key=lambda item: (-item[1].count, item[0]),
                )
            },
        }


@dataclass
class ShapeScanResult:
    root: Path
    files_scanned: int = 0
    malformed_lines: int = 0
    total_records: int = 0
    kinds: dict[str, KindShapeStats] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "filesScanned": self.files_scanned,
            "malformedLines": self.malformed_lines,
            "totalRecords": self.total_records,
            "kinds": {
                key: stats.to_json()
                for key, stats in sorted(self.kinds.items())
            },
        }


def scan_message_shapes(
    root: Path,
    *,
    include_raw_only: bool = True,
    kind_filters: set[str] | None = None,
    max_depth: int = DEFAULT_MAX_DEPTH,
    sample_limit: int = 2,
    sample_chars: int = DEFAULT_SAMPLE_CHARS,
    parse_json_strings: bool = True,
) -> ShapeScanResult:
    def matches_kind(record: Any) -> bool:
        return not kind_filters or record.kind.key in kind_filters

    scan = scan_jsonl_records(
        root,
        include_raw_only=include_raw_only,
        record_filter=matches_kind,
    )
    result = ShapeScanResult(
        root=scan.root,
        files_scanned=scan.files_scanned,
        malformed_lines=scan.malformed_lines,
    )
    for record in scan.records:
        shape = shape_for_payload(
            record.payload,
            max_depth=max_depth,
            parse_json_strings=parse_json_strings,
            sample_limit=max(0, sample_limit),
            sample_chars=max(20, sample_chars),
        )
        signature_id = shape_signature_id(shape)
        kind_key = record.kind.key
        if kind_key not in result.kinds:
            result.kinds[kind_key] = KindShapeStats(record.kind)
        kind_stats = result.kinds[kind_key]
        kind_stats.count += 1
        result.total_records += 1
        if signature_id not in kind_stats.shapes:
            kind_stats.shapes[signature_id] = ShapeStats(record.kind, signature_id)
        kind_stats.shapes[signature_id].add(
            record.payload,
            shape.fields,
            record.location,
            sample_limit=max(0, sample_limit),
            sample_chars=max(20, sample_chars),
        )
    return result


def render_text(result: ShapeScanResult, *, field_limit: int) -> str:
    lines = [
        f"Root: {result.root}",
        f"Files scanned: {result.files_scanned}",
        f"Message kind records: {result.total_records}",
        f"Malformed JSONL lines: {result.malformed_lines}",
        "",
        "Message shapes:",
    ]
    if not result.kinds:
        lines.append("  none")
        return "\n".join(lines)

    for _, kind_stats in sorted(
        result.kinds.items(),
        key=lambda item: (-item[1].count, item[0]),
    ):
        lines.append("")
        lines.append(
            f"{kind_stats.kind.label}: {kind_stats.count} records, "
            f"{len(kind_stats.shapes)} shapes"
        )
        for _, shape in sorted(
            kind_stats.shapes.items(),
            key=lambda item: (-item[1].count, item[0]),
        ):
            lines.append(f"  shape {shape.signature_id}: {shape.count} records")
            required = shape.required_fields()
            optional = shape.optional_fields()
            if required:
                lines.append("    required:")
                for field_name in required[:field_limit]:
                    lines.append(f"      {field_name}")
                if len(required) > field_limit:
                    lines.append(f"      ... {len(required) - field_limit} more")
            if optional:
                lines.append("    optional:")
                for field_name in optional[:field_limit]:
                    lines.append(f"      {field_name}")
                if len(optional) > field_limit:
                    lines.append(f"      ... {len(optional) - field_limit} more")
            for sample in shape.samples[:2]:
                lines.append(f"    sample {sample.file}:{sample.line} ({sample.agent_scope})")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze Claude Code transcript structural shapes by message kind.",
    )
    add_source_args(parser)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument(
        "--kind",
        action="append",
        default=[],
        help="Limit to a kind key such as assistant/tool_call or system/turn_duration.",
    )
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--sample-limit", type=int, default=2)
    parser.add_argument("--sample-chars", type=int, default=DEFAULT_SAMPLE_CHARS)
    parser.add_argument("--field-limit", type=int, default=30)
    parser.add_argument(
        "--no-parse-json-strings",
        action="store_true",
        help="Do not inspect JSON-looking string fields such as hook stdout.",
    )
    parser.add_argument(
        "--no-raw-only",
        action="store_true",
        help="Exclude raw-only JSONL event types from shape records.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = resolve_projects_root(args)
    if not root.exists():
        parser.error(f"Claude transcript path does not exist: {root}")
    result = scan_message_shapes(
        root,
        include_raw_only=not args.no_raw_only,
        kind_filters=set(args.kind) or None,
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
