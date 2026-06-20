from __future__ import annotations

import json
import shutil
import subprocess
import tempfile

from pathlib import Path
from typing import Any

from playwright.sync_api import Page, expect, sync_playwright

from validate_browser import build_large_fixture, focus_layout_metrics, free_port, launch_verified_browser, start_server, wait_for_server


VIEWPORT = {"width": 5120, "height": 2880}
ARTIFACT_DIR = Path("/tmp/session-viewer-reference-workflow")


def state(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
            const q = (selector) => document.querySelector(selector);
            const qa = (selector) => Array.from(document.querySelectorAll(selector));
            return {
                url: location.href,
                layout: window.SESSION_VIEWER?.current().layout || '',
                capsuleKey: window.SESSION_VIEWER?.current().capsuleKey || '',
                backCount: window.SESSION_VIEWER?.current().backCount || 0,
                forwardCount: window.SESSION_VIEWER?.current().forwardCount || 0,
                leftNavTab: window.SESSION_VIEWER?.current().leftNavTab || '',
                readerVisible: !!q('[data-testid="reader-layout"]:not(.hidden)'),
                graphVisible: !!q('[data-testid="execution-graph-layout"]:not(.hidden)'),
                hasInspector: !!q('[data-testid="raw-json-panel"]'),
                agentOptions: qa('[data-testid="agent-filter-option"]').length,
                treeNodes: qa('[data-testid="subagent-node"]').length,
                treeToggles: qa('[data-testid="subagent-toggle"]').length,
                selectedChips: qa('.selected-agent-chip').length,
                openPanels: qa('.subagent-panel').length,
                activeMessages: qa('.reader-message.active').length,
                graphCapsules: qa('[data-testid="graph-capsule"]').length,
                linkStatus: q('#linkStatus')?.textContent || '',
                commandText: q('[data-testid="command-bar"]')?.innerText.replace(/\\s+/g, ' ').trim() || '',
            };
        }"""
    )


def record(history: list[dict[str, Any]], page: Page, action: str, selector: str, before: dict[str, Any] | None = None) -> None:
    history.append(
        {
            "action": action,
            "selector": selector,
            "before": before,
            "after": state(page),
        }
    )


def interactive_inventory(page: Page) -> list[dict[str, Any]]:
    return page.evaluate(
        """() => {
            const visible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            const name = (element) => (
                element.innerText ||
                element.getAttribute('aria-label') ||
                element.getAttribute('title') ||
                element.value ||
                ''
            ).replace(/\\s+/g, ' ').trim();
            const selector = (element) => {
                if (element.id) return `#${element.id}`;
                const classes = Array.from(element.classList || []).slice(0, 3).join('.');
                return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
            };
            return Array.from(document.querySelectorAll('a[href], button, input, select, textarea, summary, [onclick], [role="button"], [role="option"], [role="separator"][tabindex], [tabindex]:not([tabindex="-1"])'))
                .filter(visible)
                .map((element, index) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        index,
                        selector: selector(element),
                        tag: element.tagName.toLowerCase(),
                        type: element.getAttribute('type') || '',
                        role: element.getAttribute('role') || '',
                        name: name(element).slice(0, 160),
                        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
                        classes: Array.from(element.classList || []),
                        dataset: {...element.dataset},
                        box: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height),
                        },
                    };
                });
        }"""
    )


def click_and_record(history: list[dict[str, Any]], page: Page, action: str, selector: str) -> None:
    before = state(page)
    page.locator(selector).first.click()
    page.wait_for_timeout(250)
    record(history, page, action, selector, before)


def validate_reference_plan(page: Page, url: str) -> dict[str, Any]:
    history: list[dict[str, Any]] = []
    page.goto(url, wait_until="networkidle")
    expect(page.get_by_test_id("reader-layout")).to_be_visible(timeout=20_000)
    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("button", has_text="Inspect")).to_have_count(0)
    expect(page.locator("[data-action='raw']")).to_have_count(0)
    initial_metrics = focus_layout_metrics(page)
    page.screenshot(path=ARTIFACT_DIR / "session-viewer-reference-plan-initial.png", full_page=False)
    initial_inventory = interactive_inventory(page)
    record(history, page, "Initial Studio native inventory", "document")

    for selector in ["#readerLayoutBtn", "#graphLayoutBtn", "#returnElementBtn", "#forwardElementBtn", "#copyLinkBtn"]:
        expect(page.locator(selector)).to_be_visible()
    expect(page.locator("#readerLayoutBtn")).to_have_text("Focus")
    expect(page.locator("#graphLayoutBtn")).to_have_text("Overview")
    for selector in ["#prevElementBtn", "#nextElementBtn", "#firstProblemBtn", "#timestampJumpInput", "#timestampJumpBtn"]:
        expect(page.locator(selector)).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_be_disabled()
    expect(page.locator("#forwardElementBtn")).to_be_disabled()
    record(history, page, "Verify preserved top-right navigation", "[data-testid='command-bar']")

    click_and_record(history, page, "Copy current link", "#copyLinkBtn")
    expect(page.locator("#linkStatus")).to_contain_text("Copied")

    expect(page.get_by_test_id("agent-filter")).to_be_visible()
    expect(page.get_by_test_id("selected-agent-strip")).to_be_visible()
    expect(page.locator(".selected-agent-chip")).to_have_count(0)
    expect(page.get_by_test_id("message-index")).to_be_visible()
    assert page.locator("[data-testid='agent-filter-option']").count() == 65
    assert page.get_by_test_id("agent-filter").evaluate("node => node.scrollWidth > node.clientWidth")
    record(history, page, "Verify Message Navigation tab structure", "[data-testid='agent-filter']")

    repeated_records = []
    same_subagent = page.get_by_test_id("agent-filter-option").nth(1)
    same_subagent.click()
    page.wait_for_timeout(650)
    baseline = page.evaluate(
        """() => {
            const rack = document.querySelector('.subagent-panel-rack');
            const panel = document.querySelector('.subagent-panel');
            const panelRect = panel?.getBoundingClientRect();
            return {
                openPanels: document.querySelectorAll('.subagent-panel').length,
                panelLeft: panelRect?.left || 0,
                panelRight: panelRect?.right || 0,
                rackScrollLeft: rack?.scrollLeft || 0,
                selectedTrackId: window.SESSION_VIEWER.current().selectedTrackId,
                openPanelIds: window.SESSION_VIEWER.current().openPanels,
            };
        }"""
    )
    repeated_records.append(baseline)
    for _ in range(5):
        before_repeat = state(page)
        same_subagent.click()
        page.wait_for_timeout(260)
        record(history, page, "Repeatedly click same subagent", "[data-testid='agent-filter-option']:nth-child(2)", before_repeat)
        repeated_records.append(
            page.evaluate(
                """() => {
                    const rack = document.querySelector('.subagent-panel-rack');
                    const panel = document.querySelector('.subagent-panel');
                    const panelRect = panel?.getBoundingClientRect();
                    return {
                        openPanels: document.querySelectorAll('.subagent-panel').length,
                        panelLeft: panelRect?.left || 0,
                        panelRight: panelRect?.right || 0,
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
    click_and_record(history, page, "Close repeated-click subagent", ".selected-agent-chip-close")
    expect(page.locator(".subagent-panel")).to_have_count(0)

    click_and_record(history, page, "Select first subagent in horizontal agent list", "[data-testid='agent-filter-option']:nth-child(2)")
    expect(page.locator(".subagent-panel")).to_have_count(1)
    expect(page.locator(".selected-agent-chip")).to_have_count(1)
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
    page.keyboard.press("Home")
    page.wait_for_timeout(120)
    max_metrics = focus_layout_metrics(page)
    assert abs(max_metrics["mainStreamCenterDelta"]) <= 1.5, max_metrics
    assert not max_metrics["mainStreamClippedRight"], max_metrics
    page.keyboard.press("ArrowLeft")
    page.wait_for_timeout(120)
    clamped_metrics = focus_layout_metrics(page)
    assert abs(clamped_metrics["rackWidth"] - max_metrics["rackWidth"]) <= 1.5, (max_metrics, clamped_metrics)
    record(history, page, "Resize subagent panel rack with vertical divider", "#agentStreamSeparator")

    click_and_record(history, page, "Close subagent from selected-agent strip", ".selected-agent-chip-close")
    expect(page.locator(".subagent-panel")).to_have_count(0)
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

    page.locator("#agentTreeTab").click()
    expect(page.locator("#agentTreeTab")).to_have_attribute("aria-selected", "true")
    expect(page.get_by_test_id("subagent-node")).to_have_count(65)
    expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
    click_and_record(history, page, "Open subagent from Agent Tree toggle", "[data-testid='subagent-toggle']")
    expect(page.locator(".subagent-panel")).to_have_count(1)
    expect(page.get_by_test_id("subagent-toggle").first).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_test_id("subagent-toggle").first).to_contain_text("Pinned")
    expect(page.locator("[role='treeitem'][aria-selected='true']")).to_have_count(1)
    page.evaluate(
        """() => {
            const main = document.getElementById('mainContent');
            const panel = document.querySelector('.subagent-panel');
            main.style.scrollBehavior = 'auto';
            panel.style.scrollBehavior = 'auto';
            main.scrollTop = 640;
            panel.scrollTop = 0;
        }"""
    )
    page.wait_for_timeout(160)
    scrolls = page.evaluate(
        """() => {
            const main = document.getElementById('mainContent');
            const panel = document.querySelector('.subagent-panel');
            const afterMainSet = { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) };
            panel.scrollTop = 420;
            return new Promise((resolve) => setTimeout(() => resolve({
                afterMainSet,
                afterPanelSet: { main: Math.round(main.scrollTop), panel: Math.round(panel.scrollTop) },
            }), 120));
        }"""
    )
    assert scrolls["afterMainSet"]["panel"] == 0, scrolls
    assert scrolls["afterPanelSet"]["main"] == scrolls["afterMainSet"]["main"], scrolls
    record(history, page, "Verify independent subagent scroll", ".subagent-panel")
    click_and_record(history, page, "Close subagent from Agent Tree toggle", "[data-testid='subagent-toggle']")
    expect(page.locator(".subagent-panel")).to_have_count(0)
    expect(page.get_by_test_id("subagent-toggle").first).to_contain_text("Pin")
    page.locator("#messageNavTab").click()

    before_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    click_and_record(history, page, "Focus message from message index", "[data-testid='message-index'] [data-action='focus-message']:nth-child(2)")
    after_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    assert after_key != before_key
    expect(page.locator("#returnElementBtn")).to_be_enabled()
    page.locator("#returnElementBtn").click()
    page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=before_key)
    record(history, page, "Return to previous transcript focus", "#returnElementBtn")
    expect(page.locator("#forwardElementBtn")).to_be_enabled()
    page.locator("#forwardElementBtn").click()
    page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=after_key)
    record(history, page, "Forward to returned transcript focus", "#forwardElementBtn")

    expect(page.get_by_test_id("raw-json-panel")).to_have_count(0)
    expect(page.locator("button", has_text="Inspect")).to_have_count(0)
    expect(page.locator("[data-action='raw']")).to_have_count(0)
    record(history, page, "Verify inspector and raw controls are absent", "document")

    if page.locator(".reader-part [data-action='focus-capsule']").count():
        paired_before = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        click_and_record(history, page, "Navigate paired part Call/Result", ".reader-part [data-action='focus-capsule']")
        paired_after = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
        assert paired_after != paired_before

    if page.locator(".spawn-reference [data-action='open-panel']").count():
        click_and_record(history, page, "Open subagent panel from task reference", ".spawn-reference [data-action='open-panel']")
        assert page.locator(".subagent-panel").count() >= 1
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
        if page.locator(".spawn-reference [data-action='open-panel']").count() > 1:
            rack_scroll_before = first_pin["scrollLeft"]
            before_second_open = state(page)
            page.locator(".spawn-reference [data-action='open-panel']").nth(1).click()
            page.wait_for_timeout(420)
            record(history, page, "Open another subagent with relative rack pinning", ".spawn-reference [data-action='open-panel'] >> nth=1", before_second_open)
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
        if page.locator(".spawn-reference [data-action='open-panel']").count() > 2:
            preserved_scroll_before = page.locator(".subagent-panel-rack").evaluate("element => element.scrollLeft")
            before_third_open = state(page)
            page.locator(".spawn-reference [data-action='open-panel']").nth(2).click()
            page.wait_for_timeout(420)
            record(history, page, "Pin latest panel from current rack scroll", ".spawn-reference [data-action='open-panel'] >> nth=2", before_third_open)
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
        child_target = page.locator(".spawn-reference [data-action='focus-capsule']").first.get_attribute("data-capsule-key")
        click_and_record(history, page, "Jump to first child message from task reference", ".spawn-reference [data-action='focus-capsule']")
        if child_target:
            page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=child_target)

    if page.locator(".agent-connector-node.parent").count():
        click_and_record(history, page, "Use connector parent message control", ".agent-connector-node.parent")
    if page.locator(".agent-connector-node.first").count():
        click_and_record(history, page, "Use connector first message control", ".agent-connector-node.first")
    if page.locator(".agent-connector-node.result").count():
        click_and_record(history, page, "Use connector result control", ".agent-connector-node.result")

    click_and_record(history, page, "Switch to Overview", "#graphLayoutBtn")
    expect(page.get_by_test_id("execution-graph-layout")).to_be_visible()
    expect(page.locator("canvas")).to_have_count(0)
    page.wait_for_function("document.querySelectorAll('[data-testid=graph-capsule]').length > 0")
    assert page.locator("[data-testid='graph-capsule']").count() < 5000
    page.locator("[data-testid='graph-capsule']").nth(0).click()
    page.locator("[data-testid='graph-capsule']").nth(1).click(modifiers=["Meta"])
    expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("2 transcript elements selected")
    record(history, page, "Multiselect graph capsules", "[data-testid='graph-capsule']")

    assert page.evaluate("window.SESSION_VIEWER.spawnEdges.length") > 0
    assert page.locator(".graph-edge.spawn").count() > 0
    record(history, page, "Verify visible graph spawn edges at native resolution", ".graph-edge.spawn")

    click_and_record(history, page, "Return to Focus after Overview use", "#readerLayoutBtn")
    expect(page.get_by_test_id("reader-layout")).to_be_visible()
    expect(page.locator("#graphLayoutBtn")).to_be_visible()
    expect(page.locator("#returnElementBtn")).to_be_visible()
    expect(page.locator("#forwardElementBtn")).to_be_visible()
    page.screenshot(path=ARTIFACT_DIR / "session-viewer-reference-plan-final.png", full_page=False)

    return {
        "schemaVersion": 1,
        "sourcePlan": "apps/session-viewer/docs/reference-interaction-test-plan.md",
        "viewport": VIEWPORT,
        "browser": page.evaluate(
            """() => ({
                userAgent: navigator.userAgent,
                platform: navigator.platform,
            })"""
        ),
        "initialInteractiveCount": len(initial_inventory),
        "initialInteractiveInventory": initial_inventory,
        "operationHistory": history,
        "finalState": state(page),
        "status": "verified",
    }


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix="session-viewer-reference-plan-"))
    server = None
    try:
        projects_dir = temp_root / "claude-home" / "projects"
        build_large_fixture(projects_dir)
        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        server = start_server(projects_dir, port)
        wait_for_server(base_url)

        with sync_playwright() as playwright:
            browser, browser_channel = launch_verified_browser(playwright)
            context = browser.new_context(viewport=VIEWPORT, device_scale_factor=1)
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base_url)
            page = context.new_page()
            page.add_init_script(
                """
                localStorage.setItem('sessionViewerSubagentPanelRackWidth', '999999');
                Object.defineProperty(navigator, 'clipboard', {
                  value: {
                    text: '',
                    writeText(value) { this.text = value; return Promise.resolve(); },
                    readText() { return Promise.resolve(this.text || ''); },
                  },
                  configurable: true,
                });
                """
            )
            sessions = page.request.get(f"{base_url}/api/sessions").json()
            assert len(sessions) == 1
            report = validate_reference_plan(page, f"{base_url}/conversation/{sessions[0]['id']}")
            report["browser"]["channel"] = browser_channel
            report["browser"]["version"] = browser.version
            (ARTIFACT_DIR / "session-viewer-reference-plan-report.json").write_text(
                json.dumps(report, indent=2),
                encoding="utf-8",
            )
            browser.close()
        print(
            "Reference interaction plan validation passed. "
            f"Browser: {report['browser']['channel']} {report['browser']['version']}. "
            f"Artifacts: {ARTIFACT_DIR}"
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
