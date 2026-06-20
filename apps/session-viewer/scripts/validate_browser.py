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
        "description": "Conversation opens in Focus without inspector UI.",
        "requiredEvidence": ["dom_assertion", "screenshot"],
    },
    "left_nav.tabs": {
        "description": "Left rail defaults to Message Navigation and provides a separate Agent Tree tab.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "reader.subagent_panels": {
        "description": "Focus layout opens, selects, scrolls, resizes, and closes subagent panels.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "focus.layout_metrics": {
        "description": "Focus layout uses golden-section width constraints and clamps divider resizing.",
        "requiredEvidence": ["dom_assertion", "interaction", "geometry"],
    },
    "graph.dom_svg": {
        "description": "Overview uses virtualized HTML/SVG rather than canvas.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.spawn_edges": {
        "description": "Parent task/tool capsules expose spawned subagent edges.",
        "requiredEvidence": ["dom_assertion", "interaction"],
    },
    "graph.multiselect": {
        "description": "Graph capsules support multiple selection.",
        "requiredEvidence": ["interaction"],
    },
    "ui.no_conversation_search": {
        "description": "Conversation search and left Problems list remain absent while dashboard search remains.",
        "requiredEvidence": ["dom_assertion"],
    },
    "ui.top_navigation": {
        "description": "Top-right navigation removes unnecessary controls and keeps Return/Forward/Copy link.",
        "requiredEvidence": ["dom_assertion"],
    },
    "nav.return_forward": {
        "description": "Return and Forward restore in-app transcript focus in both directions.",
        "requiredEvidence": ["interaction"],
    },
    "visual.studio": {
        "description": "Studio Display viewports show readable reader and graph layouts without overlap.",
        "requiredEvidence": ["screenshot", "geometry"],
    },
    "perf.large_session": {
        "description": "Large graph sessions render with bounded DOM and no browser health failures.",
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
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": is_error}],
        },
    }
    if agent_id:
        event["toolUseResult"] = {"agentId": agent_id}
    return event


