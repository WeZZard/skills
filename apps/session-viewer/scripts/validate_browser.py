from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time

from pathlib import Path
from typing import Any

import httpx

from playwright.sync_api import Page, expect, sync_playwright


VIEWPORTS = [
    ("studio-native", 5120, 2880, 1),
    ("studio-effective", 2560, 1440, 2),
    ("desktop", 1440, 900, 1),
    ("mobile", 390, 844, 2),
]

STORY_MANIFEST: dict[str, dict[str, Any]] = {
    "reader.default": {
        "description": "Waterfall remains available and selecting message cards does not open the floating detail UI.",
        "requiredEvidence": ["dom_assertion", "screenshot"],
    },
    "left_nav.tabs": {
        "description": "Waterfall left rail defaults to message navigation and exposes the agent tree through a single drawer button.",
        "requiredEvidence": ["dom_assertion", "interaction", "geometry"],
    },
    "reader.subagent_panels": {
        "description": "Waterfall layout opens, selects, scrolls, resizes, and closes subagent panels.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "focus.layout_metrics": {
        "description": "Waterfall layout uses golden-section width constraints and clamps divider resizing.",
        "requiredEvidence": ["dom_assertion", "interaction", "geometry"],
    },
    "graph.dom_svg": {
        "description": "Timeline is the default and uses virtualized HTML/SVG rather than canvas.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.spawn_edges": {
        "description": "Parent task/tool timeline blocks expose spawned subagent connectors.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.multiselect": {
        "description": "Timeline blocks support multiple selection.",
        "requiredEvidence": ["interaction"],
    },
    "overview.header_stability": {
        "description": "Timeline keeps a stable pinned agent header above blocks while scrolling.",
        "requiredEvidence": ["dom_assertion", "interaction", "performance"],
    },
    "overview.scroll_blocks": {
        "description": "Timeline continues to show message blocks while scrolling down and uses full type labels.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "overview.track_alignment": {
        "description": "Timeline centers limited track sets and opens overflowing track sets with the main agent visible.",
        "requiredEvidence": ["geometry"],
    },
    "overview.problem_badge": {
        "description": "Timeline problem badges render outside message box borders without being cropped.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "ui.no_conversation_search": {
        "description": "Conversation search and left Problems list remain absent while dashboard search remains.",
        "requiredEvidence": ["dom_assertion"],
    },
    "ui.top_navigation": {
        "description": "Header navigation removes unnecessary controls and keeps Sessions, Backward/Forward, path, branch, Timeline/Waterfall, and Copy link.",
        "requiredEvidence": ["dom_assertion"],
    },
    "nav.return_forward": {
        "description": "Backward and Forward restore in-app transcript focus in both directions.",
        "requiredEvidence": ["interaction"],
    },
    "visual.studio": {
        "description": "Studio Display viewports show readable reader and timeline layouts without overlap.",
        "requiredEvidence": ["screenshot", "geometry"],
    },
    "perf.large_session": {
        "description": "Large timeline sessions render with bounded DOM and no browser health failures.",
        "requiredEvidence": ["performance", "console_network", "dom_assertion"],
    },
}

ALLOWED_SOURCES = {"playwright", "cdp"}
ALLOWED_KINDS = {"dom_assertion", "interaction", "screenshot", "geometry", "performance", "console_network"}
STORY_EVIDENCE: dict[str, list[dict[str, Any]]] = {story_id: [] for story_id in STORY_MANIFEST}
RUN_METADATA: dict[str, Any] = {}


def record(
    page: Page,
    story_id: str,
    *,
    kind: str,
    flow: str,
    viewport: str = "setup",
    selector: str = "",
    assertion: str,
    source: str = "playwright",
    artifact: str | None = None,
) -> None:
    if story_id not in STORY_EVIDENCE:
        raise KeyError(story_id)
    if source not in ALLOWED_SOURCES:
        raise AssertionError(f"{story_id}: invalid source {source}")
    if kind not in ALLOWED_KINDS:
        raise AssertionError(f"{story_id}: invalid evidence kind {kind}")
    item = {
        "storyId": story_id,
        "source": source,
        "kind": kind,
        "flow": flow,
        "viewport": viewport,
        "url": page.url,
        "hash": page.evaluate("location.hash"),
        "selector": selector,
        "assertion": assertion,
        "artifact": artifact,
    }
    if item not in STORY_EVIDENCE[story_id]:
        STORY_EVIDENCE[story_id].append(item)


def write_story_report(path: Path) -> None:
    failures: list[str] = []
    for story_id, manifest in STORY_MANIFEST.items():
        evidence = STORY_EVIDENCE[story_id]
        kinds = {item["kind"] for item in evidence}
        sources = {item["source"] for item in evidence}
        missing = set(manifest["requiredEvidence"]) - kinds
        if not evidence:
            failures.append(f"{story_id}: missing browser evidence")
        if missing:
            failures.append(f"{story_id}: missing evidence kinds {sorted(missing)}")
        if not sources <= ALLOWED_SOURCES:
            failures.append(f"{story_id}: non-browser evidence source {sorted(sources)}")
        for item in evidence:
            artifact = item.get("artifact")
            if artifact and not Path(artifact).exists():
                failures.append(f"{story_id}: missing artifact {artifact}")
    report = {
        "schemaVersion": 3,
        "runMetadata": RUN_METADATA,
        "storyManifest": STORY_MANIFEST,
        "stories": [
            {
                "id": story_id,
                "description": STORY_MANIFEST[story_id]["description"],
                "requiredEvidence": STORY_MANIFEST[story_id]["requiredEvidence"],
                "evidence": STORY_EVIDENCE[story_id],
                "status": "verified" if not any(f.startswith(f"{story_id}:") for f in failures) else "missing",
            }
            for story_id in STORY_MANIFEST
        ],
        "failures": failures,
    }
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if failures:
        raise AssertionError("browser story evidence failures:\n" + "\n".join(failures))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def write_jsonl(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def user_event(uuid: str, session: str, text: str, *, index: int, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "sessionId": session,
        "agentId": agent_id,
        "isSidechain": bool(agent_id),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def assistant_tool(uuid: str, session: str, tool_id: str, agent_id: str, *, index: int, sidechain: str | None = None) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "agentId": sidechain,
        "isSidechain": bool(sidechain),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "assistant",
            "model": "claude-test",
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": "Task",
                    "input": {"description": f"Spawn {agent_id}", "subagent_type": "general"},
                }
            ],
        },
    }


def tool_result(
    uuid: str,
    session: str,
    tool_id: str,
    text: str,
    *,
    index: int,
    agent_id: str | None = None,
    sidechain: str | None = None,
    is_error: bool = False,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "user",
        "uuid": uuid,
        "sessionId": session,
        "agentId": sidechain,
        "isSidechain": bool(sidechain),
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": is_error}],
        },
    }
    if agent_id:
        event["toolUseResult"] = {"agentId": agent_id}
    return event


def attachment_event(uuid: str, session: str, *, index: int) -> dict[str, Any]:
    return {
        "type": "attachment",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}.000Z",
        "cwd": "/tmp/project",
        "gitBranch": "main",
        "attachment": {
            "type": "hook",
            "hookEventName": "SessionStart",
            "hookName": "startup",
            "exitCode": 0,
            "stdout": "startup context " * 80,
        },
    }


