from __future__ import annotations

import base64
import json

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.claude_parser import (
    ParsedTranscript,
    explicit_title_from_event,
    parse_jsonl_file,
    title_candidate_from_text,
)
from app.config import resolve_projects_dir, source_info
from app.models import (
    ConversationExport,
    ConversationSummary,
    GenericPart,
    NavAddress,
    ParserDiagnostic,
)
from app.problem_detector import attach_problem_flags


@dataclass(frozen=True)
class SessionRef:
    project_key: str
    session_id: str

    @property
    def opaque_id(self) -> str:
        payload = json.dumps(
            {"project": self.project_key, "session": self.session_id}, separators=(",", ":")
        )
        return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_session_ref(opaque_id: str) -> SessionRef:
    padded = opaque_id + "=" * (-len(opaque_id) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    return SessionRef(project_key=payload["project"], session_id=payload["session"])


def _project_directory(projects_dir: Path, project_key: str) -> Path:
    return projects_dir / project_key


def _session_file(projects_dir: Path, ref: SessionRef) -> Path:
    return _project_directory(projects_dir, ref.project_key) / f"{ref.session_id}.jsonl"


def _read_first_json(path: Path, max_lines: int = 240) -> list[dict[str, Any]]:
    events = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for _, line in zip(range(max_lines), fh):
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return events


def _latest_ai_title(path: Path) -> str | None:
    title = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(raw, dict) and raw.get("type") == "ai-title":
                    title = explicit_title_from_event(raw) or title
    except OSError:
        return None
    return title


def _summary_from_file(projects_dir: Path, path: Path) -> ConversationSummary:
    project_key = path.parent.name
    session_uuid = path.stem
    ref = SessionRef(project_key=project_key, session_id=session_uuid)
    events = _read_first_json(path)
    timestamps = []
    title = None
    explicit_title = None
    model = "Unknown"
    directory = None
    git_branch = None
    version = None
    count = 0
    for raw in events:
        count += 1
        raw_explicit_title = explicit_title_from_event(raw)
        if raw_explicit_title and (raw.get("type") == "ai-title" or explicit_title is None):
            explicit_title = raw_explicit_title
        directory = directory or raw.get("cwd")
        branch = raw.get("gitBranch") or raw.get("branch")
        if git_branch is None and isinstance(branch, str) and branch.strip():
            git_branch = branch.strip()
        version = version or raw.get("version")
        timestamp = raw.get("timestamp")
        if timestamp:
            timestamps.append(timestamp)
        message = raw.get("message")
        if isinstance(message, dict):
            if isinstance(message.get("model"), str):
                model = message["model"]
            content = message.get("content")
            if title is None and message.get("role") == "user" and isinstance(content, str):
                title = title_candidate_from_text(content, raw)
            if title is None and message.get("role") == "user" and isinstance(content, list):
                for item in content:
                    if (
                        isinstance(item, dict)
                        and item.get("type") == "text"
                        and item.get("text")
                    ):
                        title = title_candidate_from_text(item["text"], raw)
                        if title:
                            break
    subagent_dir = path.parent / session_uuid / "subagents"
    subagent_count = (
        len(list(subagent_dir.glob("agent-*.jsonl"))) if subagent_dir.exists() else 0
    )
    subagent_count += (
        len(list(subagent_dir.glob("workflows/*/agent-*.jsonl")))
        if subagent_dir.exists()
        else 0
    )
    updated = int(path.stat().st_mtime * 1000)
    latest_ai_title = _latest_ai_title(path)
    return ConversationSummary(
        id=ref.opaque_id,
        title=latest_ai_title or explicit_title or title or session_uuid,
        directory=directory or _display_project_key(project_key),
        gitBranch=git_branch,
        version=version,
        time_updated=updated,
        model=model,
        message_count=count,
        subagent_count=subagent_count,
    )


def _display_project_key(project_key: str) -> str:
    if project_key.startswith("-"):
        return "/" + project_key[1:].replace("-", "/")
    return project_key


def list_sessions(
    query: str | None = None,
    directory: str | None = None,
    source_path: str | Path | None = None,
) -> list[ConversationSummary]:
    projects_dir = resolve_projects_dir(source_path)
    if not projects_dir.is_dir():
        return []
    summaries: list[ConversationSummary] = []
    for project in sorted(projects_dir.iterdir(), key=lambda p: p.name):
        if not project.is_dir():
            continue
        for path in sorted(project.glob("*.jsonl")):
            # Only root JSONL files are main sessions; subagents live under session folders.
            summary = _summary_from_file(projects_dir, path)
            haystack = " ".join(
                [summary.title or "", summary.directory or "", summary.model or "", summary.id]
            ).lower()
            if query and query.lower() not in haystack:
                continue
            if directory and directory.lower() not in (summary.directory or "").lower():
                continue
            summaries.append(summary)
    return sorted(summaries, key=lambda s: s.time_updated or 0, reverse=True)


def list_directories(source_path: str | Path | None = None) -> list[str]:
    return sorted({s.directory for s in list_sessions(source_path=source_path) if s.directory})


def _load_meta(path: Path) -> dict[str, str]:
    meta = path.with_suffix(".meta.json")
    if not meta.exists():
        return {}
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, str] = {}
    for key in ("agentType", "description", "toolUseId"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def _part_input(part: GenericPart) -> dict[str, Any]:
    state = part.state if isinstance(part.state, dict) else {}
    data = state.get("input")
    return data if isinstance(data, dict) else {}


def _iter_tool_parts(export: ConversationExport) -> list[tuple[str | None, GenericPart]]:
    pairs: list[tuple[str | None, GenericPart]] = []
    for message in export.messages:
        for part in message.parts:
            if part.type == "tool":
                pairs.append((message.id, part))
    return pairs


def _make_export(
    parsed: ParsedTranscript, *, opaque_id: str, task_link: dict[str, str] | None = None
) -> ConversationExport:
    times = [m.time_created for m in parsed.messages if m.time_created]
    summary = ConversationSummary(
        id=opaque_id if parsed.scope == "main" else f"{opaque_id}:{parsed.agent_path}",
        title=parsed.title,
        directory=parsed.cwd,
        gitBranch=parsed.git_branch,
        version=None,
        time_created=min(times) if times else None,
        time_updated=max(times) if times else None,
        model=parsed.model or "Unknown",
        message_count=len(parsed.messages),
        subagent_count=0,
    )
    task_link = task_link or {}
    return ConversationExport(
        summary=summary,
        messages=parsed.messages,
        task_part_id=task_link.get("task_part_id"),
        task_message_id=task_link.get("task_message_id"),
        agent_type=task_link.get("agent_type") or parsed.agent_type or parsed.agent_id,
        agent_description=task_link.get("agent_description"),
        raw_events=parsed.raw_events,
        parser_diagnostics=parsed.diagnostics,
        nav_index=parsed.nav_index,
    )


def _discover_subagents(
    session_dir: Path, session_uuid: str
) -> list[tuple[str, Path, str, str, str | None]]:
    root = session_dir / session_uuid / "subagents"
    discovered: list[tuple[str, Path, str, str, str | None]] = []
    if not root.exists():
        return discovered
    for path in sorted(root.glob("agent-*.jsonl")):
        agent_id = path.stem.removeprefix("agent-")
        meta = _load_meta(path)
        discovered.append(
            (
                agent_id,
                path,
                f"main/{agent_id}",
                meta.get("agentType") or "subagent",
                meta.get("description"),
            )
        )
    for path in sorted(root.glob("workflows/*/agent-*.jsonl")):
        agent_id = path.stem.removeprefix("agent-")
        workflow_id = path.parent.name
        meta = _load_meta(path)
        discovered.append(
            (
                agent_id,
                path,
                f"main/workflow:{workflow_id}/{agent_id}",
                meta.get("agentType") or "workflow-subagent",
                meta.get("description"),
            )
        )
    return discovered


def _tool_spawn_agent_id(parsed: ParsedTranscript, part: GenericPart) -> tuple[str, str] | None:
    if part.id and part.id in parsed.tool_result_agent_ids:
        return parsed.tool_result_agent_ids[part.id], "explicit toolUseResult.agentId"
    state = part.state if isinstance(part.state, dict) else {}
    metadata = state.get("metadata")
    if isinstance(metadata, dict):
        metadata_keys = ("agentId", "sessionId", "session_id")
        value = next(
            (metadata.get(key) for key in metadata_keys if isinstance(metadata.get(key), str)),
            None,
        )
        if isinstance(value, str):
            return value, "inferred tool metadata agent id"
    return None


def _attach_children(
    export: ConversationExport,
    parsed: ParsedTranscript,
    parsed_by_agent: dict[str, ParsedTranscript],
    exports_by_agent: dict[str, ConversationExport],
    used: set[str],
    opaque_id: str,
) -> None:
    for message_id, part in _iter_tool_parts(export):
        spawn = _tool_spawn_agent_id(parsed, part)
        if not spawn:
            continue
        agent_id, basis = spawn
        if agent_id not in exports_by_agent:
            if part.nav:
                export.parser_diagnostics.append(
                    ParserDiagnostic(
                        id=f"missing-agent:{agent_id}:{part.id}",
                        severity="error",
                        kind="missing_subagent_file",
                        message=f"Task/Agent tool references agentId {agent_id}, but no transcript file was found.",
                        nav=part.nav,
                    )
                )
            continue
        if agent_id in used:
            continue
        child = exports_by_agent[agent_id]
        parent_nav = _first_nav(export)
        child_nav = _first_nav(child)
        if parent_nav and child_nav:
            new_agent_path = (
                f"{parent_nav.agentPath}/{agent_id}"
                if parent_nav.agentPath != "main"
                else f"main/{agent_id}"
            )
            _rebase_agent_path(child, child_nav.agentPath, new_agent_path)
        child.task_part_id = part.id
        child.task_message_id = message_id
        child.parent_task_nav = part.nav
        child.parent_result_nav = parsed.tool_result_navs.get(str(part.id)) if part.id else None
        child.relationship_basis = basis
        child.relationship_hint = f"attached by {basis}"
        child.agent_type = _part_input(part).get("subagent_type") or child.agent_type
        child.agent_description = (
            _part_input(part).get("description") or child.agent_description
        )
        export.subagent_transcripts.append(child)
        used.add(agent_id)
        _attach_children(
            child, parsed_by_agent[agent_id], parsed_by_agent, exports_by_agent, used, opaque_id
        )


def _first_nav(export: ConversationExport) -> NavAddress | None:
    return (
        export.messages[0].nav
        if export.messages
        else export.raw_events[0].nav
        if export.raw_events
        else None
    )


def _rebase_agent_path(export: ConversationExport, old_prefix: str, new_prefix: str) -> None:
    if old_prefix == new_prefix:
        return

    def rewrite(nav: NavAddress | None) -> None:
        if nav and nav.agentPath == old_prefix:
            nav.agentPath = new_prefix
        elif nav and nav.agentPath.startswith(f"{old_prefix}/"):
            nav.agentPath = f"{new_prefix}{nav.agentPath[len(old_prefix) :]}"

    rewrite(export.parent_task_nav)
    rewrite(export.parent_result_nav)
    rewrite(export.previous_sibling_nav)
    rewrite(export.next_sibling_nav)
    for message in export.messages:
        rewrite(message.nav)
        for part in message.parts:
            rewrite(part.nav)
    for raw_event in export.raw_events:
        rewrite(raw_event.nav)
    for diagnostic in export.parser_diagnostics:
        rewrite(diagnostic.nav)
        for related in diagnostic.related:
            rewrite(related)
    for child in export.subagent_transcripts:
        _rebase_agent_path(child, old_prefix, new_prefix)


def _assign_workflow_siblings(export: ConversationExport) -> None:
    workflow_groups: dict[str, list[ConversationExport]] = {}

    def visit(node: ConversationExport) -> None:
        for child in node.subagent_transcripts:
            first_nav = _first_nav(child)
            agent_path = first_nav.agentPath if first_nav else ""
            if "/workflow:" in agent_path:
                workflow_key = agent_path.rsplit("/", 1)[0]
                workflow_groups.setdefault(workflow_key, []).append(child)
            visit(child)

    visit(export)
    for siblings in workflow_groups.values():
        ordered = sorted(
            siblings, key=lambda child: _first_nav(child).agentPath if _first_nav(child) else ""
        )
        for index, child in enumerate(ordered):
            previous_child = ordered[index - 1] if index > 0 else None
            next_child = ordered[index + 1] if index + 1 < len(ordered) else None
            child.previous_sibling_nav = _first_nav(previous_child) if previous_child else None
            child.next_sibling_nav = _first_nav(next_child) if next_child else None


def load_conversation(
    opaque_id: str,
    source_path: str | Path | None = None,
) -> ConversationExport | None:
    projects_dir = resolve_projects_dir(source_path)
    try:
        ref = decode_session_ref(opaque_id)
    except Exception:
        return None
    main_path = _session_file(projects_dir, ref)
    if not main_path.exists():
        return None

    main = parse_jsonl_file(main_path, session_id=opaque_id)
    parsed_by_agent: dict[str, ParsedTranscript] = {}
    exports_by_agent: dict[str, ConversationExport] = {}
    for agent_id, path, agent_path, agent_type, agent_description in _discover_subagents(
        main_path.parent, ref.session_id
    ):
        parsed = parse_jsonl_file(
            path,
            session_id=opaque_id,
            scope="workflow" if "workflow:" in agent_path else "subagent",
            agent_path=agent_path,
            agent_type=agent_type,
        )
        parsed.agent_id = parsed.agent_id or agent_id
        parsed_by_agent[agent_id] = parsed
        exports_by_agent[agent_id] = _make_export(
            parsed,
            opaque_id=opaque_id,
            task_link={
                "agent_type": agent_type,
                "agent_description": agent_description or "",
            },
        )

    root = _make_export(main, opaque_id=opaque_id)
    used: set[str] = set()
    _attach_children(root, main, parsed_by_agent, exports_by_agent, used, opaque_id)

    for agent_id, child in exports_by_agent.items():
        if agent_id in used:
            continue
        child.agent_type = child.agent_type or "unattached"
        child.relationship_basis = "no parent match"
        child.relationship_hint = (
            "unattached transcript; no matching parent Task/Agent result was found"
        )
        if child.agent_type and "workflow" in child.agent_type:
            child.summary.title = f"Workflow {child.summary.title}"
        root.subagent_transcripts.append(child)
        if child.raw_events:
            root.parser_diagnostics.append(
                ParserDiagnostic(
                    id=f"unattached:{agent_id}",
                    kind="unattached_subagent",
                    message=f"Subagent transcript {agent_id} could not be attached to a parent Task/Agent call.",
                    nav=child.raw_events[0].nav,
                )
            )

    root.summary.subagent_count = len(root.subagent_transcripts)
    _assign_workflow_siblings(root)
    attach_problem_flags(root)
    return root


def get_source_info(source_path: str | Path | None = None) -> dict[str, Any]:
    return source_info(source_path)