def build_large_fixture(projects_dir: Path) -> str:
    project = projects_dir / "-tmp-project"
    session = "dual-layout-stress"
    subagents = project / session / "subagents"

    root_children = [f"agent-{index:03d}" for index in range(1, 19)]
    nested_children = [f"agent-{index:03d}" for index in range(19, 48)]
    deep_children = [f"agent-{index:03d}" for index in range(48, 65)]

    root_events: list[dict[str, Any]] = [user_event("root-title", session, "Dual layout stress session", index=0)]
    cursor = 1
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
                if (element.matches('button') && !element.matches('.graph-capsule') && element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible') {
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
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("reader-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.get_by_test_id("execution-graph-layout")).to_be_hidden()
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
    expect(page.locator("#readerLayoutBtn")).to_have_text("Focus")
    expect(page.locator("#graphLayoutBtn")).to_have_text("Overview")
    expect(page.locator("#returnElementBtn")).to_be_disabled()
    expect(page.locator("#forwardElementBtn")).to_be_disabled()
    expect(page.locator("#messageNavTab")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_test_id("agent-filter")).to_be_visible()
    expect(page.get_by_test_id("selected-agent-strip")).to_be_visible()
    expect(page.locator(".selected-agent-chip")).to_have_count(0)
    expect(page.get_by_test_id("message-index")).to_be_visible()
    assert_interactive_dom_health(page)
    assert page.locator("[data-testid='agent-filter-option']").count() == 65
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
    agent_filter_scrolls = page.get_by_test_id("agent-filter").evaluate("element => element.scrollWidth > element.clientWidth")
    assert agent_filter_scrolls, "message navigation agent list should be horizontally scrollable"
    selected_strip_layout = page.get_by_test_id("selected-agent-strip").evaluate(
        """element => {
            const style = getComputedStyle(element);
            return { flexWrap: style.flexWrap, overflowX: style.overflowX };
        }"""
    )
    assert selected_strip_layout["flexWrap"] == "nowrap", selected_strip_layout
    assert selected_strip_layout["overflowX"] in {"auto", "scroll"}, selected_strip_layout
    initial_metrics = focus_layout_metrics(page)
    assert_no_horizontal_overflow(page)

    record(page, "reader.default", kind="dom_assertion", flow="reader.default", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Focus layout is default and no inspector DOM is present")
    record(page, "left_nav.tabs", kind="dom_assertion", flow="reader.message_navigation", viewport=viewport, selector="[data-testid='agent-filter']", assertion="Message Navigation tab contains horizontal agent strip, empty selected-subagent strip, and message list")
    record(page, "ui.top_navigation", kind="dom_assertion", flow="top_nav.cleaned", viewport=viewport, selector="[data-testid='command-bar']", assertion="Prev, Next, First problem, timestamp, and Jump time controls are absent; Return and Forward are disabled initially")
    record(page, "ui.no_conversation_search", kind="dom_assertion", flow="conversation.removed_controls", viewport=viewport, selector="[data-testid='transcript-filter']", assertion="conversation search controls and left Problems list are absent")
    record(page, "focus.layout_metrics", kind="dom_assertion", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion=f"mainMax={initial_metrics['mainMaxWidth']:.1f}, mainMin={initial_metrics['mainMinWidth']:.1f}, layout={initial_metrics['layoutWidth']:.1f}")
    record(page, "focus.layout_metrics", kind="geometry", flow="reader.golden_ratio", viewport=viewport, selector="[data-testid='reader-layout']", assertion="Focus layout exposes golden-section main width constraints")

    if viewport == "studio-native":
        repeated_records = []
        same_subagent = page.get_by_test_id("agent-filter-option").nth(1)
        same_subagent.click()
        page.wait_for_timeout(650)
        baseline = page.evaluate(
            """() => {
                const rack = document.querySelector('.subagent-panel-rack');
                const panel = document.querySelector('.subagent-panel');
                const rackRect = rack?.getBoundingClientRect();
                const panelRect = panel?.getBoundingClientRect();
                return {
                    openPanels: document.querySelectorAll('.subagent-panel').length,
                    panelLeft: panelRect?.left || 0,
                    panelRight: panelRect?.right || 0,
                    rackLeft: rackRect?.left || 0,
                    rackRight: rackRect?.right || 0,
                    rackScrollLeft: rack?.scrollLeft || 0,
                    selectedTrackId: window.SESSION_VIEWER.current().selectedTrackId,
                    openPanelIds: window.SESSION_VIEWER.current().openPanels,
                };
            }"""
        )
        repeated_records.append(baseline)
        for _ in range(5):
            same_subagent.click()
            page.wait_for_timeout(260)
            repeated_records.append(
                page.evaluate(
                    """() => {
                        const rack = document.querySelector('.subagent-panel-rack');
                        const panel = document.querySelector('.subagent-panel');
                        const rackRect = rack?.getBoundingClientRect();
                        const panelRect = panel?.getBoundingClientRect();
                        return {
                            openPanels: document.querySelectorAll('.subagent-panel').length,
                            panelLeft: panelRect?.left || 0,
                            panelRight: panelRect?.right || 0,
                            rackLeft: rackRect?.left || 0,
                            rackRight: rackRect?.right || 0,
                            rackScrollLeft: rack?.scrollLeft || 0,
                            selectedTrackId: window.SESSION_VIEWER.current().selectedTrackId,
                            openPanelIds: window.SESSION_VIEWER.current().openPanels,
                        };
                    }"""
                )
            )
        for item in repeated_records[1:]:
            assert item["openPanels"] == 1, repeated_records
            assert item["openPanelIds"] == baseline["openPanelIds"], repeated_records
            assert abs(item["panelLeft"] - baseline["panelLeft"]) <= 0.75, repeated_records
            assert abs(item["panelRight"] - baseline["panelRight"]) <= 0.75, repeated_records
            assert abs(item["rackScrollLeft"] - baseline["rackScrollLeft"]) <= 0.75, repeated_records
        page.locator(".selected-agent-chip-close").first.click()
        expect(page.locator(".subagent-panel")).to_have_count(0)
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.repeated_same_subagent", viewport=viewport, selector="[data-testid='agent-filter-option']", assertion="repeated native-resolution clicks on the same subagent keep one panel with stable X geometry")

    if viewport == "desktop":
        page.locator("#agentTreeTab").click()
        expect(page.locator("#agentTreeTab")).to_have_attribute("aria-selected", "true")
        expect(page.get_by_test_id("subagent-node")).to_have_count(65)
        expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
        page.get_by_test_id("subagent-toggle").nth(0).click()
        expect(page.locator(".subagent-panel")).to_have_count(1)
        expect(page.locator(".selected-agent-chip")).to_have_count(1)
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_contain_text("Pinned")
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
        assert before_metrics["rackWidth"] < before_metrics["maxRackWidth"] - 20, before_metrics
        page.locator("#agentStreamSeparator").focus()
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
        expect(page.get_by_test_id("subagent-toggle").nth(0)).to_contain_text("Pin")
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
        page.locator("#messageNavTab").click()
        expect(page.locator("#messageNavTab")).to_have_attribute("aria-selected", "true")
        assert_interactive_dom_health(page)
        record(page, "left_nav.tabs", kind="interaction", flow="reader.agent_tree", viewport=viewport, selector="[data-testid='subagent-toggle']", assertion="Agent Tree tab shows hierarchical agents and toggles subagent panels")
        record(page, "reader.subagent_panels", kind="interaction", flow="reader.resize_panel", viewport=viewport, selector="#agentStreamSeparator", assertion="Focus view shows a vertical divider and keyboard/pointer resizing changes the subagent panel rack width")
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
        record(page, "nav.return_forward", kind="interaction", flow="reader.return_forward", viewport=viewport, selector="#returnElementBtn,#forwardElementBtn", assertion="Return and Forward restored transcript focus in both directions")

    screenshot = screenshot_dir / f"{viewport}-reader.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "reader.default", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Focus layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="screenshot", flow="reader.screenshot", viewport=viewport, selector="screenshot", assertion="Focus layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="reader.geometry", viewport=viewport, selector="document", assertion="Focus layout has no document-level horizontal overflow")


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


def validate_graph(page: Page, url: str, viewport: str, screenshot_dir: Path) -> None:
    graph_url = f"{url}?layout=graph"
    page.goto(graph_url, wait_until="networkidle")
    expect(page.get_by_test_id("execution-graph-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("reader-layout")).to_be_hidden()
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("canvas")).to_have_count(0)
    page.wait_for_function("document.querySelectorAll('[data-testid=graph-capsule]').length > 0")
    assert_interactive_dom_health(page)
    counts = page.evaluate("window.SESSION_VIEWER && window.SESSION_VIEWER.counts")
    assert counts["tracks"] == 65, counts
    assert counts["messages"] >= 20_000, counts
    rendered_capsules = page.locator("[data-testid='graph-capsule']").count()
    assert rendered_capsules < 5000, f"virtual graph rendered too many capsules: {rendered_capsules}"
    assert page.evaluate("document.querySelectorAll('*').length") < 6000
    assert_no_horizontal_overflow(page)

    record(page, "graph.dom_svg", kind="dom_assertion", flow="graph.open", viewport=viewport, selector="[data-testid='execution-graph']", assertion=f"DOM/SVG graph rendered {counts['messages']} logical messages without canvas")
    record(page, "perf.large_session", kind="dom_assertion", flow="graph.dom_budget", viewport=viewport, selector="[data-testid='graph-capsule']", assertion=f"virtual graph rendered {rendered_capsules} visible capsules")

    if viewport == "desktop":
        spawn = page.evaluate("window.SESSION_VIEWER.spawnEdges[0]")
        scroll_graph_to_capsule(page, spawn["sourceKey"])
        page.locator(f"[data-testid='graph-capsule'][data-capsule-key='{spawn['sourceKey']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("tool call")
        page.wait_for_function("document.querySelectorAll('.graph-edge.spawn.selected').length > 0")
        record(page, "graph.dom_svg", kind="interaction", flow="graph.click_capsule", viewport=viewport, selector="[data-testid='graph-capsule']", assertion="clicking an HTML capsule selected it")
        record(page, "graph.spawn_edges", kind="interaction", flow="graph.spawn_edge", viewport=viewport, selector="[data-testid='graph-capsule']", assertion="parent spawn capsule selected")
        record(page, "graph.spawn_edges", kind="dom_assertion", flow="graph.spawn_edge", viewport=viewport, selector=".graph-edge.spawn.selected", assertion="selected spawn capsule exposes a visible child edge")

        scroll_graph_to_capsule(page, spawn["targetKey"])
        page.locator(f"[data-testid='graph-capsule'][data-capsule-key='{spawn['targetKey']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("Subagent")

        page.locator("[data-testid='graph-capsule']").nth(0).click()
        page.locator("[data-testid='graph-capsule']").nth(1).click(modifiers=["Meta"])
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("2 transcript elements selected")
        record(page, "graph.multiselect", kind="interaction", flow="graph.multiselect", viewport=viewport, selector="[data-testid='graph-capsule']", assertion="Control-click toggled graph multi-selection")

        problem_capsule = page.evaluate("window.SESSION_VIEWER.capsules.find((item) => item.problemCount > 0)")
        assert problem_capsule, "expected a problem-bearing capsule in the fixture"
        scroll_graph_to_capsule(page, problem_capsule["key"])
        page.locator(f"[data-testid='graph-capsule'][data-capsule-key='{problem_capsule['key']}']").click()
        expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("problems")

        before_layout = page.evaluate("window.SESSION_VIEWER.current().layout")
        page.locator("#readerLayoutBtn").click()
        page.go_back()
        page.wait_for_function("(layout) => window.SESSION_VIEWER.current().layout === layout", arg=before_layout)
        record(page, "nav.return_forward", kind="interaction", flow="graph.browser_history", viewport=viewport, selector="history.state", assertion="browser back restored graph layout state")

    screenshot = screenshot_dir / f"{viewport}-graph.png"
    page.screenshot(path=screenshot, full_page=False)
    assert screenshot.stat().st_size > 1000
    record(page, "visual.studio", kind="screenshot", flow="graph.screenshot", viewport=viewport, selector="screenshot", assertion="graph layout screenshot captured", artifact=str(screenshot))
    record(page, "visual.studio", kind="geometry", flow="graph.geometry", viewport=viewport, selector="document", assertion="graph layout has no document-level horizontal overflow")


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="session-viewer-dual-"))
    screenshots = Path("/tmp/session-viewer-browser-screenshots")
    if screenshots.exists():
        shutil.rmtree(screenshots)
    screenshots.mkdir(parents=True)
    server: subprocess.Popen[bytes] | None = None
    try:
        projects_dir = temp_root / "claude-home" / "projects"
        build_large_fixture(projects_dir)
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
                    assert nodes < 6000, f"DOM node budget exceeded: {nodes}"
                    assert heap < 220_000_000, f"JS heap budget exceeded: {heap}"
                    record(
                        page,
                        "perf.large_session",
                        kind="performance",
                        flow="graph.cdp_metrics",
                        viewport=viewport,
                        selector="Performance.getMetrics",
                        assertion=f"Nodes={nodes}, JSHeapUsedSize={heap}",
                        source="cdp",
                    )
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
        if server and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