def build_large_fixture(projects_dir: Path) -> str:
    project = projects_dir / "-tmp-project"
    session = "dual-layout-stress"
    subagents = project / session / "subagents"

    root_children = [f"agent-{index:03d}" for index in range(1, 19)]
    nested_children = [f"agent-{index:03d}" for index in range(19, 48)]
    deep_children = [f"agent-{index:03d}" for index in range(48, 65)]

    root_events: list[dict[str, Any]] = [
        user_event("root-title", session, "Dual layout stress session", index=0),
        attachment_event("root-startup-hook", session, index=1),
    ]
    cursor = 2
    for child in root_children:
        tool_id = f"toolu_{child}"
        root_events.append(assistant_tool(f"spawn-{child}", session, tool_id, child, index=cursor))
        cursor += 1
        root_events.append(tool_result(f"result-{child}", session, tool_id, f"{child} complete", index=cursor, agent_id=child))
        cursor += 1
    while len(root_events) < 1127:
        root_events.append(user_event(f"root-{len(root_events)}", session, f"Root transcript message {len(root_events):04d}", index=len(root_events)))
    write_jsonl(project / f"{session}.jsonl", root_events)

    child_map: dict[str, list[str]] = {"agent-018": nested_children, "agent-047": deep_children}
    for index in range(1, 65):
        agent = f"agent-{index:03d}"
        events = [user_event(f"{agent}-title", session, f"Subagent {agent} goal", index=0, agent_id=agent)]
        cursor = 1
        for child in child_map.get(agent, []):
            tool_id = f"toolu_{child}"
            events.append(assistant_tool(f"spawn-{agent}-{child}", session, tool_id, child, index=cursor, sidechain=agent))
            cursor += 1
            events.append(tool_result(f"result-{agent}-{child}", session, tool_id, f"{child} complete", index=cursor, agent_id=child, sidechain=agent))
            cursor += 1
        if index in {7, 18, 47, 52}:
            error_id = f"toolu_error_{agent}"
            events.append(assistant_tool(f"err-call-{agent}", session, error_id, agent, index=cursor, sidechain=agent))
            cursor += 1
            events.append(
                tool_result(
                    f"err-result-{agent}",
                    session,
                    error_id,
                    f"Error: {agent} failed while sampling output",
                    index=cursor,
                    sidechain=agent,
                    is_error=True,
                )
            )
            cursor += 1
        while len(events) < 305:
            events.append(user_event(f"{agent}-{len(events)}", session, f"{agent} transcript message {len(events):04d}", index=len(events), agent_id=agent))
        write_jsonl(subagents / f"agent-{agent}.jsonl", events)
    return session


def build_limited_fixture(projects_dir: Path) -> str:
    project = projects_dir / "-tmp-limited-project"
    session = "centered-timeline"
    subagents = project / session / "subagents"
    root_events: list[dict[str, Any]] = [
        user_event("limited-title", session, "Centered timeline session", index=0)
    ]
    cursor = 1
    for agent in ["agent-001", "agent-002"]:
        tool_id = f"toolu_{agent}"
        root_events.append(assistant_tool(f"spawn-{agent}", session, tool_id, agent, index=cursor))
        cursor += 1
        root_events.append(tool_result(f"result-{agent}", session, tool_id, f"{agent} complete", index=cursor, agent_id=agent))
        cursor += 1
    while len(root_events) < 24:
        root_events.append(
            user_event(
                f"limited-root-{len(root_events)}",
                session,
                f"Limited main transcript message {len(root_events):02d}",
                index=len(root_events),
            )
        )
    write_jsonl(project / f"{session}.jsonl", root_events)

    for agent in ["agent-001", "agent-002"]:
        events = [
            user_event(f"{agent}-title", session, f"{agent} limited goal", index=0, agent_id=agent)
        ]
        while len(events) < 12:
            events.append(
                user_event(
                    f"{agent}-{len(events)}",
                    session,
                    f"{agent} limited transcript message {len(events):02d}",
                    index=len(events),
                    agent_id=agent,
                )
            )
        write_jsonl(subagents / f"agent-{agent}.jsonl", events)
    return session


