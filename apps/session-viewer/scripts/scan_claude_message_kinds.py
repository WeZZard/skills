from __future__ import annotations

import argparse
import json
import sys

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.claude_transcript_scan import (
    MessageKind,
    SourceLocation,
    add_source_args,
    resolve_projects_root,
    scan_jsonl_records,
)


@dataclass
class KindStats:
    kind: MessageKind
    count: int = 0
    agent_scopes: Counter[str] = field(default_factory=Counter)
    samples: list[SourceLocation] = field(default_factory=list)

    def add(self, location: SourceLocation, *, sample_limit: int) -> None:
        self.count += 1
        self.agent_scopes[location.agent_scope] += 1
        if len(self.samples) < sample_limit:
            self.samples.append(location)

    def to_json(self) -> dict[str, Any]:
        return {
            **self.kind.to_json(),
            "count": self.count,
            "agentScopes": dict(self.agent_scopes.most_common()),
            "samples": [sample.to_json() for sample in self.samples],
        }


@dataclass
class KindScanResult:
    root: Path
    files_scanned: int = 0
    malformed_lines: int = 0
    total_records: int = 0
    raw_event_counts: Counter[str] = field(default_factory=Counter)
    kinds: dict[str, KindStats] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "filesScanned": self.files_scanned,
            "malformedLines": self.malformed_lines,
            "totalRecords": self.total_records,
            "rawEventCounts": dict(sorted(self.raw_event_counts.items())),
            "kinds": {
                key: stats.to_json()
                for key, stats in sorted(self.kinds.items())
            },
        }


def scan_message_kinds(
    root: Path,
    *,
    include_raw_only: bool = True,
    sample_limit: int = 3,
) -> KindScanResult:
    scan = scan_jsonl_records(root, include_raw_only=include_raw_only)
    result = KindScanResult(
        root=scan.root,
        files_scanned=scan.files_scanned,
        malformed_lines=scan.malformed_lines,
        raw_event_counts=scan.raw_event_counts,
    )
    for record in scan.records:
        key = record.kind.key
        if key not in result.kinds:
            result.kinds[key] = KindStats(record.kind)
        result.kinds[key].add(record.location, sample_limit=max(0, sample_limit))
        result.total_records += 1
    return result


def render_text(result: KindScanResult) -> str:
    lines = [
        f"Root: {result.root}",
        f"Files scanned: {result.files_scanned}",
        f"Message kind records: {result.total_records}",
        f"Malformed JSONL lines: {result.malformed_lines}",
        "",
        "Raw JSONL event types:",
    ]
    if not result.raw_event_counts:
        lines.append("  none")
    else:
        for event_type, count in result.raw_event_counts.most_common():
            lines.append(f"  {count:>7}  {event_type}")

    lines.extend(["", "Viewer message kinds:"])
    if not result.kinds:
        lines.append("  none")
        return "\n".join(lines)

    for _, stats in sorted(
        result.kinds.items(),
        key=lambda item: (-item[1].count, item[0]),
    ):
        scopes = ", ".join(f"{name}:{count}" for name, count in stats.agent_scopes.most_common(4))
        lines.append(f"  {stats.count:>7}  {stats.kind.label}  [{scopes}]")
        for sample in stats.samples[:2]:
            lines.append(f"           sample {sample.file}:{sample.line} ({sample.agent_scope})")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Identify Claude Code transcript message kinds across main and subagent JSONL files.",
    )
    add_source_args(parser)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--sample-limit", type=int, default=3)
    parser.add_argument(
        "--no-raw-only",
        action="store_true",
        help="Exclude raw-only JSONL event types from viewer message kind records.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = resolve_projects_root(args)
    if not root.exists():
        parser.error(f"Claude transcript path does not exist: {root}")
    result = scan_message_kinds(
        root,
        include_raw_only=not args.no_raw_only,
        sample_limit=max(0, args.sample_limit),
    )
    if args.json:
        print(json.dumps(result.to_json(), indent=2, sort_keys=True))
    else:
        print(render_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
