from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import claude_store, opencode_store
from app.config import Config
from app.models import ConversationExport, ConversationSummary


app = FastAPI(title="Session Viewer")
app.mount("/static", StaticFiles(directory=str(Config.STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(Config.TEMPLATES_DIR))


AGENTS = {"claude": "Claude Code", "opencode": "OpenCode"}
DASHBOARD_PARAM_KEYS = (
    "tab",
    "claude_home",
    "claude_q",
    "claude_directory",
    "opencode_data_dir",
    "opencode_q",
    "opencode_directory",
)


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _dashboard_params(request: Request) -> dict[str, str]:
    params = {key: _clean(request.query_params.get(key)) for key in DASHBOARD_PARAM_KEYS}
    params["tab"] = params["tab"] if params["tab"] in AGENTS else "claude"
    return params


def _href(path: str, params: dict[str, str], **updates: str | None) -> str:
    merged = {**params}
    for key, value in updates.items():
        merged[key] = _clean(value)
    query = urlencode({key: value for key, value in merged.items() if value})
    return f"{path}?{query}" if query else path


def _agent_or_404(agent: str) -> str:
    if agent not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent}")
    return agent


def _source_path(agent: str, params: dict[str, str]) -> str | None:
    if agent == "claude":
        return params.get("claude_home") or None
    return params.get("opencode_data_dir") or None


def _query(agent: str, params: dict[str, str]) -> str | None:
    return params.get(f"{agent}_q") or None


def _directory(agent: str, params: dict[str, str]) -> str | None:
    return params.get(f"{agent}_directory") or None


def _source_info(agent: str, source_path: str | None) -> dict[str, Any]:
    if agent == "claude":
        return claude_store.get_source_info(source_path)
    return opencode_store.get_source_info(source_path)


def _list_sessions(agent: str, params: dict[str, str]) -> list[ConversationSummary]:
    kwargs = {
        "query": _query(agent, params),
        "directory": _directory(agent, params),
        "source_path": _source_path(agent, params),
    }
    if agent == "claude":
        return claude_store.list_sessions(**kwargs)
    return opencode_store.list_sessions(**kwargs)


def _list_directories(agent: str, source_path: str | None = None) -> list[str]:
    if agent == "claude":
        return claude_store.list_directories(source_path=source_path)
    return opencode_store.list_directories(source_path=source_path)


def _load_conversation(agent: str, session_id: str, source_path: str | None = None) -> ConversationExport | None:
    if agent == "claude":
        return claude_store.load_conversation(session_id, source_path=source_path)
    return opencode_store.load_conversation(session_id, source_path=source_path)


def _session_items(
    agent: str,
    sessions: list[ConversationSummary],
    params: dict[str, str],
) -> list[dict[str, Any]]:
    scoped_params = {**params, "tab": agent}
    return [
        {
            "summary": session,
            "href": _href(f"/conversation/{agent}/{session.id}", scoped_params),
        }
        for session in sessions
    ]


def _dashboard_context(request: Request) -> dict[str, Any]:
    params = _dashboard_params(request)
    panels: dict[str, dict[str, Any]] = {}
    for agent, label in AGENTS.items():
        source_path = _source_path(agent, params)
        sessions = _list_sessions(agent, params)
        panels[agent] = {
            "agent": agent,
            "label": label,
            "active": params["tab"] == agent,
            "tab_href": _href("/", params, tab=agent),
            "source": _source_info(agent, source_path),
            "query": _query(agent, params) or "",
            "directory": _directory(agent, params) or "",
            "source_value": source_path or "",
            "session_items": _session_items(agent, sessions, params),
        }
    return {
        "active_tab": params["tab"],
        "params": params,
        "panels": panels,
    }


def _conversation_back_href(agent: str, request: Request) -> str:
    params = {key: _clean(request.query_params.get(key)) for key in DASHBOARD_PARAM_KEYS}
    params["tab"] = agent
    return _href("/", params)


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    return templates.TemplateResponse(request, "dashboard.html", _dashboard_context(request))


@app.get("/api/sessions")
async def api_sessions(
    agent: str = Query("claude"),
    q: str | None = Query(None),
    directory: str | None = Query(None),
    claude_home: str | None = Query(None),
    opencode_data_dir: str | None = Query(None),
):
    agent = _agent_or_404(agent)
    params = {
        "tab": agent,
        "claude_q": q if agent == "claude" else "",
        "claude_directory": directory if agent == "claude" else "",
        "claude_home": claude_home or "",
        "opencode_q": q if agent == "opencode" else "",
        "opencode_directory": directory if agent == "opencode" else "",
        "opencode_data_dir": opencode_data_dir or "",
    }
    return JSONResponse(content=[s.model_dump(by_alias=True) for s in _list_sessions(agent, params)])


@app.get("/api/directories")
async def api_directories(
    agent: str = Query("claude"),
    claude_home: str | None = Query(None),
    opencode_data_dir: str | None = Query(None),
):
    agent = _agent_or_404(agent)
    source_path = claude_home if agent == "claude" else opencode_data_dir
    return JSONResponse(content=_list_directories(agent, source_path=source_path))


@app.get("/conversation/{agent}/{session_id}", response_class=HTMLResponse)
async def conversation_agent(request: Request, agent: str, session_id: str):
    agent = _agent_or_404(agent)
    params = _dashboard_params(request)
    source_path = _source_path(agent, params)
    data = _load_conversation(agent, session_id, source_path=source_path)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return templates.TemplateResponse(
        request,
        "conversation.html",
        {
            "conversation": data,
            "conversation_json": data.model_dump_json().replace("</", "<\\/"),
            "source": _source_info(agent, source_path),
            "agent": agent,
            "agent_label": AGENTS[agent],
            "back_href": _conversation_back_href(agent, request),
        },
    )


@app.get("/conversation/{session_id}", response_class=HTMLResponse)
async def conversation(request: Request, session_id: str):
    return await conversation_agent(request, "claude", session_id)


@app.get("/api/conversation/{agent}/{session_id}")
async def api_conversation_agent(
    agent: str,
    session_id: str,
    claude_home: str | None = Query(None),
    opencode_data_dir: str | None = Query(None),
):
    agent = _agent_or_404(agent)
    source_path = claude_home if agent == "claude" else opencode_data_dir
    data = _load_conversation(agent, session_id, source_path=source_path)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(content=data.model_dump(mode="json"))


@app.get("/api/conversation/{session_id}")
async def api_conversation(
    session_id: str,
    claude_home: str | None = Query(None),
):
    data = _load_conversation("claude", session_id, source_path=claude_home)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(content=data.model_dump(mode="json"))
