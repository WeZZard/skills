from __future__ import annotations

import os

from pathlib import Path


class Config:
    ROOT_DIR = Path(__file__).resolve().parent.parent
    APP_DIR = ROOT_DIR / "app"
    STATIC_DIR = APP_DIR / "static"
    TEMPLATES_DIR = APP_DIR / "templates"


def resolve_claude_home() -> Path:
    return Path(os.environ.get("CLAUDE_CODE_HOME", "~/.claude")).expanduser()


def resolve_projects_dir() -> Path:
    override = os.environ.get("CLAUDE_PROJECTS_DIR")
    if override:
        return Path(override).expanduser()
    return resolve_claude_home() / "projects"


def source_info() -> dict[str, str | bool]:
    home = resolve_claude_home()
    projects = resolve_projects_dir()
    return {
        "claude_home": str(home),
        "projects_dir": str(projects),
        "exists": projects.exists(),
        "readable": projects.is_dir() and os.access(projects, os.R_OK),
    }
