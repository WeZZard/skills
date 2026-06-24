# Session Viewer

This app extends the apps-wide design system in `../CLAUDE.md`.

## Design System

The Session Viewer-specific design system follows the app navigation hierarchy.
Shared typography, spacing, shape, color, control, and motion primitives come
from `apps/CLAUDE.md`. This file defines how those primitives are applied to the
Session Viewer domain.

### 1. Navigation Map

The app has one persistent global command region and two primary views:

- Global Header / Command Bar
- Timeline View
- Waterfall View

Timeline and Waterfall share transcript semantics, search state, and deep-link
behavior, but their selection and pinning state must remain separate unless a
user action explicitly crosses views.

### 2. Global Header / Command Bar

Purpose: persistent session-level navigation and view control.

Contains:

- Sessions link.
- Backward and Forward transcript navigation.
- Session title and session info.
- Project path and branch metadata.
- Search toggle.
- Timeline / Waterfall switch.
- Copy link action.

Rules:

- Use apps-wide `control-height` for command buttons.
- Use apps-wide `ui` typography for command buttons and search toggles.
- Use apps-wide `body` typography for session/project metadata.
- Search toggle active state uses the shared accent family.
- The command bar should remain visually quiet; avoid heavy shadows and
  decorative treatments.

### 3. Timeline View

Timeline is the structural overview of the transcript across main agent and
subagent tracks. It prioritizes spatial relationships, semantic block scanning,
and stable overlay placement.

#### 3.1. Timeline Search Shelf

Purpose: inline Timeline search controls inserted between the command bar and
the Timeline agent list.

Rules:

- Insert and remove the shelf with a bounded transition.
- The shelf uses shared search control sizing:
  - search input height: 32px.
  - search input typography: apps-wide `ui`.
  - search navigation buttons: compact 28px controls.
- Preserve the same horizontal inset as nearby Timeline surfaces.
- Keep a compact two-row rhythm: primary search row plus options row.
- Search shelf expansion must trigger Timeline canvas and detail-window layout
  remeasurement during and after the transition.

#### 3.2. Agent List / Timeline Header

Purpose: fixed structural map of the main agent and subagents.

Rules:

- Agent cells fill their full column edge-to-edge: top, bottom, left, and right.
- Text content keeps internal padding from those edges.
- Do not use card borders for agent cells.
- Selected state uses full-cell background highlight.
- Error state uses a bottom-right exclamation icon and does not change the
  agent background color.
- The main agent uses `MAIN` and does not show a separate name or description.
- Subagents use `SUBAGENT`, show the subagent name instead of UUID, and may show
  up to two description lines before truncation.
- Model and block count sit at the bottom-left for both main and subagent cells.
- `MAIN` and `SUBAGENT` must use identical kicker typography.

#### 3.3. Timeline Canvas

Purpose: virtualized, scrollable block layout showing transcript flow by agent.

Rules:

- Timeline geometry must stay deterministic under virtualization.
- Search hit/context state must not alter block dimensions.
- Selection and active states must not alter track layout.
- The canvas should render semantic relationships without decorative grid noise.

#### 3.4. Timeline Blocks

Purpose: compact semantic markers for transcript blocks.

Typography:

- Use badge/kicker typography, not body typography.
- Recommended block label spec:

```css
font-size: 10px;
line-height: 1;
font-weight: 850-900;
letter-spacing: 0;
text-transform: uppercase;
white-space: nowrap;
```

Rules:

- Timeline block labels represent semantic kind, not message content.
- Labels should remain short, centered, and stable.
- Do not resize blocks to fit text.
- Truncate or ellipsize labels when needed.
- Strong semantic fills are appropriate because blocks are small and must scan
  quickly.

#### 3.5. Connectors / Spawn Arrows

Purpose: show parent tool calls, subagent spawning, and response relationships.

Rules:

- Spawn message starts below the line of the agent that made the call.
- Connector paths use rectangular corners.
- Connector path structure:
  - start from the calling agent's tool call.
  - route to the center of the subagent column.
  - turn downward and point to the subagent spawning message.
- Normal and highlighted connector appearances must be identical except for
  color.

#### 3.6. Detail Window Dock / Window Layout Area

Purpose: deterministic placement for live and pinned detailed message windows.

Rules:

- Detail windows are managed inside a computed "window layout area."
- The window layout area begins below the Timeline agent list plus the standard
  clearance.
- Detail windows anchor to the right edge of the layout area and wrap leftward
  when multiple windows are pinned.
- Recompute the layout area when:
  - Timeline search shelf opens or closes.
  - Timeline viewport resizes.
  - Timeline header or agent list changes size.
  - detail window count changes.
- Layout-affecting transitions must use immediate measurement, animation-frame
  follow-up, and final transition-end measurement.

### 4. Waterfall View

Waterfall is the detailed transcript reading mode. It prioritizes readable
message content, agent-local navigation, and side-by-side subagent inspection.

#### 4.1. Left Navigation Region

Purpose: switch between agent tree, message navigation, and Waterfall search.

Rules:

- In normal Waterfall mode, left navigation shows agent navigation and message
  navigation.
- When Waterfall search opens, it may replace the left navigation region.
- The transition between normal navigation and search should be animated and
  spatially understandable.

#### 4.2. Agent Tree

Purpose: navigate and pin agents/subagents in Waterfall.

Rules:

- Agent tree selection state is separate from Timeline selection state.
- Pin controls are shown for subagents in Waterfall where panel pinning is
  meaningful.
- Agent labels should prefer names over UUIDs.
- Dense rows use background and inset accents, not heavy cards.

#### 4.3. Message Navigation

Purpose: compact navigation through messages in the selected agent transcript.

Rules:

- Display the second-level content category when available.
- Display the first-level line category only when the second-level category is
  unavailable.
- Do not show a slash separator in message navigation category labels.
- Keep row height stable.
- Preview text uses apps-wide `ui` typography.
- Time and problem metadata use apps-wide `meta` typography.

#### 4.4. Waterfall Search Panel

Purpose: unified search and result navigation for Waterfall content.

Rules:

- Search input uses the same control height and typography as Timeline search.
- Search result snippets use apps-wide `ui` typography.
- Result metadata uses apps-wide `meta` or `kicker` typography depending on
  density.
- Current result indication uses accent and must not resize rows.
- Opening a subagent search result may open the required subagent panel.

#### 4.5. Main Transcript Stream

Purpose: readable main-agent transcript flow.

Rules:

- Message cards may use panel/card styling because they are repeated content
  containers.
- Keep body content readable while preserving scan density.
- Message headers should expose kind, subtype, timestamp, and status without
  crowding the message body.

#### 4.6. Subagent Panels

Purpose: pinned side-by-side subagent transcript inspection.

Rules:

- Panels participate in Waterfall window management, not Timeline selection.
- Panel widths must preserve main transcript readability.
- Closing and pinning controls use compact icon/button treatment.

#### 4.7. Raw / Detail Inspection

Purpose: inspect raw payloads and structured details from Waterfall.

Rules:

- Raw/code payloads use apps-wide `code` typography.
- Detail controls should not resize segmented controls when icons or problem
  indicators appear.
- Raw panels should be visually subordinate to transcript content unless opened
  intentionally.

### 5. Shared Transcript Semantics

The viewer uses a two-level transcript taxonomy:

- First-level line kind: broad source or role.
- Second-level content kind: more specific message or event category.

Rules:

- Timeline blocks may compress taxonomy into a short semantic label.
- Detail windows may show both line kind and content kind.
- Waterfall message navigation shows content kind first and line kind only as
  fallback.
- Semantic colors are consistent across Timeline, Waterfall, navigation, and
  detail windows.

Semantic families:

- User/message: green.
- Assistant/message: blue.
- Attachment/system payload: teal.
- System/raw event: gray.
- Reasoning: purple.
- Tool call: orange.
- Tool result: cyan.

### 6. Cross-View Interaction Rules

Rules:

- Timeline selected agent and Waterfall selected agent are separate state.
- Timeline block selection and Waterfall panel pinning are separate state.
- Search query may be shared across views, but each view owns its presentation,
  result panel, and cursor behavior.
- Keyboard search behavior should feel consistent:
  - `Cmd/Ctrl+F` opens search for the current view.
  - `Enter` advances to next result inside the active search input.
  - `Shift+Enter` moves to previous result.
  - `Escape` clears the query first, then closes search.
- Deep links should preserve target identity and not create unexpected cross-view
  pinning.

### 7. Implementation And Validation Notes

Rules:

- Prefer named design-system primitives before adding new raw values.
- Fixed-format UI elements must have stable dimensions.
- Search, selection, hover, problem, and pinned states must not cause layout
  shifts unless the layout is explicitly recalculated.
- Browser validation is required for changes touching:
  - Timeline virtualization.
  - Timeline search shelf.
  - Timeline detail window layout.
  - Waterfall search replacement.
  - cross-view selection or pinning.
- Validate important Timeline layout changes at Apple Studio Display native
  resolution.

## Claude Code Transcript Scanners

Use the two-step Claude transcript scanner workflow from this app directory when:

- Adding or changing Claude Code message navigation items, Waterfall cards, Timeline blocks, or Timeline detail cards.
- Investigating unknown Claude Code transcript message kinds, including true system events.
- Auditing whether renderer fixtures cover all message kinds and structural shapes under a Claude projects directory.
- Updating fixture coverage for Claude Code cards in `scripts/validate_browser.py`.

Prefer scanning the same source directory the app will read:

```bash
uv run python scripts/scan_claude_message_kinds.py --projects-dir ~/.claude/projects
uv run python scripts/scan_claude_message_shapes.py --projects-dir ~/.claude/projects --json
uv run python scripts/compile_claude_message_type_design.py \
  --projects-dir ~/.claude/projects \
  --array-output reports/claude-transcript-scans/message-type-array.json \
  --design-output reports/claude-transcript-scans/message-type-card-design.md
```

The kind scanner identifies the two-level viewer taxonomy (`lineKind / contentKind`) across main and subagent JSONL files. The shape scanner groups structural variants inside each kind so card designs can be based on observed payloads.

Use the compiler when renderer work needs a single machine-readable array of
all observed type/subtype records plus shape-aware design guidance for
Waterfall cards, Waterfall navigation items, Timeline blocks, and Timeline
detail cards.

`scripts/scan_claude_attachments.py` remains as a compatibility wrapper for attachment-only audits.

The utility is for Claude Code JSONL transcripts only. Do not use it for OpenCode sessions, which are stored in `opencode.db` and should be inspected through the OpenCode store path.
