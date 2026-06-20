from __future__ import annotations

import argparse
import os

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Claude Code session viewer.")
    parser.add_argument("--claude-home", help="Claude Code home directory, default ~/.claude")
    parser.add_argument("--projects-dir", help="Direct path to Claude Code projects directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    if args.claude_home:
        os.environ["CLAUDE_CODE_HOME"] = args.claude_home
    if args.projects_dir:
        os.environ["CLAUDE_PROJECTS_DIR"] = args.projects_dir

    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
