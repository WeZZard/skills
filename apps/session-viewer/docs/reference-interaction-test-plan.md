# Reference Interaction Test Plan

## Source Observation

- Reference app: `../../briancappello/opencode-session-viewer`
- Reference route: `/conversation/ses_129e7d574ffeYQ1xWHSZv3c6RJ`
- Browser viewport: Apple Studio Display native resolution, `5120 x 2880`
- Browser evidence:
  - `/tmp/session-viewer-reference-workflow/reference-operation-history.json`
  - `/tmp/session-viewer-reference-workflow/reference-initial-studio-native.png`
  - `/tmp/session-viewer-reference-workflow/reference-final-studio-native.png`

The reference page exposed 146 visible interactive elements in the initial Studio viewport:

- 52 inline activity-link buttons for tool result and subagent stream actions.
- 27 agent filter options, including the active main agent.
- 20 sidebar message rows.
- 20 message copy buttons.
- 17 reasoning disclosure summaries.
- Top controls for back, archive, and theme.
- Sidebar controls for text filter, clear, role filters, hide intermediate steps, and resize.
- A collapsed stats panel toggle.

## Reference Operation History

1. Toggle theme: body switches between light and dark.
2. Expand/collapse stats panel: right stats panel changes collapsed state.
3. Type sidebar filter: message list is filtered and clear button becomes enabled.
4. Clear filter: filter text is removed and message list returns to default.
5. Select User, Assistant, and All role filters: sidebar message list switches role scope.
6. Toggle Hide intermediate steps: transcript/sidebar visibility policy changes.
7. Select a subagent from the horizontal agent list: selected agent changes, a subagent panel opens, and an open-agent chip appears.
8. Select and close the open-agent chip: subagent panel closes and selection returns to main.
9. Click sidebar message row: transcript scrolls to the corresponding message and marks it active/highlighted.
10. Copy message markdown: clipboard write occurs and the button shows temporary copied feedback.
11. Toggle reasoning disclosure: reasoning details expand/collapse when present.
12. Expand/collapse inline tool result: tool result card appears/disappears and the sidebar gains/removes the tool item.
13. Open subagent stream from task reference: floating subagent panel opens and selected agent changes.
14. Use subagent connector nodes: parent, first-message, and result controls navigate between related transcript elements.
15. Resize panels: subagent separator resizes until the golden-remainder main width clamp is reached.
16. Back link: returns to the dashboard when browser history is present.
17. Archive button: posts archive/unarchive and redirects after archiving.

## Session Viewer Alignment Scope

The Claude Code session viewer intentionally adopts the reference behaviors that support transcript browsing, isolation, and structural inspection:

- Top command bar navigation remains present and stable.
- Focus and Overview layout switch remains present.
- Return and Forward preserve in-app transcript focus history.
- Message Navigation tab provides horizontal agent selection, selected/open-agent chips, and a message list.
- Agent Tree tab provides hierarchical agent invocation browsing.
- Message rows focus transcript elements.
- Focus removes per-message Inspect/Raw controls and keeps the top-level Copy link.
- Part controls expose paired Call/Result navigation without raw JSON controls.
- Task/spawn references open subagent panels and jump to the child flow.
- Subagent connector controls navigate parent, first message, and result when available.
- Agent Tree toggles open and close subagent panels and reflects selected/open state.
- Focus uses golden-section sizing and independent subagent scrolling.
- Overview uses HTML/SVG capsules, supports capsule selection and multiselect, and exposes spawn edges.

Reference behaviors not adopted for the Claude Code viewer remain out of scope for this plan:

- Conversation text search and role filters, because conversation search is intentionally deferred.
- Archive/Unarchive and Sync, because this viewer is read-only.
- Theme toggle and token visualization panel.
- Sidebar resizing.
- Copy full message markdown; this viewer exposes deep-link copying instead.

## Executable Test Plan

Run:

```bash
cd apps/session-viewer
uv run python scripts/validate_reference_interaction_plan.py
```

The verifier builds a temporary Claude Code fixture, starts the viewer on a free local port, opens the conversation at `5120 x 2880`, and records a browser-derived operation report at:

`/tmp/session-viewer-reference-workflow/session-viewer-reference-plan-report.json`

Required gates:

- Top-right navigation: Focus, Overview, Return, Forward, and Copy link exist; obsolete Previous/Next/First problem/timestamp controls do not.
- Overview: graph layout remains reachable and renders DOM/SVG capsules without canvas.
- Message Navigation: horizontal agent list, selected-agent strip, and message index are present and interactive.
- Agent Tree: hierarchy is present and can toggle subagent panels.
- Return/Forward: focus history restores backward and forward.
- Focus inspector: no inspector DOM or Inspect/Raw controls are present.
- Focus sizing: main stream max width follows the golden section and divider resizing clamps at the golden-remainder minimum.
- Focus scrolling: main and subagent streams scroll independently.
- Part navigation: paired Call/Result controls work when present.
- Subagent flow: task reference opens a panel, Jump to first focuses child message, and connector controls navigate related transcript elements.
- Copy link: top-level copy action provides observable copied feedback.
- Preservation: after the interaction sequence, top navigation and Overview remain functional.
