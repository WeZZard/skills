from __future__ import annotations

import os

from pathlib import Path
from typing import Any


class Config:
    ROOT_DIR = Path(__file__).resolve().parent.parent
    APP_DIR = ROOT_DIR / "app"
    STATIC_DIR = APP_DIR / "static"
    TEMPLATES_DIR = APP_DIR / "templates"


def _expand_path(value: str | Path) -> Path:
    return Path(value).expanduser()


def resolve_claude_home(source_path: str | Path | None = None) -> Path:
    if source_path:
        path = _expand_path(source_path)
        return path.parent if path.name == "projects" else path
    return _expand_path(
        os.environ.get("CLAUDE_CONFIG_DIR")
        or os.environ.get("CLAUDE_CODE_HOME")
        or "~/.claude"
    )


def resolve_projects_dir(source_path: str | Path | None = None) -> Path:
    if source_path:
        path = _expand_path(source_path)
        if path.name == "projects":
            return path
        return path / "projects"
    override = os.environ.get("CLAUDE_PROJECTS_DIR")
    if override:
        return _expand_path(override)
    return resolve_claude_home() / "projects"


def resolve_opencode_data_dir(source_path: str | Path | None = None) -> Path:
    if source_path:
        return _expand_path(source_path)
    override = os.environ.get("OPENCODE_DATA_DIR")
    if override:
        return _expand_path(override)
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return _expand_path(xdg_data_home) / "opencode"
    return _expand_path("~/.local/share/opencode")


def source_info(source_path: str | Path | None = None) -> dict[str, Any]:
    home = resolve_claude_home(source_path)
    projects = resolve_projects_dir(source_path)
    home_readable = home.is_dir() and os.access(home, os.R_OK)
    return {
        "agent": "claude",
        "label": "Claude Code",
        "source_label": "Claude config directory",
        "source_path": str(source_path or home),
        "display_path": str(projects),
        "claude_home": str(home),
        "projects_dir": str(projects),
        "exists": projects.exists(),
        "readable": projects.is_dir() and os.access(projects, os.R_OK),
        "home_exists": home.exists(),
        "home_readable": home_readable,
        "direct_projects_dir": bool(source_path and _expand_path(source_path).name == "projects"),
        "projects_dir_env": bool(os.environ.get("CLAUDE_PROJECTS_DIR")),
        "claude_config_env": bool(os.environ.get("CLAUDE_CONFIG_DIR")),
        "claude_home_env": bool(os.environ.get("CLAUDE_CODE_HOME")),
    }


def opencode_source_info(source_path: str | Path | None = None) -> dict[str, Any]:
    data_dir = resolve_opencode_data_dir(source_path)
    db_path = data_dir / "opencode.db"
    data_dir_readable = data_dir.is_dir() and os.access(data_dir, os.R_OK)
    return {
        "agent": "opencode",
        "label": "OpenCode",
        "source_label": "Open Code data directory",
        "source_path": str(source_path or data_dir),
        "display_path": str(db_path),
        "data_dir": str(data_dir),
        "db_path": str(db_path),
        "exists": db_path.exists(),
        "readable": db_path.is_file() and os.access(db_path, os.R_OK),
        "home_exists": data_dir.exists(),
        "home_readable": data_dir_readable,
        "data_dir_env": bool(os.environ.get("OPENCODE_DATA_DIR")),
        "xdg_data_home_env": bool(os.environ.get("XDG_DATA_HOME")),
    }
