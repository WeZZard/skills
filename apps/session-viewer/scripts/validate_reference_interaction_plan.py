from __future__ import annotations

import json
import shutil
import subprocess
import tempfile

from pathlib import Path
from typing import Any

from playwright.sync_api import Page, expect, sync_playwright

from validate_browser import (
    assert_agent_sidebar_inserted,
    assert_message_index_item_presentation,
    assert_timeline_detail_top_right,
    build_large_fixture,
    focus_layout_metrics,
    free_port,
    launch_verified_browser,
    select_problem_track_from_agent_sidebar,
    start_server,
    wait_for_server,
)


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
                graphVisible: !!q('[data-testid="overview-timeline-layout"]:not(.hidden)'),
                hasInspector: !!q('[data-testid="raw-json-panel"]'),
                agentOptions: qa('[data-testid="agent-filter-option"]').length,
                agentDrawerVisible: !!q('[data-testid="agent-tree-drawer"]:not(.hidden)'),
                agentDrawerExpanded: q('#agentPaneToggle')?.getAttribute('aria-expanded') || '',
                infoPopoverVisible: !!q('#sessionInfoPopover:not(.hidden)'),
                treeNodes: qa('[data-testid="subagent-node"]').length,
                treeToggles: qa('[data-testid="subagent-toggle"]').length,
                selectedChips: qa('.selected-agent-chip').length,
                openPanels: qa('.subagent-panel').length,
                activeMessages: qa('.reader-message.active').length,
                graphCapsules: qa('[data-testid="timeline-block"]').length,
                detailPanels: qa('[data-testid="timeline-detail-panel"]').length,
                detailPins: qa('[data-testid="timeline-detail-pin"]').length,
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
    page.goto(f"{url}?layout=waterfall", wait_until="networkidle")
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
    expect(page.locator("#readerLayoutBtn")).to_contain_text("Waterfall")
    expect(page.locator("#graphLayoutBtn")).to_contain_text("Timeline")
    expect(page.locator("#modeToggleBtn")).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_have_text("Backward")
    expect(page.locator("#returnElementBtn")).to_have_attribute("aria-label", "Backward to previous transcript element")
    expect(page.locator("#forwardElementBtn")).to_have_text("Forward")
    expect(page.locator(".header-source")).to_have_text("/tmp/project")
    expect(page.get_by_test_id("branch-chip")).to_contain_text("main")
    expect(page.get_by_test_id("breadcrumb")).to_have_count(0)
    for selector in ["#prevElementBtn", "#nextElementBtn", "#firstProblemBtn", "#timestampJumpInput", "#timestampJumpBtn"]:
        expect(page.locator(selector)).to_have_count(0)
    expect(page.locator("#returnElementBtn")).to_be_disabled()
    expect(page.locator("#forwardElementBtn")).to_be_disabled()
    expect(page.locator("#messageNavTab")).to_have_count(0)
    expect(page.locator("#agentTreeTab")).to_have_count(0)
    expect(page.get_by_test_id("flow-summary")).to_have_count(0)
    expect(page.get_by_test_id("agent-filter")).to_have_count(0)
    expect(page.get_by_test_id("selected-agent-strip")).to_have_count(0)
    expect(page.locator(".selected-agent-chip")).to_have_count(0)
    expect(page.get_by_test_id("left-pane-header")).to_be_visible()
    expect(page.locator("#agentPaneToggle")).to_be_visible()
    expect(page.locator("#agentPaneToggle")).to_have_attribute("aria-expanded", "false")
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
    expect(page.locator("#sessionInfoButton")).to_be_visible()
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    title_info_metrics = page.evaluate(
        """() => {
            const title = document.querySelector('.session-heading h1').getBoundingClientRect();
            const info = document.querySelector('#sessionInfoButton').getBoundingClientRect();
            return {
                titleCenterDelta: Math.abs(title.left + title.width / 2 - innerWidth / 2),
                infoRightOfTitle: info.left >= title.right,
                infoGap: info.left - title.right,
                titleInfoCenterDelta: Math.abs((title.top + title.height / 2) - (info.top + info.height / 2)),
                buttonFontSize: getComputedStyle(document.querySelector('#copyLinkBtn')).fontSize,
                buttonRadius: getComputedStyle(document.querySelector('#copyLinkBtn')).borderRadius,
            };
        }"""
    )
    assert title_info_metrics["titleCenterDelta"] <= 2, title_info_metrics
    assert title_info_metrics["infoRightOfTitle"], title_info_metrics
    assert 0 <= title_info_metrics["infoGap"] <= 8, title_info_metrics
    assert title_info_metrics["titleInfoCenterDelta"] <= 1, title_info_metrics
    assert title_info_metrics["buttonFontSize"] == "12px", title_info_metrics
    assert title_info_metrics["buttonRadius"] == "999px", title_info_metrics
    page.locator("#sessionInfoButton").click()
    expect(page.locator("#sessionInfoPopover")).to_be_visible()
    summary_text = page.locator("#sessionInfoPopover").inner_text()
    assert "Sessions" in summary_text and "Agents" in summary_text and "Problem events" in summary_text, summary_text
    page.keyboard.press("Escape")
    expect(page.locator("#sessionInfoPopover")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    record(history, page, "Verify header navigation and session info popover", "[data-testid='command-bar']")

    click_and_record(history, page, "Copy current link", "#copyLinkBtn")
    expect(page.locator("#linkStatus")).to_contain_text("Copied")

    expect(page.get_by_test_id("message-index")).to_be_visible()
    assert_message_index_item_presentation(page)
    sticky_metrics = page.evaluate(
        """async () => {
            const header = document.querySelector('[data-testid="left-pane-header"]');
            const body = document.querySelector('.nav-body-section');
            const beforeTop = header.getBoundingClientRect().top;
            body.scrollTop = Math.min(900, body.scrollHeight - body.clientHeight);
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await new Promise((resolve) => requestAnimationFrame(resolve));
            return {
                beforeTop,
                afterTop: header.getBoundingClientRect().top,
                scrollTop: body.scrollTop,
                scrollable: body.scrollHeight > body.clientHeight,
            };
        }"""
    )
    assert sticky_metrics["scrollable"] and sticky_metrics["scrollTop"] > 0, sticky_metrics
    assert abs(sticky_metrics["afterTop"] - sticky_metrics["beforeTop"]) <= 1.5, sticky_metrics
    record(history, page, "Verify single-button Waterfall navigation header", "[data-testid='left-pane-header']")

    card_before_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    page.get_by_test_id("transcript-message").nth(1).click()
    page.wait_for_timeout(200)
    card_after_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    assert card_after_key != card_before_key, (card_before_key, card_after_key)
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_hidden()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(0)
    expect(page.get_by_test_id("timeline-detail-pin")).to_have_count(0)
    record(history, page, "Click Waterfall message card without opening detail window", "[data-testid='transcript-message']")

    click_and_record(history, page, "Open agent tree drawer", "#agentPaneToggle")
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
    expect(page.locator("#agentPaneToggle")).to_have_attribute("aria-expanded", "true")
    assert_agent_sidebar_inserted(page)
    assert_message_index_item_presentation(page)
    select_problem_track_from_agent_sidebar(page)
    assert_message_index_item_presentation(page, require_problem=True)
    expect(page.get_by_test_id("subagent-node")).to_have_count(65)
    expect(page.get_by_test_id("subagent-toggle")).to_have_count(64)
    before_tree_select = state(page)
    page.get_by_test_id("subagent-node").nth(1).locator(".agent-tree-select").click()
    page.wait_for_timeout(250)
    record(history, page, "Select subagent in tree without opening panel", "[data-testid='subagent-node']:nth-child(2) .agent-tree-select", before_tree_select)
    expect(page.locator(".subagent-panel")).to_have_count(0)
    expect(page.locator("[role='treeitem'][aria-selected='true']")).to_have_count(1)

    click_and_record(history, page, "Pin first subagent from Agent Tree drawer", "[data-testid='subagent-toggle']")
    expect(page.locator(".subagent-panel")).to_have_count(1)
    expect(page.get_by_test_id("subagent-toggle").first).to_have_attribute("aria-pressed", "true")
    expect(page.get_by_test_id("subagent-toggle").first).to_have_text("")
    expect(page.locator("#agentStreamSeparator")).to_be_visible()
    page.locator("#agentTreeDrawerClose").click()
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_hidden()
    expect(page.locator("#agentPaneToggle")).to_have_attribute("aria-expanded", "false")
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
    page.locator("#agentPaneToggle").click()
    expect(page.get_by_test_id("agent-tree-drawer")).to_be_visible()
    click_and_record(history, page, "Close subagent from Agent Tree toggle", "[data-testid='subagent-toggle']")
    expect(page.locator(".subagent-panel")).to_have_count(0)
    expect(page.get_by_test_id("subagent-toggle").first).to_have_text("")
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

    before_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    click_and_record(history, page, "Focus message from message index", "[data-testid='message-index'] [data-action='focus-message']:nth-child(2)")
    after_key = page.evaluate("window.SESSION_VIEWER.current().capsuleKey")
    assert after_key != before_key
    expect(page.locator("#returnElementBtn")).to_be_enabled()
    page.locator("#returnElementBtn").click()
    page.wait_for_function("(key) => window.SESSION_VIEWER.current().capsuleKey === key", arg=before_key)
    record(history, page, "Backward to previous transcript focus", "#returnElementBtn")
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

    click_and_record(history, page, "Switch to Timeline", "#graphLayoutBtn")
    expect(page.get_by_test_id("overview-timeline-layout")).to_be_visible()
    expect(page.locator(".left-rail")).to_be_hidden()
    expect(page.locator("canvas")).to_have_count(0)
    expect(page.locator("[data-testid='graph-capsule']")).to_have_count(0)
    page.wait_for_function("document.querySelectorAll('[data-testid=timeline-block]').length > 0")
    assert page.locator("[data-testid='timeline-block']").count() < 5000
    metrics = page.evaluate("window.SESSION_VIEWER.timelineMetrics()")
    assert metrics["uniqueBlockWidths"] == [118], metrics
    assert metrics["uniqueBlockHeights"] == [26], metrics
    page.locator("[data-testid='timeline-block']").nth(0).click()
    expect(page.get_by_test_id("timeline-detail-dock")).to_be_visible()
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(1)
    assert_timeline_detail_top_right(page, expected_count=1)
    page.locator("[data-testid='timeline-block']").nth(1).click(modifiers=["Meta"])
    expect(page.get_by_test_id("selected-capsule-summary")).to_contain_text("2 transcript elements selected")
    expect(page.get_by_test_id("timeline-detail-panel")).to_have_count(2)
    assert_timeline_detail_top_right(page, expected_count=2)
    record(history, page, "Multiselect timeline blocks", "[data-testid='timeline-block']")

    assert page.evaluate("window.SESSION_VIEWER.spawnEdges.length") > 0
    assert page.locator(".timeline-connector.spawn").count() > 0
    record(history, page, "Verify visible timeline spawn connectors at native resolution", ".timeline-connector.spawn")

    click_and_record(history, page, "Return to Waterfall after Timeline use", "#readerLayoutBtn")
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