def start_server(projects_dir: Path, port: int) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["CLAUDE_PROJECTS_DIR"] = str(projects_dir)
    return subprocess.Popen(
        ["uv", "run", "python", "-m", "app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def wait_for_server(base_url: str) -> None:
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if httpx.get(f"{base_url}/api/sessions", timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"server did not start: {base_url}")


def launch_verified_browser(playwright):
    try:
        browser = playwright.chromium.launch(channel="chrome")
        return browser, "chrome"
    except Exception:
        browser = playwright.chromium.launch()
        return browser, "chromium"


def assert_no_horizontal_overflow(page: Page) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1")
    assert not overflow, "page has horizontal document overflow"


def assert_interactive_dom_health(page: Page) -> None:
    issues = page.evaluate(
        """() => {
            const visible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const accessibleName = (element) => (
                element.getAttribute('aria-label') ||
                element.innerText ||
                element.value ||
                element.getAttribute('placeholder') ||
                element.getAttribute('title') ||
                ''
            ).replace(/\\s+/g, ' ').trim();
            const selector = (element) => {
                if (element.id) return `#${element.id}`;
                if (element.dataset?.action) return `[data-action="${element.dataset.action}"]`;
                if (element.dataset?.testid) return `[data-testid="${element.dataset.testid}"]`;
                return element.tagName.toLowerCase();
            };
            const issues = [];
            const ids = new Map();
            document.querySelectorAll('[id]').forEach((element) => {
                ids.set(element.id, (ids.get(element.id) || 0) + 1);
            });
            ids.forEach((count, id) => {
                if (count > 1) issues.push(`duplicate id #${id}`);
            });
            document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], [role="option"], [role="separator"][tabindex], [tabindex]:not([tabindex="-1"])').forEach((element) => {
                if (!visible(element)) return;
                const rect = element.getBoundingClientRect();
                if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width < 1 || rect.height < 1) {
                    issues.push(`invalid box ${selector(element)}`);
                }
                if (!accessibleName(element)) {
                    issues.push(`missing accessible name ${selector(element)}`);
                }
                if (element.matches('button') && !element.matches('.timeline-block') && element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible') {
                    issues.push(`button text overflows ${selector(element)}`);
                }
            });
            return issues;
        }"""
    )
    assert not issues, "interactive DOM health issues:\n" + "\n".join(issues)


def focus_layout_metrics(page: Page) -> dict[str, float]:
    metrics = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.layoutMetrics()")
    assert metrics and metrics["layoutWidth"] > 0, metrics
    tolerance = max(2.0, metrics["layoutWidth"] * 0.001)
    expected_max = metrics["layoutWidth"] * metrics["goldenSection"]
    expected_min = metrics["layoutWidth"] * metrics["goldenRemainder"]
    expected_stream_width = min(metrics["mainMaxWidth"], metrics["mainContentWidth"])
    expected_left = metrics["mainContentLeft"] + (metrics["mainContentWidth"] - expected_stream_width) / 2
    assert abs(metrics["mainMaxWidth"] - expected_max) <= tolerance, metrics
    assert abs(metrics["mainMinWidth"] - expected_min) <= tolerance, metrics
    assert abs(metrics["mainStreamWidth"] - expected_stream_width) <= tolerance, metrics
    assert abs(metrics["mainStreamExpectedWidth"] - expected_stream_width) <= tolerance, metrics
    assert abs(metrics["mainStreamLeft"] - expected_left) <= tolerance, metrics
    assert abs(metrics["mainStreamCenterDelta"]) <= tolerance, metrics
    assert not metrics["mainStreamClippedLeft"], metrics
    assert not metrics["mainStreamClippedRight"], metrics
    if metrics["openPanelCount"] > 0 and metrics["rackWidth"] > 0:
        assert metrics["mainContentWidth"] + tolerance >= metrics["mainMinWidth"], metrics
        assert metrics["rackFlexDirection"] == "row-reverse", metrics
    return metrics


def assert_timeline_detail_top_right(page: Page, expected_count: int | None = None) -> dict[str, Any]:
    placement = page.evaluate(
        """() => {
            const dock = document.querySelector('[data-testid="timeline-detail-dock"]');
            const viewport = document.querySelector('[data-testid="overview-timeline"]');
            const windows = Array.from(document.querySelectorAll('[data-testid="timeline-detail-panel"]'));
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            const dockRect = dock ? rect(dock) : null;
            const viewportRect = viewport ? rect(viewport) : null;
            const windowRects = windows.map(rect);
            return {
                visible: Boolean(dock && !dock.classList.contains('hidden') && windows.length),
                count: windows.length,
                dock: dockRect,
                viewport: viewportRect,
                windows: windowRects,
                firstAnchoredRight: dockRect && windowRects[0] ? Math.abs(windowRects[0].right - dockRect.right) : null,
                topDelta: dockRect && viewportRect ? Math.abs(dockRect.top - (viewportRect.top + 24)) : null,
                rightDelta: dockRect && viewportRect ? Math.abs(dockRect.right - (viewportRect.right - 24)) : null,
                secondIsLeftOfFirst: windowRects.length < 2 ? true : windowRects[1].right <= windowRects[0].left + 1,
                secondSameRow: windowRects.length < 2 ? true : Math.abs(windowRects[1].top - windowRects[0].top) <= 1.5,
            };
        }"""
    )
    assert placement["visible"], placement
    if expected_count is not None:
        assert placement["count"] == expected_count, placement
    assert placement["topDelta"] <= 3, placement
    assert placement["rightDelta"] <= 3, placement
    assert placement["firstAnchoredRight"] <= 3, placement
    assert placement["secondIsLeftOfFirst"], placement
    if placement["count"] == 2:
        assert placement["secondSameRow"], placement
    return placement


def assert_agent_sidebar_inserted(page: Page) -> dict[str, Any]:
    geometry = page.evaluate(
        """() => {
            const workbench = document.querySelector('[data-testid="conversation-workbench"]');
            const drawer = document.querySelector('[data-testid="agent-tree-drawer"]');
            const rail = document.querySelector('.left-rail');
            const transcript = document.querySelector('[data-testid="transcript-root"]');
            const firstMessageItem = document.querySelector('[data-testid="message-index"] .message-index-item');
            const firstToggle = document.querySelector('[data-testid="subagent-toggle"]');
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            return {
                workbenchState: workbench?.dataset.agentTreeOpen || '',
                drawerVisible: Boolean(drawer && !drawer.classList.contains('hidden')),
                drawerPosition: drawer ? getComputedStyle(drawer).position : '',
                drawer: drawer ? rect(drawer) : null,
                rail: rail ? rect(rail) : null,
                transcript: transcript ? rect(transcript) : null,
                navFontSize: firstMessageItem ? getComputedStyle(firstMessageItem).fontSize : '',
                previewFontSize: firstMessageItem?.querySelector('.message-preview')
                    ? getComputedStyle(firstMessageItem.querySelector('.message-preview')).fontSize
                    : '',
                toggleText: firstToggle?.innerText.trim() || '',
                toggleIconCount: firstToggle?.querySelectorAll('.agent-tree-pin-icon').length || 0,
                toggleWidth: firstToggle ? rect(firstToggle).width : 0,
            };
        }"""
    )
    assert geometry["workbenchState"] == "true", geometry
    assert geometry["drawerVisible"], geometry
    assert geometry["drawerPosition"] != "fixed", geometry
    assert geometry["drawer"]["left"] <= 1, geometry
    assert abs(geometry["drawer"]["right"] - geometry["rail"]["left"]) <= 2, geometry
    assert abs(geometry["rail"]["right"] - geometry["transcript"]["left"]) <= 2, geometry
    assert abs(geometry["drawer"]["top"] - geometry["rail"]["top"]) <= 2, geometry
    assert geometry["navFontSize"] == "12px", geometry
    assert geometry["previewFontSize"] == "12px", geometry
    assert geometry["toggleText"] == "", geometry
    assert geometry["toggleIconCount"] == 1, geometry
    assert geometry["toggleWidth"] <= 34, geometry
    return geometry


def assert_message_index_item_presentation(page: Page, require_problem: bool = False) -> dict[str, Any]:
    presentation = page.evaluate(
        """() => {
            const first = document.querySelector('[data-testid="message-index"] .message-index-item');
            const time = first?.querySelector('.message-index-time');
            const problemItem = document.querySelector('[data-testid="message-index"] .message-index-item.has-problem');
            const problem = problemItem?.querySelector('.message-index-problem');
            const dot = problem?.querySelector('.message-index-problem-dot');
            const rect = (node) => {
                const box = node.getBoundingClientRect();
                return {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height,
                };
            };
            return {
                first: first ? rect(first) : null,
                time: time ? rect(time) : null,
                timeTextAlign: time ? getComputedStyle(time).textAlign : '',
                timeJustifySelf: time ? getComputedStyle(time).justifySelf : '',
                timeRightGap: first && time ? first.getBoundingClientRect().right - time.getBoundingClientRect().right : null,
                problemExists: Boolean(problem),
                problemText: problem?.innerText.trim() || '',
                problemColor: problem ? getComputedStyle(problem).color : '',
                problemDotWidth: dot ? rect(dot).width : 0,
                problemDotColor: dot ? getComputedStyle(dot).backgroundColor : '',
                problemBoxShadow: problemItem ? getComputedStyle(problemItem).boxShadow : '',
            };
        }"""
    )
    assert presentation["first"] and presentation["time"], presentation
    assert presentation["timeTextAlign"] == "right", presentation
    assert presentation["timeJustifySelf"] == "end", presentation
    assert 0 <= presentation["timeRightGap"] <= 12, presentation
    if require_problem:
        assert presentation["problemExists"], presentation
    if presentation["problemExists"]:
        assert "problem" in presentation["problemText"], presentation
        assert presentation["problemDotWidth"] >= 5, presentation
        assert presentation["problemBoxShadow"] == "none", presentation
    return presentation


def select_problem_track_from_agent_sidebar(page: Page) -> dict[str, Any]:
    result = page.evaluate(
        """() => {
            const capsule = window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0 && !item.rawOnly);
            if (!capsule) return { clicked: false, reason: 'no-problem-capsule' };
            const selector = `[data-action="select-track"][data-track-id="${CSS.escape(capsule.trackId)}"]`;
            const button = document.querySelector(selector);
            if (!button) return { clicked: false, reason: 'missing-track-button', trackId: capsule.trackId };
            button.click();
            return {
                clicked: true,
                trackId: capsule.trackId,
                capsuleKey: capsule.key,
                problemCount: capsule.problemCount,
            };
        }"""
    )
    assert result["clicked"], result
    page.wait_for_timeout(180)
    return result


def validate_dashboard(page: Page, base_url: str) -> None:
    page.goto(base_url)
    expect(page.get_by_role("heading", name="Claude Code Sessions")).to_be_visible()
    expect(page.get_by_test_id("session-search")).to_be_visible()
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    page.get_by_test_id("session-search").fill("stress")
    page.locator(".session-search button[type='submit']").click()
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    page.get_by_test_id("session-search").fill("definitely-no-matching-session")
    page.locator(".session-search button[type='submit']").click()
    expect(page.get_by_test_id("session-empty-state")).to_be_visible()
    page.goto(base_url)
    expect(page.get_by_test_id("session-row")).to_have_count(1)
    record(
        page,
        "ui.no_conversation_search",
        kind="interaction",
        flow="dashboard.search_retained",
        selector="[data-testid='session-search']",
        assertion="dashboard search input and submit button filter and clear session results",
    )


def validate_reader(page: Page, url: str, viewport: str, screenshot_dir: Path) -> None:
    page.goto(f"{url}?layout=waterfall", wait_until="networkidle")
    expect(page.get_by_test_id("reader-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_hidden()
    expect(page.locator("button", has_text="Inspect")).to_have_count(0)
    expect(page.locator("[data-action='raw']")).to_have_count(0)
    expect(page.locator("[data-open-inspector]")).to_have_count(0)
    expect(page.locator("[data-testid='transcript-filter']")).to_have_count(0)
    expect(page.locator("[data-testid='problem-list']")).to_have_count(0)
    expect(page.locator("#prevElementBtn")).to_have_count(0)
    expect(page.locator("#nextElementBtn")).to_have_count(0)
    expect(page.locator("#firstProblemBtn")).to_have_count(0)
    expect(page.locator("#timestampJumpInput")).to_have_count(0)
    expect(page.locator("#timestampJumpBtn")).to_have_count(0)
    expect(page.locator("#readerLayoutBtn")).to_contain_text("Waterfall")
    expect(page.locator("#graphLayoutBtn")).to_contain_text("Timeline")
    expect(page.locator("#modeToggleBtn")).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_have_text("Backward")
    expect(page.locator("#returnElementBtn")).to_have_attribute("aria-label", "Backward to previous transcript element")
    expect(page.locator("#forwardElementBtn")).to_have_text("Forward")
    expect(page.locator(".header-source")).to_have_text("/tmp/project")
    expect(page.get_by_test_id("branch-chip")).to_contain_text("main")
    expect(page.get_by_test_id("breadcrumb")).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_be_disabled()
    expect(page.locator("#forwardElementBtn")).to_be_disabled()
    expect(page.locator("#messageNavTab")).to_have_count(0)
    expect(page.locator("#agentTreeTab")).to_have_count(0)
    expect(page.get_by_test_id("agent-filter")).to_have_count(0)
    expect(page.get_by_test_id("selected-agent-strip")).to_have_count(0)
    expect(page.locator(".selected-agent-chip")).to_have_count(0)
    expect(page.get_by_test_id("left-pane-header")).to_be_visible()
    expect(page.locator("#agentPaneToggle")).to_be_visible()
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
    expect(page.get_by_test_id("message-index")).to_be_visible()
    assert_message_index_item_presentation(page)
    expect(page.get_by_test_id("flow-summary")).to_have_count(0)
    expect(page.locator("#sessionInfoButton")).to_be_visible()
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    page.locator("#sessionInfoButton").click()
    expect(page.locator("#sessionInfoPopover")).to_be_visible()
    summary_text = page.locator("#sessionInfoPopover").inner_text()
    assert "Sessions" in summary_text and "Problem events" in summary_text, summary_text
    title_geometry = page.evaluate(
        """() => {
            const header = document.querySelector('[data-testid="command-bar"]').getBoundingClientRect();
            const title = document.querySelector('.session-heading h1').getBoundingClientRect();
            const info = document.querySelector('#sessionInfoButton').getBoundingClientRect();
            return {
                titleCenterDelta: title.left + title.width / 2 - (header.left + header.width / 2),
                infoAfterTitle: info.left >= title.right,
                infoGap: info.left - title.right,
            };
        }"""
    )
    assert abs(title_geometry["titleCenterDelta"]) <= 2, title_geometry
    assert title_geometry["infoAfterTitle"], title_geometry
    assert 0 <= title_geometry["infoGap"] <= 8, title_geometry
    page.keyboard.press("Escape")
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    expect(page.get_by_text("Open raw JSON for the full payload.")).to_have_count(0)
    attachment = page.locator(".reader-part.attachment").first
    expect(attachment).to_be_visible()
    expect(attachment.locator(".attachment-summary")).to_contain_text("Hook:")
    expect(attachment.locator("[data-action='toggle-raw-payload']")).to_have_text("View payload")
    attachment.locator("[data-action='toggle-raw-payload']").click()
    expect(attachment.locator("[data-raw-payload]")).to_be_visible()
    expect(attachment.locator("[data-raw-payload] pre")).to_contain_text('"attachment"')
    expect(attachment.locator("[data-action='toggle-raw-payload']")).to_have_text("Hide payload")
    attachment.locator("[data-action='toggle-raw-payload']").click()
    expect(attachment.locator("[data-raw-payload]")).to_be_hidden()
    expect(page.locator(".reader-message .message-gutter")).to_have_count(0)
    expect(page.locator(".reader-message .message-card-index").first).to_be_visible()
    left_nav_header_metrics = page.evaluate(
        """async () => {
            const header = document.querySelector('[data-testid="left-pane-header"]');
            const body = document.querySelector('.nav-body-section');
            const rect = (node) => {
                const r = node.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
            };
            const before = {
                header: rect(header),
                bodyScrollTop: body.scrollTop,
                bodyScrollHeight: body.scrollHeight,
                bodyClientHeight: body.clientHeight,
                buttonRadius: getComputedStyle(document.querySelector('#agentPaneToggle')).borderRadius,
            };
            body.scrollTop = Math.min(900, Math.max(0, body.scrollHeight - body.clientHeight));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const after = {
                header: rect(header),
                bodyScrollTop: body.scrollTop,
            };
            return { before, after };
        }"""
    )
    assert left_nav_header_metrics["before"]["bodyScrollHeight"] > left_nav_header_metrics["before"]["bodyClientHeight"], left_nav_header_metrics
    assert left_nav_header_metrics["after"]["bodyScrollTop"] > left_nav_header_metrics["before"]["bodyScrollTop"], left_nav_header_metrics
    assert abs(left_nav_header_metrics["after"]["header"]["top"] - left_nav_header_metrics["before"]["header"]["top"]) <= 1.5, left_nav_header_metrics
    assert left_nav_header_metrics["before"]["buttonRadius"].startswith("999"), left_nav_header_metrics
    card_index_geometry = page.locator(".reader-message").first.evaluate(
        """message => {
            const card = message.querySelector('.message-card');
            const header = message.querySelector('.message-header');
            const index = message.querySelector('.message-card-index');
            const messageRect = message.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const indexRect = index.getBoundingClientRect();
            return {
                leadingGap: Math.round(cardRect.left - messageRect.left),
                indexIsRightAligned: indexRect.left > headerRect.left + headerRect.width * 0.75,
                indexRightDelta: Math.round(headerRect.right - indexRect.right),
            };
        }"""
    )
    assert card_index_geometry["leadingGap"] == 0, card_index_geometry
    assert card_index_geometry["indexIsRightAligned"], card_index_geometry
    assert card_index_geometry["indexRightDelta"] >= 0, card_index_geometry
    card_before_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    page.get_by_test_id("transcript-message").nth(1).click()
    page.wait_for_timeout(200)
    card_after_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    assert card_after_key != card_before_key, (card_before_key, card_after_key)
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    assert page.locator("[data-testid='subagent-node']").count() == 65
    reader_layout_geometry = page.locator("[data-testid='conversation-workbench']").evaluate(
        """element => {
            const style = getComputedStyle(element);
            return {
                display: style.display,
                gridColumnCount: style.gridTemplateColumns === 'none' ? 0 : style.gridTemplateColumns.split(' ').length,
            };
        }"""
    )
    if reader_layout_geometry["display"] == "grid":
        assert reader_layout_geometry["gridColumnCount"] == 2, (
            f"reader grid should use two columns, saw {reader_layout_geometry}"
        )
    initial_metrics = focus_layout_metrics(page)
    assert_no_horizontal_overflow(page)

    record(page, "reader.default", kind="dom_assertion", flow="reader.waterfall", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Waterfall layout is reachable and selecting message cards does not open the floating detail panel")
    record(page, "reader.default", kind="interaction", flow="reader.attachment_payload", viewport=viewport, selector=".reader-part.attachment", assertion="Attachment events render structured summaries and lazily expand raw JSON without showing parser hint text")
    record(page, "reader.default", kind="geometry", flow="reader.message_cards", viewport=viewport, selector=".reader-message .message-card-index", assertion="message cards have no leading gutter and show the ordinal at the right edge of the title bar")
    record(page, "left_nav.tabs", kind="dom_assertion", flow="reader.message_navigation", viewport=viewport, selector="[data-testid='message-index']", assertion="Waterfall left navigation defaults to the selected agent message list with one Agents drawer button")
    record(page, "left_nav.tabs", kind="geometry", flow="reader.pinned_nav_header", viewport=viewport, selector="[data-testid='left-pane-header']", assertion="left navigation single-button pane header remained fixed while the message navigation body scrolled")
    record(page, "ui.top_navigation", kind="dom_assertion", flow="top_nav.cleaned", viewport=viewport, selector="[data-testid='command-bar']", assertion="Prev, Next, First problem, timestamp, Jump time controls, Mode, and breadcrumb stack are absent; Backward and Forward are disabled initially; project path and branch are visible")
    record(page, "ui.no_conversation_search", kind="dom_assertion", flow="conversation.removed_controls", viewport=viewport, selector="[data-testid='transcript-filter']", assertion="conversation search controls and left Problems list are absent")
    record(page, "focus.layout_metrics", kind="dom_assertion", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion=f"mainMax={initial_metrics['mainMaxWidth']:.1f}, mainMin={initial_metrics['mainMinWidth']:.1f}, layout={initial_metrics['layoutWidth']:.1f}")
    record(page, "focus.layout_metrics", kind="geometry", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Waterfall layout exposes golden-section main width constraints")

    if viewport == "studio-native":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page)
        select_problem_track_from_agent_sidebar(page)
        assert_message_index_item_presentation(page, require_problem=True)
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator("#agentPaneToggle")).to_have_attribute("aria-expanded", "true")
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(0)
        page.locator("#agentTreeDrawerClose").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.agent_drawer_toggle_native", viewport=viewport, selector="#agentPaneToggle", assertion="native-resolution agent sidebar inserted left of message navigation and toggled a subagent panel")

    if viewport == "desktop":
        page.locator("#agentPaneToggle").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
        assert_agent_sidebar_inserted(page)
        assert_message_index_item_presentation(page)
        select_problem_track_from_agent_sidebar(page)
        assert_message_index_item_presentation(page, require_problem=True)
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator(".subagent-panel .message-gutter")).to_have_count(0)
        expect(page.locator(".subagent-panel .message-card-index").first).to_be_visible()
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_text("")
        expect(page.locator("[role='treeitem'][aria-selected='true']")).to_have_count(1)
        expect(page.locator("#agentStreamSeparator")).to_be_visible()
        before_metrics = focus_layout_metrics(page)
        before_width = round(before_metrics["rackWidth"])
        assert before_metrics["mainContentWidth"] < initial_metrics["mainContentWidth"], (
            initial_metrics,
            before_metrics,
        )
        assert abs(before_metrics["mainStreamCenterDelta"]) <= 1.5, before_metrics
        assert not before_metrics["mainStreamClippedRight"], before_metrics
        assert before_metrics["rackFlexDirection"] == "row-reverse", before_metrics
        assert before_metrics["rackWidth"] <= before_metrics["maxRackWidth"] + 1.5, before_metrics
        page.locator("#agentStreamSeparator").focus()
        page.keyboard.press("End")
        page.wait_for_timeout(120)
        before_metrics = focus_layout_metrics(page)
        before_width = round(before_metrics["rackWidth"])
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(120)
        after_metrics = focus_layout_metrics(page)
        after_width = round(after_metrics["rackWidth"])
        assert after_width > before_width, (before_width, after_width)
        assert abs(after_metrics["mainStreamCenterDelta"]) <= 1.5, after_metrics
        page.keyboard.press("Home")
        page.wait_for_timeout(120)
        max_metrics = focus_layout_metrics(page)
        assert max_metrics["mainContentWidth"] + 2 >= max_metrics["mainMinWidth"], max_metrics
        assert abs(max_metrics["mainStreamCenterDelta"]) <= 1.5, max_metrics
        assert not max_metrics["mainStreamClippedRight"], max_metrics
        page.keyboard.press("ArrowLeft")
        page.wait_for_timeout(120)
        clamped_metrics = focus_layout_metrics(page)
        assert abs(clamped_metrics["rackWidth"] - max_metrics["rackWidth"]) <= 1.5, (max_metrics, clamped_metrics)
        assert abs(clamped_metrics["mainStreamWidth"] - max_metrics["mainStreamWidth"]) <= 1.5, (max_metrics, clamped_metrics)
        page.keyboard.press("End")
        page.wait_for_timeout(120)
        min_metrics = focus_layout_metrics(page)
        box = page.locator("#agentStreamSeparator").bounding_box()
        assert box, "separator should have a visible box"
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] - 180, box["y"] + box["height"] / 2)
        page.mouse.up()
        page.wait_for_timeout(120)
        drag_metrics = focus_layout_metrics(page)
        assert drag_metrics["rackWidth"] > min_metrics["rackWidth"], (min_metrics, drag_metrics)
        page.evaluate(
            """() => {
                const main = document.getElementById('mainContent');
                const panel = document.querySelector('.subagent-panel');
                main.style.scrollBehavior = 'auto';
                panel.style.scrollBehavior = 'auto';
                main.scrollTop = 520;
                panel.scrollTop = 0;
            }"""
        )
        page.wait_for_timeout(160)
        scrolls = page.evaluate(
            """() => {
                const main = document.getElementById('mainContent');
                const panel = document.querySelector('.subagent-panel');
                const afterMainSet = { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) };
                panel.scrollTop = 360;
                return new Promise((resolve) => setTimeout(() => resolve({
                    afterMainSet,
                    afterPanelSet: { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) },
                }), 120));
            }"""
        )
        assert scrolls["afterMainSet"]["main"] > 0, scrolls
        assert scrolls["afterMainSet"]["panel"] == 0, scrolls
        assert scrolls["afterPanelSet"]["panel"] > 0, scrolls
        assert scrolls["afterPanelSet"]["main"] == scrolls["afterMainSet"]["main"], scrolls
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(0)
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute("aria-pressed", "false")
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_text("")
        drawer_open_metrics = focus_layout_metrics(page)
        assert drawer_open_metrics["rackWidth"] == 0, drawer_open_metrics
        assert drawer_open_metrics["mainContentWidth"] < initial_metrics["mainContentWidth"], (
            initial_metrics,
            drawer_open_metrics,
        )
        page.locator("#agentTreeDrawerClose").click()
        expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
        closed_metrics = focus_layout_metrics(page)
        assert closed_metrics["rackWidth"] == 0, closed_metrics
        assert abs(closed_metrics["mainStreamWidth"] - initial_metrics["mainStreamWidth"]) <= 1.5, (
            initial_metrics,
            closed_metrics,
        )
        assert abs(closed_metrics["mainStreamLeft"] - initial_metrics["mainStreamLeft"]) <= 1.5, (
            initial_metrics,
            closed_metrics,
        )
        assert_interactive_dom_health(page)
        record(page, "left_nav.tabs", kind="interaction", flow="reader.agent_tree_drawer", viewport=viewport, selector="#agentPaneToggle", assertion="Agents sidebar inserts before message navigation and toggles hierarchical subagent panels")
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.resize_panel", viewport=viewport, selector="#agentStreamSeparator", assertion="Waterfall view shows a vertical divider and keyboard/pointer resizing changes the subagent panel rack width")
        record(page, "focus.layout_metrics", kind="interaction", flow="reader.resize_clamp", viewport=viewport, selector="#agentStreamSeparator", assertion="divider resizing clamps at golden-remainder main content width and preserves main stream left edge")

        page.locator(".spawn-reference").first.scroll_into_view_if_needed()
        page.locator(".spawn-reference button", has_text="Open subagent").first.click()
        assert page.locator(".subagent-panel").count() >= 1
        expect(page.get_by_test_id("subagent-panel-overlay")).to_contain_text("Subagent")
        first_pin = page.evaluate(
            """() => {
                const rack = document.querySelector('.subagent-panel-rack');
                const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                const panel = panels[panels.length - 1];
                const rackRect = rack.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                return {
                    visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                    scrollLeft: rack.scrollLeft,
                    panelSlot: panelRect.width + 14,
                };
            }"""
        )
        assert first_pin["visible"], first_pin
        rack_scroll_before = first_pin["scrollLeft"]
        page.locator(".spawn-reference button", has_text="Open subagent").nth(1).click()
        page.wait_for_timeout(420)
        second_pin = page.evaluate(
            """() => {
                const rack = document.querySelector('.subagent-panel-rack');
                const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                const panel = panels[panels.length - 1];
                const rackRect = rack.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                return {
                    visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                    scrollLeft: rack.scrollLeft,
                    panelSlot: panelRect.width + 14,
                    flexDirection: getComputedStyle(rack).flexDirection,
                    firstPanelRight: panels[0].getBoundingClientRect().right,
                    secondPanelRight: panels[1].getBoundingClientRect().right,
                };
            }"""
        )
        assert second_pin["visible"], second_pin
        assert second_pin["flexDirection"] == "row-reverse", second_pin
        assert second_pin["firstPanelRight"] > second_pin["secondPanelRight"], second_pin
        assert abs(second_pin["scrollLeft"] - rack_scroll_before) <= second_pin["panelSlot"] + 90, (
            rack_scroll_before,
            second_pin,
        )
        if page.locator(".spawn-reference button", has_text="Open subagent").count() > 2:
            preserved_scroll_before = second_pin["scrollLeft"]
            page.locator(".spawn-reference button", has_text="Open subagent").nth(2).click()
            page.wait_for_timeout(420)
            third_pin = page.evaluate(
                """() => {
                    const rack = document.querySelector('.subagent-panel-rack');
                    const panels = Array.from(document.querySelectorAll('.subagent-panel'));
                    const panel = panels[panels.length - 1];
                    const rackRect = rack.getBoundingClientRect();
                    const panelRect = panel.getBoundingClientRect();
                    return {
                        visible: panelRect.left < rackRect.right - 2 && panelRect.right > rackRect.left + 2,
                        scrollLeft: rack.scrollLeft,
                        panelSlot: panelRect.width + 14,
                    };
                }"""
            )
            assert third_pin["visible"], third_pin
            assert abs(third_pin["scrollLeft"] - preserved_scroll_before) <= third_pin["panelSlot"] + 90, (
                preserved_scroll_before,
                third_pin,
            )
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.open_panel", viewport=viewport, selector=".spawn-reference button", assertion="task reference opened a subagent panel")
        record(page, "reader.subagent_panels", kind="dom_assertion", flow="reader.open_panel", viewport=viewport, selector=".subagent-panel", assertion="subagent panel is rendered")

        page.locator(".subagent-panel .agent-panel-close").first.click()
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.close_panel", viewport=viewport, selector=".agent-panel-close", assertion="subagent panel closes")

        before = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        page.get_by_test_id("message-index").locator("[data-action='focus-message']").nth(1).click()
        after = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        assert after != before
        expect(page.locator("#returnElementBtn")).to_be_enabled()
        expect(page.locator("#forwardElementBtn")).to_be_disabled()
        page.locator("#returnElementBtn").click()
        page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=before)
        expect(page.locator("#forwardElementBtn")).to_be_enabled()
        page.locator("#forwardElementBtn").click()
        page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=after)
        record(page, "nav.return_forward", kind="interaction", flow="reader.return_forward", viewport=viewport, selector="#returnElementBtn,#forwardElementBtn", assertion="Backward and Forward restored transcript focus in both directions")

    screenshot = screenshot_dir / f"{viewport}-reader.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "reader.default", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Waterfall layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Waterfall layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="reader.geometry", viewport=viewport, selector="document", assertion="Waterfall layout has no document-level horizontal overflow")


