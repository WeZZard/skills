from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.claude_store import get_source_info, list_directories, list_sessions, load_conversation
from app.config import Config


app = FastAPI(title="Claude Code Session Viewer")
app.mount("/static", StaticFiles(directory=str(Config.STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(Config.TEMPLATES_DIR))


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, q: str | None = None, directory: str | None = None):
    sessions = list_sessions(query=q, directory=directory)
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "sessions": sessions,
            "source": get_source_info(),
            "query": q or "",
            "directory": directory or "",
        },
    )


@app.get("/api/sessions")
async def api_sessions(
    q: str | None = Query(None),
    directory: str | None = Query(None),
):
    return JSONResponse(content=[s.model_dump(by_alias=True) for s in list_sessions(query=q, directory=directory)])


@app.get("/api/directories")
async def api_directories():
    return JSONResponse(content=list_directories())


@app.get("/conversation/{session_id}", response_class=HTMLResponse)
async def conversation(request: Request, session_id: str):
    data = load_conversation(session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return templates.TemplateResponse(
        request,
        "conversation.html",
        {
            "conversation": data,
            "conversation_json": data.model_dump_json().replace("</", "<\\/"),
            "source": get_source_info(),
        },
    )


@app.get("/api/conversation/{session_id}")
async def api_conversation(session_id: str):
    data = load_conversation(session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(content=data.model_dump(mode="json"))