def scroll_graph_to_capsule(page: Page, key: str) -> None:
    page.evaluate(
        """(key) => {
            const capsule = window.SESSION_VIEWER.capsules.find((item) => item.key === key);
            const viewport = document.getElementById('graphViewport');
            if (!capsule || !viewport) return;
            viewport.scrollLeft = Math.max(0, capsule.x - viewport.clientWidth * 0.35);
            viewport.scrollTop = Math.max(0, capsule.y - viewport.clientHeight * 0.35);
        }""",
        key,
    )
    page.wait_for_timeout(120)


def timeline_alignment_metrics(page: Page) -> dict[str, Any]:
    metrics = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.timelineMetrics()")
    assert metrics, metrics
    return metrics


def validate_limited_timeline_alignment(page: Page, url: str, viewport: str) -> None:
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible(timeout=20_000)
    page.wait_for_function("document.querySelectorAll('[data-testid=timeline-block]').length > 0")
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 3, counts
    metrics = timeline_alignment_metrics(page)
    tolerance = max(2.0, metrics["viewportWidth"] * 0.001)
    assert metrics["trackGroupFitsViewport"], metrics
    assert abs(metrics["trackGroupCenterDelta"]) <= tolerance, metrics
    assert metrics["viewportScrollLeft"] <= 1, metrics
    assert metrics["mainTrackVisibleInitially"], metrics
    assert_no_horizontal_overflow(page)
    record(
        page,
        "overview.track_alignment",
        kind="geometry",
        flow="timeline.limited_tracks_centered",
        viewport=viewport,
        selector="window.SESSION_VIEWER.timelineMetrics()",
        assertion=(
            f"limited tracks={counts['tracks']} span={metrics['trackSpan']:.1f} "
            f"centerDelta={metrics['trackGroupCenterDelta']:.2f}"
        ),
    )


def validate_graph(page: Page, url: str, viewport: str, screenshot_dir: Path) -> None:
    graph_url = url
    page.goto(graph_url, wait_until="networkidle")
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("reader-layout")).to_be_hidden()
    expect(page.locator(".left-rail")).to_be_hidden()
    expect(page.locator("#graphLayoutBtn")).to_contain_text("Timeline")
    expect(page.locator("#readerLayoutBtn")).to_contain_text("Waterfall")
    expect(page.locator("#modeToggleBtn")).to_have_count(0)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.locator("[data-testid='graph-capsule']")).to_have_count(0)
    page.wait_for_function("document.querySelectorAll('[data-testid=timeline-block]').length > 0")
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    rendered_blocks = page.locator("[data-testid='timeline-block']").count()
    assert rendered_blocks < 5000, f"virtual timeline rendered too many blocks: {rendered_blocks}"
    metrics = timeline_alignment_metrics(page)
    assert metrics["uniqueBlockWidths"] == [118], metrics
    assert metrics["uniqueBlockHeights"] == [26], metrics
    assert len(metrics["uniqueBlockColors"]) >= 3, metrics
    assert metrics["renderedHeaderLabels"] == counts["tracks"], metrics
    assert metrics["uniqueHeaderHeights"] == [58], metrics
    assert metrics["headerPosition"] == "sticky", metrics
    assert metrics["headerZIndex"] > metrics["blockZIndex"], metrics
    assert "90deg" not in metrics["backgroundImage"], metrics
    assert "1px" not in metrics["backgroundImage"], metrics
    assert not metrics["trackGroupFitsViewport"], metrics
    assert metrics["viewportScrollLeft"] <= 1, metrics
    assert metrics["mainTrackVisibleInitially"], metrics
    block_label_sample = page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
            .slice(0, 120)
            .map((element) => element.textContent.replace(/\\s+/g, ' ').trim())"""
    )
    assert any(label.startswith("USER ") for label in block_label_sample), block_label_sample[:20]
    assert not any(label.startswith("US ") or label.startswith("AS ") or label.startswith("TR ") for label in block_label_sample), block_label_sample[:20]
    dom_count = page.evaluate("document.querySelectorAll('*').length")
    assert dom_count < 9000, f"timeline page DOM too large: {dom_count}"
    assert_no_horizontal_overflow(page)

    record(page, "graph.dom_svg", kind="dom_assertion", flow="timeline.open", viewport=viewport, selector="[data-testid='overview-timeline']", assertion=f"default Timeline rendered {counts['messages']} logical messages without canvas and without the left rail")
    record(page, "perf.large_session", kind="dom_assertion", flow="timeline.dom_budget", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"virtual timeline rendered {rendered_blocks} visible blocks")
    record(page, "overview.header_stability", kind="dom_assertion", flow="timeline.header_dom", viewport=viewport, selector="[data-testid='timeline-header']", assertion="sticky header has equal-height labels above timeline blocks and no grid-line background")
    record(page, "overview.scroll_blocks", kind="dom_assertion", flow="timeline.block_labels", viewport=viewport, selector="[data-testid='timeline-block']", assertion="timeline blocks use full message type labels such as USER")
    record(
        page,
        "overview.track_alignment",
        kind="geometry",
        flow="timeline.overflow_initial_main_visible",
        viewport=viewport,
        selector="window.SESSION_VIEWER.timelineMetrics()",
        assertion=(
            f"overflow tracks={counts['tracks']} span={metrics['trackSpan']:.1f} "
            f"scrollLeft={metrics['viewportScrollLeft']:.1f}, main={metrics['mainTrackLeft']:.1f}-{metrics['mainTrackRight']:.1f}"
        ),
    )

    problem_badge_capsule = page.evaluate("window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)")
    assert problem_badge_capsule, "expected a problem-bearing capsule in the fixture"
    scroll_graph_to_capsule(page, problem_badge_capsule["key"])
    badge = page.evaluate(
        """() => {
            const block = document.querySelector('[data-testid="timeline-block"].has-problem');
            if (!block) return null;
            const style = getComputedStyle(block);
            const after = getComputedStyle(block, '::after');
            const rect = block.getBoundingClientRect();
            return {
                overflow: style.overflow,
                markerTop: parseFloat(after.top),
                markerRight: parseFloat(after.right),
                markerWidth: parseFloat(after.width),
                markerHeight: parseFloat(after.height),
                blockTop: rect.top,
                blockRight: rect.right,
            };
        }"""
    )
    assert badge, "expected at least one problem-bearing timeline block"
    assert badge["overflow"] == "visible", badge
    assert badge["markerTop"] < 0 and badge["markerRight"] < 0, badge
    assert badge["markerWidth"] >= 14 and badge["markerHeight"] >= 14, badge
    record(page, "overview.problem_badge", kind="dom_assertion", flow="timeline.problem_badge", viewport=viewport, selector="[data-testid='timeline-block'].has-problem", assertion="problem badge is allowed to overflow outside the message block border")

    if viewport == "studio-native":
        center_selection = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const settle = async (ms = 120) => {
                    await raf();
                    await raf();
                    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
                };
                const clickCapsule = async (target) => {
                    viewport.scrollLeft = Math.max(0, target.x - 180);
                    viewport.scrollTop = Math.max(0, target.y - 180);
                    await settle(0);
                    Array.from(document.querySelectorAll('[data-testid="timeline-block"]'))
                        .find((element) => element.dataset.capsuleKey === target.key)
                        ?.click();
                    await settle(900);
                };
                const centeredTarget = window.SESSION_VIEWER.capsules.find((item) => (
                    item.x > viewport.clientWidth * 0.62 &&
                    item.y > viewport.clientHeight * 0.65 &&
                    item.x < viewport.scrollWidth - viewport.clientWidth * 0.62 &&
                    item.y < viewport.scrollHeight - viewport.clientHeight * 0.62
                )) || window.SESSION_VIEWER.capsules[Math.floor(window.SESSION_VIEWER.capsules.length / 2)];
                await clickCapsule(centeredTarget);
                const centeredMetrics = window.SESSION_VIEWER.timelineMetrics();
                return {
                    centeredTarget: centeredTarget.key,
                    centeredDelta: centeredMetrics.currentBlockCenterDelta,
                    detailPanels: document.querySelectorAll('[data-testid="timeline-detail-panel"]').length,
                    detailDockVisible: !document.querySelector('[data-testid="timeline-detail-dock"]')?.classList.contains('hidden'),
                    statusText: document.querySelector('[data-testid="selected-capsule-summary"]')?.textContent || '',
                };
            }"""
        )
        assert center_selection["centeredDelta"], center_selection
        assert abs(center_selection["centeredDelta"]["x"]) <= 8, center_selection
        assert abs(center_selection["centeredDelta"]["y"]) <= 8, center_selection
        assert center_selection["detailPanels"] >= 1, center_selection
        assert center_selection["detailDockVisible"], center_selection
        assert center_selection["statusText"], center_selection
        assert_timeline_detail_top_right(page)
        record(page, "graph.dom_svg", kind="interaction", flow="timeline.center_select_with_detail", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"focused block centered with delta {center_selection['centeredDelta']} and the Timeline detail dock stayed visible")

        down_scroll = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const counts = [];
                const samples = [];
                const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
                const visibleCount = () => {
                    const viewportRect = viewport.getBoundingClientRect();
                    const blocks = Array.from(document.querySelectorAll('[data-testid="timeline-block"]'));
                    const visible = blocks.filter((block) => {
                        const rect = block.getBoundingClientRect();
                        return rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom && rect.right >= viewportRect.left && rect.left <= viewportRect.right;
                    });
                    return {
                        scrollTop: viewport.scrollTop,
                        visible: visible.length,
                        sample: visible.slice(0, 8).map((block) => block.textContent.replace(/\\s+/g, ' ').trim()),
                    };
                };
                for (const fraction of [0.18, 0.42, 0.68, 0.88]) {
                    viewport.scrollLeft = 0;
                    viewport.scrollTop = maxTop * fraction;
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const result = visibleCount();
                    counts.push(result.visible);
                    samples.push(result.sample);
                }
                return { counts, samples };
            }"""
        )
        assert all(count > 0 for count in down_scroll["counts"]), down_scroll
        assert not any(label.startswith("US ") or label.startswith("AS ") or label.startswith("TR ") for sample in down_scroll["samples"] for label in sample), down_scroll
        record(page, "overview.scroll_blocks", kind="interaction", flow="timeline.down_scroll_blocks", viewport=viewport, selector="[data-testid='timeline-block']", assertion=f"visible block counts after down-scroll: {down_scroll['counts']}")
        record(page, "overview.problem_badge", kind="interaction", flow="timeline.problem_badge_native", viewport=viewport, selector="[data-testid='timeline-block'].has-problem", assertion="problem badge geometry verified at native resolution")

        stability = page.evaluate(
            """async () => {
                const viewport = document.getElementById('graphViewport');
                const label = document.querySelector('[data-testid="timeline-track-label"]');
                const before = window.SESSION_VIEWER.timelineMetrics();
                const tops = [];
                const lefts = [];
                const start = performance.now();
                for (let index = 0; index < 28; index += 1) {
                    viewport.scrollTop += Math.max(220, Math.floor(viewport.clientHeight * 0.18));
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const rect = label.getBoundingClientRect();
                    tops.push(rect.top);
                    lefts.push(rect.left);
                }
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const after = window.SESSION_VIEWER.timelineMetrics();
                return {
                    before,
                    after,
                    topRange: Math.max(...tops) - Math.min(...tops),
                    leftRange: Math.max(...lefts) - Math.min(...lefts),
                    elapsedMs: performance.now() - start,
                };
            }"""
        )
        assert stability["topRange"] <= 1.5, stability
        assert stability["leftRange"] <= 1.5, stability
        assert stability["after"]["renderCounts"]["header"] == stability["before"]["renderCounts"]["header"], stability
        assert stability["after"]["renderCounts"]["detail"] == stability["before"]["renderCounts"]["detail"], stability
        assert stability["elapsedMs"] < 2500, stability
        record(page, "overview.header_stability", kind="interaction", flow="timeline.header_scroll", viewport=viewport, selector="[data-testid='timeline-track-label']", assertion=f"header top range {stability['topRange']:.2f}px during multi-screen native scroll")
        record(page, "overview.header_stability", kind="performance", flow="timeline.header_scroll", viewport=viewport, selector="window.SESSION_VIEWER.timelineMetrics()", assertion=f"header rerenders stayed at {stability['after']['renderCounts']['header']} over {stability['elapsedMs']:.1f}ms scroll sample")

    if viewport == "mobile":
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

    if viewport == "desktop":
        spawn = page.evaluate("window.SESSION_VIEWER.spawnEdges[0]")
        scroll_graph_to_capsule(page, spawn["sourceKey"])
        before_width = page.get_by_test_id("overview-timeline").evaluate("node => node.clientWidth")
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{spawn['sourceKey']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("tool call")
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)
        after_width = page.get_by_test_id("overview-timeline").evaluate("node => node.clientWidth")
        assert after_width == before_width, (before_width, after_width)
        page.wait_for_function("document.querySelectorAll('.timeline-connector.spawn.selected').length > 0")
        record(page, "graph.dom_svg", kind="interaction", flow="timeline.click_block", viewport=viewport, selector="[data-testid='timeline-block']", assertion="clicking an HTML timeline block selected it and kept a floating detail panel visible")
        record(page, "graph.spawn_edges", kind="interaction", flow="timeline.spawn_connector", viewport=viewport, selector="[data-testid='timeline-block']", assertion="parent spawn block selected")
        record(page, "graph.spawn_edges", kind="dom_assertion", flow="timeline.spawn_connector", viewport=viewport, selector=".timeline-connector.spawn.selected", assertion="selected spawn block exposes a visible child connector")

        scroll_graph_to_capsule(page, spawn["targetKey"])
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{spawn['targetKey']}']").click()
        expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
        assert_timeline_detail_top_right(page, expected_count=1)

        page.locator("[data-testid='timeline-block']").nth(0).click()
        page.locator("[data-testid='timeline-block']").nth(1).click(modifiers=["Meta"])
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("2 transcript elements selected")
        expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(2)
        assert_timeline_detail_top_right(page, expected_count=2)
        record(page, "graph.multiselect", kind="interaction", flow="timeline.multiselect", viewport=viewport, selector="[data-testid='timeline-block']", assertion="Control-click toggled timeline multi-selection")

        problem_capsule = page.evaluate("window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)")
        assert problem_capsule, "expected a problem-bearing capsule in the fixture"
        scroll_graph_to_capsule(page, problem_capsule["key"])
        page.locator(f"[data-testid='timeline-block'][data-capsule-key='{problem_capsule['key']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("problems")

        before_layout = page.evaluate("window.SESSION_VIEWER.current().layout")
        page.locator("#readerLayoutBtn").click()
        page.go_back()
        page.wait_for_function("(layout) => window.SESSION_VIEWER.current().layout === layout", arg=before_layout)
        record(page, "nav.return_forward", kind="interaction", flow="timeline.browser_history", viewport=viewport, selector="history.state", assertion="browser back restored timeline layout state")

    screenshot = screenshot_dir / f"{viewport}-timeline.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "visual.studio", kind="screenshot", flow="timeline.screenshot", viewport=viewport, selector="screenshot", assertion="timeline layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="timeline.geometry", viewport=viewport, selector="document", assertion="timeline layout has no document-level horizontal overflow")


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="session-viewer-dual-"))
    screenshots = Path("/tmp/session-viewer-browser-screenshots")
    if screenshots.exists():
        shutil.rmtree(screenshots)
    screenshots.mkdir(parents=True)
    server: subprocess.Popen[bytes] | None = None
    limited_server: subprocess.Popen[bytes] | None = None
    try:
        projects_dir = temp_root / "claude-home" / "projects"
        limited_projects_dir = temp_root / "limited-home" / "projects"
        build_large_fixture(projects_dir)
        build_limited_fixture(limited_projects_dir)
        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        server = start_server(projects_dir, port)
        wait_for_server(base_url)
        sessions = httpx.get(f"{base_url}/api/sessions", timeout=10).json()
        assert len(sessions) == 1
        url = f"{base_url}/conversation/{sessions[0]['id']}"

        console_errors: list[str] = []
        network_failures: list[str] = []
        with sync_playwright() as playwright:
            browser, browser_channel = launch_verified_browser(playwright)
            page = browser.new_page()
            RUN_METADATA.update(
                {
                    "browserChannel": browser_channel,
                    "browserVersion": browser.version,
                    "userAgent": page.evaluate("navigator.userAgent"),
                }
            )
            page.add_init_script(
                "localStorage.setItem('sessionViewerSubagentPanelRackWidth', '999999');"
            )
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda exc: console_errors.append(str(exc)))
            page.on("requestfailed", lambda request: network_failures.append(request.url))
            validate_dashboard(page, base_url)
            for viewport, width, height, dpr in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                page.emulate_media(color_scheme="light")
                validate_reader(page, url, viewport, screenshots)
                validate_graph(page, url, viewport, screenshots)
                if viewport == "studio-native":
                    cdp = page.context.new_cdp_session(page)
                    cdp.send("Performance.enable")
                    metrics = {item["name"]: item["value"] for item in cdp.send("Performance.getMetrics")["metrics"]}
                    nodes = page.evaluate("document.querySelectorAll('*').length")
                    heap = metrics.get("JSHeapUsedSize", 0)
                    assert nodes < 9000, f"DOM node budget exceeded: {nodes}"
                    assert heap < 220_000_000, f"JS heap budget exceeded: {heap}"
                    record(
                        page,
                        "perf.large_session",
                        kind="performance",
                        flow="timeline.cdp_metrics",
                        viewport=viewport,
                        selector="Performance.getMetrics",
                        assertion=f"Nodes={nodes}, JSHeapUsedSize={heap}",
                        source="cdp",
                    )
            limited_port = free_port()
            limited_base_url = f"http://127.0.0.1:{limited_port}"
            limited_server = start_server(limited_projects_dir, limited_port)
            wait_for_server(limited_base_url)
            limited_sessions = httpx.get(f"{limited_base_url}/api/sessions", timeout=10).json()
            assert len(limited_sessions) == 1
            limited_url = f"{limited_base_url}/conversation/{limited_sessions[0]['id']}"
            for viewport, width, height, _dpr in [
                item for item in VIEWPORTS if item[0] in {"studio-native", "desktop"}
            ]:
                page.set_viewport_size({"width": width, "height": height})
                page.emulate_media(color_scheme="light")
                validate_limited_timeline_alignment(page, limited_url, viewport)
            assert not console_errors, "browser console/page errors:\n" + "\n".join(console_errors)
            assert not network_failures, "browser network failures:\n" + "\n".join(network_failures)
            record(page, "perf.large_session", kind="console_network", flow="browser_health", selector="console/network", assertion="zero console errors and zero failed network requests")
            write_story_report(screenshots / "story-verification.json")
            browser.close()
        print(
            "Browser validation passed. "
            f"Browser: {RUN_METADATA.get('browserChannel')} {RUN_METADATA.get('browserVersion')}. "
            f"Screenshots: {screenshots}"
        )
        return 0
    finally:
        if limited_server and limited_server.poll() is None:
            limited_server.terminate()
            try:
                limited_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                limited_server.kill()
        if server and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
