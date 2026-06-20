const SESSION_DATA = JSON.parse(document.getElementById("conversation-data").textContent);

const state = {
  layout: "reader",
  currentCapsuleKey: "",
  backStack: [],
  forwardStack: [],
  leftNavTab: "messages",
  selectedTrackId: "main",
  selectedGraphKeys: new Set(),
  openPanelIds: new Set(),
  graphFrame: null,
  linkStatusTimer: null,
  subagentPanelRackWidthOverride: null,
  subagentSeparatorResizeState: null,
  pendingPanelPinId: "",
};

const navByKey = new Map();
const problemsById = new Map();
const problemsByNavKey = new Map();
const capsuleByKey = new Map();
const trackById = new Map();
const childTrackByParentTaskKey = new Map();
const toolCallByScopedId = new Map();
const toolResultByScopedId = new Map();
const navKeyToCapsuleKey = new Map();
const edgesByCapsuleKey = new Map();

const model = {
  tracks: [],
  capsules: [],
  spawnEdges: [],
  width: 1200,
  height: 640,
  laneHeight: 58,
  headerWidth: 280,
  capsuleWidth: 8,
  capsuleHeight: 20,
  capsuleStep: 11,
};

const GOLDEN_SECTION = 0.61803398875;
const GOLDEN_REMAINDER = 1 - GOLDEN_SECTION;

const els = {
  workbench: document.querySelector(".dual-workbench"),
  breadcrumb: document.getElementById("breadcrumb"),
  layoutButtons: document.querySelectorAll("[data-layout]"),
  readerButton: document.getElementById("readerLayoutBtn"),
  graphButton: document.getElementById("graphLayoutBtn"),
  returnButton: document.getElementById("returnElementBtn"),
  forwardButton: document.getElementById("forwardElementBtn"),
  sessionSummary: document.getElementById("sessionSummary"),
  leftTabs: document.querySelectorAll("[data-left-tab]"),
  messageNavPanel: document.getElementById("messageNavPanel"),
  agentTreePanel: document.getElementById("agentTreePanel"),
  agentSelector: document.getElementById("agentSelector"),
  openAgentChips: document.getElementById("openAgentChips"),
  agentTree: document.getElementById("agentTree"),
  messageIndex: document.getElementById("messageIndex"),
  graphLegendSection: document.getElementById("graphLegendSection"),
  flowLegend: document.getElementById("flowLegend"),
  transcript: document.getElementById("transcript"),
  readerLayout: document.getElementById("readerLayout"),
  graphLayout: document.getElementById("graphLayout"),
  mainContent: document.getElementById("mainContent"),
  readerMainStream: document.getElementById("readerMainStream"),
  agentStreamSeparator: document.getElementById("agentStreamSeparator"),
  subagentPanelOverlay: document.getElementById("subagentPanelOverlay"),
  graphViewport: document.getElementById("graphViewport"),
  graphSizer: document.getElementById("graphSizer"),
  graphLayer: document.getElementById("graphLayer"),
  graphEdges: document.getElementById("graphEdges"),
  graphLanes: document.getElementById("graphLanes"),
  graphCapsules: document.getElementById("graphCapsules"),
  graphStatus: document.getElementById("graphSelectionStatus"),
  linkStatus: document.getElementById("linkStatus"),
};

const TYPE_STYLE = {
  system: { label: "system", className: "system", color: "#6b7280" },
  user: { label: "user", className: "user", color: "#2f7d5a" },
  assistant: { label: "assistant", className: "assistant", color: "#2563eb" },
  reasoning: { label: "reasoning", className: "reasoning", color: "#7c3aed" },
  tool: { label: "tool call", className: "tool", color: "#9a6700" },
  tool_result: { label: "tool result", className: "tool-result", color: "#0f766e" },
  raw_event: { label: "raw event", className: "raw-event", color: "#71717a" },
  mixed: { label: "mixed", className: "mixed", color: "#334155" },
};

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value === null || value === undefined ? "" : String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function text(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compact(value, length = 140) {
  const oneLine = text(value).replace(/\s+/g, " ").trim();
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}...` : oneLine;
}

function compactHtml(value) {
  return value.replace(/>\s+</g, "><").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function domId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "-");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

function navKey(nav) {
  if (!nav) return "";
  return [
    nav.sessionId,
    nav.agentPath,
    nav.jsonlFile,
    nav.lineNumber,
    nav.eventIndex,
    nav.elementType,
    nav.contentIndex ?? "",
    nav.toolUseId ?? "",
    nav.jsonPointer ?? "",
    nav.problemId ?? "",
    nav.view ?? "rendered",
  ]
    .join(":")
    .replaceAll("/", "_");
}

function rememberNav(nav) {
  const key = navKey(nav);
  if (key) navByKey.set(key, nav);
  return key;
}

function eventAddress(nav) {
  return nav ? `${nav.jsonlFile}:${nav.lineNumber}` : "";
}

function scopedToolKey(nav, toolId) {
  if (!toolId) return "";
  return `${nav?.agentPath || nav?.jsonlFile || "unknown"}::${toolId}`;
}

function firstNav(transcript) {
  return transcript.messages?.[0]?.nav || transcript.raw_events?.[0]?.nav || transcript.parent_task_nav || null;
}

function transcriptTitle(transcript, fallback = "Transcript") {
  return transcript.summary?.title || transcript.agent_type || fallback;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${date.toLocaleDateString()}`;
}

function rawText(event) {
  return typeof event?.raw === "string" ? event.raw : text(event?.raw);
}

function partText(part) {
  if (!part) return "";
  if (part.text) return part.text;
  if (part.state?.input) return text(part.state.input);
  if (part.state?.output) return text(part.state.output);
  if (part.state?.content) return text(part.state.content);
  if (part.state?.error) return text(part.state.error);
  if (part.state) return text(part.state);
  return "";
}

function messageText(message) {
  return (message.parts || []).map(partText).filter(Boolean).join("\n");
}

function capsuleType(message) {
  if (!message) return "raw_event";
  const partTypes = new Set((message.parts || []).map((part) => part.type));
  if (partTypes.has("tool_result")) return "tool_result";
  if (partTypes.has("tool")) return "tool";
  if (partTypes.has("reasoning") && partTypes.size === 1) return "reasoning";
  if (partTypes.size > 1 && !partTypes.has("text")) return "mixed";
  return message.role || "mixed";
}

function typeStyle(type) {
  return TYPE_STYLE[type] || TYPE_STYLE.mixed;
}

function registerProblem(problem) {
  const id = problem.id || `${navKey(problem.nav)}:${problem.kind}`;
  const dedupeKey = `${navKey(problem.nav)}::${problem.kind}`;
  if ([...problemsById.values()].some((item) => item._dedupeKey === dedupeKey)) return;
  const normalized = { ...problem, id, _dedupeKey: dedupeKey };
  problemsById.set(id, normalized);
  const key = rememberNav(problem.nav);
  const list = problemsByNavKey.get(key) || [];
  list.push(normalized);
  problemsByNavKey.set(key, list);
}

function allProblems() {
  return [...problemsById.values()].sort((a, b) => {
    const aLine = a.nav?.lineNumber || Number.MAX_SAFE_INTEGER;
    const bLine = b.nav?.lineNumber || Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) return aLine - bLine;
    return (a.kind || "").localeCompare(b.kind || "");
  });
}

function problemListForMessage(message) {
  const keys = [rememberNav(message.nav), ...(message.parts || []).map((part) => rememberNav(part.nav))];
  const seen = new Set();
  const problems = [];
  keys.forEach((key) => {
    (problemsByNavKey.get(key) || []).forEach((problem) => {
      if (seen.has(problem.id)) return;
      seen.add(problem.id);
      problems.push(problem);
    });
  });
  return problems;
}

function addEdge(sourceKey, edge) {
  if (!sourceKey || !edge?.targetKey) return;
  const list = edgesByCapsuleKey.get(sourceKey) || [];
  list.push(edge);
  edgesByCapsuleKey.set(sourceKey, list);
}

function addBidirectionalEdge(sourceKey, targetKey, type, sourceLabel, targetLabel, basis = "") {
  addEdge(sourceKey, { type, label: sourceLabel, basis, targetKey, direction: "out" });
  addEdge(targetKey, { type, label: targetLabel, basis, targetKey: sourceKey, direction: "in" });
}

function collectTranscripts(transcript = SESSION_DATA, depth = 0, parentTrackId = "") {
  const nav = firstNav(transcript);
  const id = nav?.agentPath || (depth === 0 ? "main" : `track-${model.tracks.length}`);
  const laneProblems = new Set();
  (transcript.problem_flags || []).forEach((problem) => laneProblems.add(`${navKey(problem.nav)}::${problem.kind}`));
  const track = {
    id,
    index: model.tracks.length,
    depth,
    parentTrackId,
    transcript,
    nav,
    messages: transcript.messages || [],
    subagents: transcript.subagent_transcripts || [],
    title: transcriptTitle(transcript, depth === 0 ? "Main transcript" : "Agent transcript"),
    agentType: transcript.agent_type || (depth === 0 ? "main" : "subagent"),
    taskPartId: transcript.task_part_id || "",
    taskMessageId: transcript.task_message_id || "",
    parentTaskNav: transcript.parent_task_nav || null,
    parentResultNav: transcript.parent_result_nav || null,
    previousSiblingNav: transcript.previous_sibling_nav || null,
    nextSiblingNav: transcript.next_sibling_nav || null,
    relationship: transcript.relationship_hint || "",
    relationshipBasis: transcript.relationship_basis || "",
    problemCount: laneProblems.size,
    firstCapsuleKey: "",
    lastCapsuleKey: "",
    capsuleKeys: [],
    y: 0,
  };
  model.tracks.push(track);
  trackById.set(id, track);
  (transcript.subagent_transcripts || []).forEach((child) => collectTranscripts(child, depth + 1, id));
}

function buildModels() {
  collectTranscripts();
  model.tracks.forEach((track) => {
    (track.transcript.raw_events || []).forEach((event) => {
      const key = rememberNav(event.nav);
      if (key) navKeyToCapsuleKey.set(key, key);
    });
    (track.transcript.problem_flags || []).forEach(registerProblem);
    if (track.parentTaskNav) childTrackByParentTaskKey.set(navKey(track.parentTaskNav), track);
  });

  model.tracks.forEach((track, laneIndex) => {
    const renderedAddresses = new Set();
    track.messages.forEach((message, messageIndex) => {
      const key = rememberNav(message.nav) || `${track.id}:message:${messageIndex}`;
      const parts = message.parts || [];
      const problems = problemListForMessage(message);
      const type = capsuleType(message);
      const capsule = {
        key,
        trackId: track.id,
        laneIndex,
        message,
        nav: message.nav,
        role: message.role || "",
        type,
        label: `${message.role || "message"} ${messageIndex + 1}`,
        summary: compact(messageText(message) || message.role || "message"),
        timestamp: message.time_created || 0,
        lineNumber: message.nav?.lineNumber || 0,
        messageIndex,
        partTypes: parts.map((part) => part.type),
        problems,
        problemCount: problems.length,
        rawOnly: false,
        x: 0,
        y: 0,
        width: model.capsuleWidth,
        height: model.capsuleHeight,
      };
      capsuleByKey.set(key, capsule);
      model.capsules.push(capsule);
      track.capsuleKeys.push(key);
      navKeyToCapsuleKey.set(key, key);
      renderedAddresses.add(eventAddress(message.nav));
      parts.forEach((part) => {
        const partKey = rememberNav(part.nav);
        if (partKey) navKeyToCapsuleKey.set(partKey, key);
        renderedAddresses.add(eventAddress(part.nav));
        const toolId = part.nav?.toolUseId || part.state?.tool_use_id || part.id || "";
        const scoped = scopedToolKey(part.nav, toolId);
        if (part.type === "tool" && scoped) toolCallByScopedId.set(scoped, part.nav);
        if (part.type === "tool_result" && scoped) toolResultByScopedId.set(scoped, part.nav);
      });
    });

    (track.transcript.raw_events || []).forEach((event) => {
      if (renderedAddresses.has(eventAddress(event.nav))) return;
      const key = rememberNav(event.nav);
      const capsule = {
        key,
        trackId: track.id,
        laneIndex,
        message: null,
        nav: event.nav,
        role: "raw",
        type: "raw_event",
        label: "raw event",
        summary: compact(rawText(event)),
        timestamp: Date.parse(event.raw?.timestamp || "") || 0,
        lineNumber: event.nav?.lineNumber || 0,
        messageIndex: track.capsuleKeys.length,
        partTypes: ["raw_event"],
        problems: problemsByNavKey.get(key) || [],
        problemCount: (problemsByNavKey.get(key) || []).length,
        rawOnly: true,
        x: 0,
        y: 0,
        width: model.capsuleWidth,
        height: model.capsuleHeight,
      };
      capsuleByKey.set(key, capsule);
      model.capsules.push(capsule);
      track.capsuleKeys.push(key);
      navKeyToCapsuleKey.set(key, key);
    });

    track.firstCapsuleKey = track.capsuleKeys[0] || "";
    track.lastCapsuleKey = track.capsuleKeys[track.capsuleKeys.length - 1] || "";
    track.capsuleKeys.forEach((key, index) => {
      const next = track.capsuleKeys[index + 1];
      if (next) addBidirectionalEdge(key, next, "sequence", "Next message", "Previous message");
    });
  });

  for (const [scoped, callNav] of toolCallByScopedId.entries()) {
    const resultNav = toolResultByScopedId.get(scoped);
    const callKey = navKeyToCapsuleKey.get(navKey(callNav));
    const resultKey = navKeyToCapsuleKey.get(navKey(resultNav));
    if (callKey && resultKey) addBidirectionalEdge(callKey, resultKey, "tool_pair", "Tool result", "Tool call", scoped.split("::")[1]);
  }

  model.tracks.forEach((track) => {
    if (!track.parentTaskNav || !track.firstCapsuleKey) return;
    const parentKey = navKeyToCapsuleKey.get(navKey(track.parentTaskNav));
    if (!parentKey) return;
    const edge = {
      type: "spawn",
      label: "Spawned subagent",
      basis: track.relationshipBasis || track.relationship,
      sourceKey: parentKey,
      targetKey: track.firstCapsuleKey,
      trackId: track.id,
    };
    model.spawnEdges.push(edge);
    addBidirectionalEdge(parentKey, track.firstCapsuleKey, "spawn", "Spawned subagent", "Parent spawn", edge.basis);
    const resultKey = navKeyToCapsuleKey.get(navKey(track.parentResultNav));
    if (resultKey) addBidirectionalEdge(track.lastCapsuleKey, resultKey, "parent_result", "Parent result", "Child completion", track.id);
  });

  layoutGraph();
}

function layoutGraph() {
  const lanePadTop = 26;
  let maxCapsules = 1;
  model.tracks.forEach((track, laneIndex) => {
    maxCapsules = Math.max(maxCapsules, track.capsuleKeys.length);
    track.y = lanePadTop + laneIndex * model.laneHeight;
    track.capsuleKeys.forEach((key, index) => {
      const capsule = capsuleByKey.get(key);
      if (!capsule) return;
      capsule.x = model.headerWidth + index * model.capsuleStep;
      capsule.y = track.y + 24;
      capsule.width = model.capsuleWidth;
      capsule.height = model.capsuleHeight;
    });
  });
  model.width = Math.max(1200, model.headerWidth + maxCapsules * model.capsuleStep + 140);
  model.height = Math.max(640, lanePadTop + model.tracks.length * model.laneHeight + 64);
}

function getLayoutFromUrl() {
  return new URLSearchParams(location.search).get("layout") === "graph" ? "graph" : "reader";
}

function setLinkStatus(message = "") {
  els.linkStatus.textContent = message;
}

function selectedCapsule() {
  return capsuleByKey.get(state.currentCapsuleKey) || null;
}

function currentNav() {
  return selectedCapsule()?.nav || null;
}

function navigationSnapshot(extra = {}) {
  return {
    key: state.currentCapsuleKey,
    layout: state.layout,
    selectedTrackId: state.selectedTrackId,
    ...extra,
  };
}

function canStoreNavigationSnapshot(item) {
  return Boolean(item?.key);
}

function pushBackNavigation(options = {}) {
  if (options.push === false) return;
  const item = navigationSnapshot();
  if (!canStoreNavigationSnapshot(item)) return;
  state.backStack.push(item);
  if (options.clearForward !== false) state.forwardStack = [];
}

function updateNavigationButtons() {
  els.returnButton.disabled = state.backStack.length === 0;
  els.forwardButton.disabled = state.forwardStack.length === 0;
}

function readerMessageId(trackId, index) {
  return `msg-${domId(trackId)}-${index}`;
}

function trackTitle(track) {
  return track?.title || track?.id || "Transcript";
}

function renderSessionSummary() {
  const problems = allProblems().length;
  els.sessionSummary.innerHTML = compactHtml(`
    <dl class="mini-stats">
      <dt>Agents</dt><dd>${model.tracks.length}</dd>
      <dt>Messages</dt><dd>${model.capsules.filter((item) => !item.rawOnly).length}</dd>
      <dt>Raw-only</dt><dd>${model.capsules.filter((item) => item.rawOnly).length}</dd>
      <dt>Problems</dt><dd>${problems}</dd>
    </dl>`);
}

function renderAgentSelector() {
  els.agentSelector.innerHTML = compactHtml(model.tracks
    .map((track) => {
      const active = track.id === state.selectedTrackId;
      const open = state.openPanelIds.has(track.id);
      return `
        <button class="agent-filter-option ${active ? "active" : ""} ${open ? "panel-open" : ""}" role="option" aria-selected="${active ? "true" : "false"}" aria-pressed="${open ? "true" : "false"}" data-action="select-track" data-track-id="${escAttr(track.id)}" data-testid="agent-filter-option">
          <span class="agent-filter-kind">${track.depth === 0 ? "main" : "subagent"}</span>
          <span class="agent-filter-title">${esc(compact(trackTitle(track), 54))}</span>
          <span class="agent-filter-count">${track.messages.length}</span>
        </button>`;
    })
    .join(""));

  const chipTracks = model.tracks.filter((track) => track.depth > 0 && state.openPanelIds.has(track.id));
  els.openAgentChips.innerHTML = chipTracks.length
    ? compactHtml(chipTracks
        .map((track) => {
          const closable = state.openPanelIds.has(track.id) && track.depth > 0;
          return `
            <button class="selected-agent-chip ${track.id === state.selectedTrackId ? "active" : ""}" data-action="select-track" data-track-id="${escAttr(track.id)}">
              <span>${esc(compact(trackTitle(track), 34))}</span>
              ${closable ? `<span class="selected-agent-chip-close" data-action="close-panel" data-track-id="${escAttr(track.id)}" aria-label="Close ${escAttr(trackTitle(track))}">x</span>` : ""}
            </button>`;
        })
        .join(""))
    : "";
}

function renderAgentTree() {
  const childrenByParent = new Map();
  model.tracks.forEach((track) => {
    const list = childrenByParent.get(track.parentTrackId || "") || [];
    list.push(track);
    childrenByParent.set(track.parentTrackId || "", list);
  });

  function renderNode(track) {
    const active = track.id === state.selectedTrackId;
    const open = state.openPanelIds.has(track.id);
    const title = trackTitle(track);
    const isSubagent = track.depth > 0;
    const children = childrenByParent.get(track.id) || [];
    const hasChildren = children.length > 0;
    return `
      <div
        class="agent-tree-entry"
        role="treeitem"
        aria-level="${track.depth + 1}"
        aria-selected="${active ? "true" : "false"}"
        aria-label="${escAttr(`${isSubagent ? "Subagent" : "Main agent"} ${title}`)}"
        ${hasChildren ? 'aria-expanded="true"' : ""}
      >
        <div
          class="agent-tree-node ${active ? "active" : ""} ${open ? "panel-open" : ""}"
          data-testid="subagent-node"
          style="--agent-depth:${track.depth}"
        >
          <span class="agent-tree-disclosure ${hasChildren ? "expanded" : "empty"}" aria-hidden="true"></span>
          <button class="agent-tree-select" data-action="select-track" data-track-id="${escAttr(track.id)}" aria-current="${active ? "true" : "false"}">
            <span class="agent-option-kind">${isSubagent ? "subagent" : "main"}</span>
            <span class="agent-option-title">${esc(compact(title, 58))}</span>
            <span class="agent-option-count">${track.messages.length}</span>
          </button>
          ${isSubagent ? `<button class="agent-tree-toggle" data-action="toggle-panel" data-track-id="${escAttr(track.id)}" data-testid="subagent-toggle" aria-pressed="${open ? "true" : "false"}" aria-label="${open ? "Unpin panel for" : "Pin panel for"} ${escAttr(title)}"><span class="agent-tree-toggle-dot" aria-hidden="true"></span><span>${open ? "Pinned" : "Pin"}</span></button>` : '<span class="agent-tree-toggle-placeholder" aria-hidden="true"></span>'}
        </div>
        ${hasChildren ? `<div class="agent-tree-group" role="group" style="--agent-depth:${track.depth}">${children.map(renderNode).join("")}</div>` : ""}
      </div>`;
  }

  const roots = childrenByParent.get("") || model.tracks.filter((track) => track.depth === 0);
  els.agentTree.innerHTML = compactHtml(roots.map(renderNode).join(""));
}

function setLeftNavTab(tab) {
  state.leftNavTab = tab === "agents" ? "agents" : "messages";
  els.leftTabs.forEach((button) => {
    const selected = button.dataset.leftTab === state.leftNavTab;
    button.setAttribute("aria-selected", String(selected));
  });
  els.messageNavPanel.classList.toggle("hidden", state.leftNavTab !== "messages");
  els.agentTreePanel.classList.toggle("hidden", state.leftNavTab !== "agents");
}

function renderLeftNavigation() {
  renderAgentSelector();
  renderAgentTree();
  renderMessageIndex();
}

function renderMessageIndex() {
  if (state.layout === "graph") {
    els.messageIndex.innerHTML = '<div class="nav-item muted">Overview uses lane labels and capsules for navigation.</div>';
    return;
  }
  const track = trackById.get(state.selectedTrackId) || model.tracks[0];
  if (!track) return;
  const maxItems = 1400;
  const messages = track.messages.slice(0, maxItems);
  els.messageIndex.innerHTML = compactHtml(messages
    .map((message, index) => {
      const key = navKeyToCapsuleKey.get(navKey(message.nav)) || "";
      const active = key && key === state.currentCapsuleKey;
      const problems = problemListForMessage(message);
      return `
        <button class="nav-item message-index-item ${active ? "active" : ""} ${problems.length ? "has-problem" : ""}" data-action="focus-message" data-track-id="${escAttr(track.id)}" data-message-index="${index}" aria-current="${active ? "true" : "false"}">
          <span class="role-badge ${escAttr(message.role || "message")}">${esc(message.role || "message")}</span>
          <span class="message-index-time">${esc(formatTime(message.time_created))}</span>
          <span class="message-preview">${esc(compact(messageText(message) || "(no content)", 110))}</span>
        </button>`;
    })
    .join("") + (track.messages.length > maxItems ? `<div class="nav-item muted">Showing first ${maxItems.toLocaleString()} of ${track.messages.length.toLocaleString()} messages.</div>` : ""));
}

function renderLegend() {
  els.flowLegend.innerHTML = compactHtml(Object.entries(TYPE_STYLE)
    .map(([, item]) => `<div class="legend-row"><span class="legend-swatch" style="background:${escAttr(item.color)}"></span>${esc(item.label)}</div>`)
    .join("") + '<div class="legend-row"><span class="legend-swatch problem"></span>has problems</div>');
}

function renderReader() {
  const mainTrack = model.tracks[0];
  els.readerMainStream.innerHTML = mainTrack ? renderTrack(mainTrack, { panel: false }) : "";
  renderPanels();
}

function renderPanels(options = {}) {
  const previousRack = els.subagentPanelOverlay.querySelector(".subagent-panel-rack");
  const previousScrollLeft = previousRack ? previousRack.scrollLeft : 0;
  const openTracks = [...state.openPanelIds].map((trackId) => trackById.get(trackId)).filter(Boolean);
  const pinTrackId = options.pinTrackId || state.pendingPanelPinId || "";
  state.pendingPanelPinId = "";
  els.subagentPanelOverlay.dataset.openPanelCount = String(openTracks.length);
  els.readerLayout.dataset.openPanelCount = String(openTracks.length);
  els.subagentPanelOverlay.innerHTML = openTracks.length
    ? `<div class="subagent-panel-rack">${openTracks.map((track) => renderTrack(track, { panel: true })).join("")}</div>`
    : "";
  updateSubagentPanelOverlayWidth(openTracks.length);
  const nextRack = els.subagentPanelOverlay.querySelector(".subagent-panel-rack");
  if (nextRack) {
    nextRack.scrollLeft = previousScrollLeft;
    requestAnimationFrame(() => {
      nextRack.scrollLeft = previousScrollLeft;
      if (pinTrackId) pinSubagentPanelIntoView(pinTrackId, options.instant);
    });
  }
}

function pinSubagentPanelIntoView(trackId, instant = false) {
  const rack = els.subagentPanelOverlay.querySelector(".subagent-panel-rack");
  const panel = rack?.querySelector(`.subagent-panel[data-agent-id="${cssEscape(trackId)}"]`);
  if (!rack || !panel) return;
  const rackRect = rack.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const inset = 14;
  let delta = 0;
  if (panelRect.right > rackRect.right - inset) {
    delta = panelRect.right - (rackRect.right - inset);
  } else if (panelRect.left < rackRect.left + inset) {
    delta = panelRect.left - (rackRect.left + inset);
  }
  if (Math.abs(delta) < 1) return;
  rack.scrollBy({ left: delta, behavior: instant ? "auto" : "smooth" });
}

function getGoldenRatioMainMinWidth(layoutWidth, configuredMinWidth) {
  if (!layoutWidth) return configuredMinWidth;
  return layoutWidth * GOLDEN_REMAINDER;
}

function getGoldenRatioMainMaxWidth(layoutWidth) {
  if (!layoutWidth) return 0;
  return layoutWidth * GOLDEN_SECTION;
}

function updateMainStreamMaxWidth(wrapper = els.readerLayout, rackWidth = null) {
  if (!wrapper) return null;
  const styles = window.getComputedStyle(wrapper);
  const wrapperWidth = wrapper.clientWidth || wrapper.getBoundingClientRect().width || 0;
  const configuredMainMinWidth = parseFloat(styles.getPropertyValue("--main-stream-min-width")) || 420;
  const mainMinWidth = getGoldenRatioMainMinWidth(wrapperWidth, configuredMainMinWidth);
  const mainMaxWidth = getGoldenRatioMainMaxWidth(wrapperWidth);
  const measuredRackWidth = rackWidth ?? els.subagentPanelOverlay?.getBoundingClientRect().width ?? 0;
  const mainViewportWidth = Math.max(0, wrapperWidth - measuredRackWidth);
  const mainStreamWidth = Math.min(mainMaxWidth, mainViewportWidth);
  const mainStreamLeft = Math.max(0, (mainViewportWidth - mainStreamWidth) / 2);
  if (Number.isFinite(mainMinWidth) && mainMinWidth > 0) {
    wrapper.style.setProperty("--main-stream-min-width", `${mainMinWidth.toFixed(1)}px`);
    wrapper.style.setProperty("--main-viewport-min-width", `${mainMinWidth.toFixed(1)}px`);
  } else {
    wrapper.style.removeProperty("--main-stream-min-width");
    wrapper.style.removeProperty("--main-viewport-min-width");
  }
  if (Number.isFinite(mainMaxWidth) && mainMaxWidth > 0) {
    wrapper.style.setProperty("--main-stream-max-width", `${mainMaxWidth.toFixed(1)}px`);
    wrapper.style.setProperty("--main-stream-width", `${mainStreamWidth.toFixed(1)}px`);
    wrapper.style.setProperty("--main-stream-left", `${mainStreamLeft.toFixed(1)}px`);
  } else {
    wrapper.style.removeProperty("--main-stream-max-width");
    wrapper.style.removeProperty("--main-stream-width");
    wrapper.style.removeProperty("--main-stream-left");
  }
  return { wrapperWidth, mainMinWidth, mainMaxWidth, mainViewportWidth, mainStreamWidth, mainStreamLeft };
}

function getSubagentPanelOverlayMetrics(openPanelCount) {
  const wrapper = els.readerLayout;
  const wrapperWidth = wrapper?.clientWidth || wrapper?.getBoundingClientRect().width || 0;
  const styles = window.getComputedStyle(wrapper || els.subagentPanelOverlay);
  const panelWidth = parseFloat(styles.getPropertyValue("--subagent-panel-width")) || 520;
  const panelMinWidth = parseFloat(styles.getPropertyValue("--subagent-panel-min-width")) || 320;
  const panelGap = parseFloat(styles.getPropertyValue("--agent-stream-panel-gap")) || 14;
  const configuredMainMinWidth = parseFloat(styles.getPropertyValue("--main-stream-min-width")) || 420;

  if (!openPanelCount || !wrapperWidth) return null;

  const mainMinWidth = getGoldenRatioMainMinWidth(wrapperWidth, configuredMainMinWidth);
  const mainMaxWidth = getGoldenRatioMainMaxWidth(wrapperWidth);
  const layoutableWidth = Math.max(0, wrapperWidth - mainMinWidth);
  const targetWidth = openPanelCount * panelWidth + Math.max(0, openPanelCount - 1) * panelGap;
  const canLayoutPanel = layoutableWidth >= panelMinWidth;
  const maxWidth = layoutableWidth;
  const minWidth = Math.min(panelMinWidth, maxWidth);

  return {
    wrapper,
    wrapperWidth,
    panelGap,
    panelMinWidth,
    mainMinWidth,
    mainMaxWidth,
    canLayoutPanel,
    hasPanelOverflow: targetWidth > layoutableWidth,
    canResizePanels: canLayoutPanel,
    layoutableWidth,
    targetWidth,
    minWidth,
    maxWidth,
  };
}

function updateSubagentPanelLayoutReadyState(metrics) {
  const canLayoutPanel = Boolean(metrics?.canLayoutPanel);
  const hasPanelOverflow = Boolean(metrics?.hasPanelOverflow);
  const canResizePanels = Boolean(metrics?.canResizePanels);
  els.subagentPanelOverlay.dataset.layoutReady = canLayoutPanel ? "true" : "false";
  els.subagentPanelOverlay.dataset.panelOverflow = hasPanelOverflow ? "true" : "false";
  els.subagentPanelOverlay.dataset.panelResizable = canResizePanels ? "true" : "false";
  els.readerLayout.dataset.subagentPanelLayoutReady = canLayoutPanel ? "true" : "false";
  els.readerLayout.dataset.subagentPanelOverflow = hasPanelOverflow ? "true" : "false";
  els.readerLayout.dataset.subagentPanelResizable = canResizePanels ? "true" : "false";
  if (Number.isFinite(metrics?.mainMinWidth)) {
    els.readerLayout.style.setProperty("--main-stream-min-width", `${metrics.mainMinWidth.toFixed(1)}px`);
    els.readerLayout.style.setProperty("--main-viewport-min-width", `${metrics.mainMinWidth.toFixed(1)}px`);
  } else {
    els.readerLayout.style.removeProperty("--main-stream-min-width");
    els.readerLayout.style.removeProperty("--main-viewport-min-width");
  }
  if (Number.isFinite(metrics?.mainMaxWidth)) {
    els.readerLayout.style.setProperty("--main-stream-max-width", `${metrics.mainMaxWidth.toFixed(1)}px`);
  } else {
    updateMainStreamMaxWidth();
  }
}

function updateSubagentSeparatorState(width, metrics) {
  const separator = els.agentStreamSeparator;
  if (!separator || !metrics?.canResizePanels) {
    separator?.removeAttribute("aria-valuemin");
    separator?.removeAttribute("aria-valuemax");
    separator?.removeAttribute("aria-valuenow");
    separator?.removeAttribute("aria-valuetext");
    return;
  }
  separator.setAttribute("aria-valuemin", String(Math.round(metrics.minWidth)));
  separator.setAttribute("aria-valuemax", String(Math.round(metrics.maxWidth)));
  separator.setAttribute("aria-valuenow", String(Math.round(width)));
  separator.setAttribute("aria-valuetext", `Subagent panels ${Math.round(width)} pixels wide`);
}

function updateSubagentPanelOverlayWidth(openPanelCount = Number(els.subagentPanelOverlay.dataset.openPanelCount || 0)) {
  const metrics = getSubagentPanelOverlayMetrics(openPanelCount);
  updateSubagentPanelLayoutReadyState(metrics);

  if (!metrics) {
    els.subagentPanelOverlay.style.setProperty("--subagent-panel-rack-width", "0px");
    els.readerLayout.style.setProperty("--subagent-panel-rack-width", "0px");
    updateMainStreamMaxWidth(els.readerLayout, 0);
    updateSubagentSeparatorState(0, null);
    return;
  }

  const hasManualWidth = Number.isFinite(state.subagentPanelRackWidthOverride);
  const nextWidth = metrics.canLayoutPanel
    ? hasManualWidth
      ? clamp(state.subagentPanelRackWidthOverride, metrics.minWidth, metrics.maxWidth)
      : Math.min(metrics.maxWidth, Math.max(metrics.minWidth, metrics.targetWidth))
    : 0;

  if (hasManualWidth && metrics.canResizePanels) state.subagentPanelRackWidthOverride = nextWidth;
  els.subagentPanelOverlay.style.setProperty("--subagent-panel-rack-width", `${nextWidth.toFixed(1)}px`);
  els.readerLayout.style.setProperty("--subagent-panel-rack-width", `${nextWidth.toFixed(1)}px`);
  updateMainStreamMaxWidth(els.readerLayout, nextWidth);
  updateSubagentSeparatorState(nextWidth, metrics);
}

function setSubagentPanelRackWidthOverride(width, options = {}) {
  const openPanelCount = Number(els.subagentPanelOverlay.dataset.openPanelCount || 0);
  const metrics = getSubagentPanelOverlayMetrics(openPanelCount);
  if (!metrics?.canResizePanels) return null;
  const nextWidth = clamp(width, metrics.minWidth, metrics.maxWidth);
  state.subagentPanelRackWidthOverride = nextWidth;
  updateSubagentPanelOverlayWidth(openPanelCount);
  if (options.persist) {
    // Manual resizing is intentionally page-session scoped.
  }
  return nextWidth;
}

function startSubagentSeparatorResize(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const openPanelCount = Number(els.subagentPanelOverlay.dataset.openPanelCount || 0);
  const metrics = getSubagentPanelOverlayMetrics(openPanelCount);
  if (!metrics?.canResizePanels) return;

  event.preventDefault();
  event.stopPropagation();
  state.subagentSeparatorResizeState = {
    pointerId: event.pointerId,
    moveEventName: event.type === "mousedown" ? "mousemove" : "pointermove",
    endEventName: event.type === "mousedown" ? "mouseup" : "pointerup",
    cancelEventName: event.type === "mousedown" ? "mouseleave" : "pointercancel",
    startX: event.clientX,
    startWidth: els.subagentPanelOverlay.getBoundingClientRect().width,
  };

  els.agentStreamSeparator.classList.add("dragging");
  els.agentStreamSeparator.setAttribute("aria-grabbed", "true");
  if (event.pointerId !== undefined) els.agentStreamSeparator.setPointerCapture?.(event.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.addEventListener(state.subagentSeparatorResizeState.moveEventName, handleSubagentSeparatorResizeMove, { passive: false });
  document.addEventListener(state.subagentSeparatorResizeState.endEventName, finishSubagentSeparatorResize);
  document.addEventListener(state.subagentSeparatorResizeState.cancelEventName, finishSubagentSeparatorResize);
}

function handleSubagentSeparatorResizeMove(event) {
  const resizeState = state.subagentSeparatorResizeState;
  if (!resizeState) return;
  event.preventDefault();
  const deltaX = event.clientX - resizeState.startX;
  setSubagentPanelRackWidthOverride(resizeState.startWidth - deltaX, { persist: false });
}

function finishSubagentSeparatorResize(event = null) {
  const resizeState = state.subagentSeparatorResizeState;
  if (!resizeState) return;
  if (event?.clientX !== undefined) {
    const deltaX = event.clientX - resizeState.startX;
    setSubagentPanelRackWidthOverride(resizeState.startWidth - deltaX, { persist: false });
  }
  els.agentStreamSeparator.classList.remove("dragging");
  els.agentStreamSeparator.removeAttribute("aria-grabbed");
  if (resizeState.pointerId !== undefined) els.agentStreamSeparator.releasePointerCapture?.(resizeState.pointerId);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.removeEventListener(resizeState.moveEventName, handleSubagentSeparatorResizeMove);
  document.removeEventListener(resizeState.endEventName, finishSubagentSeparatorResize);
  document.removeEventListener(resizeState.cancelEventName, finishSubagentSeparatorResize);
  state.subagentSeparatorResizeState = null;
}

function handleSubagentSeparatorKeydown(event) {
  const openPanelCount = Number(els.subagentPanelOverlay.dataset.openPanelCount || 0);
  const metrics = getSubagentPanelOverlayMetrics(openPanelCount);
  if (!metrics?.canResizePanels) return;
  const currentWidth = els.subagentPanelOverlay.getBoundingClientRect().width;
  const step = event.shiftKey ? 80 : 24;
  let nextWidth = null;
  if (event.key === "ArrowLeft") nextWidth = currentWidth + step;
  if (event.key === "ArrowRight") nextWidth = currentWidth - step;
  if (event.key === "Home") nextWidth = metrics.maxWidth;
  if (event.key === "End") nextWidth = metrics.minWidth;
  if (nextWidth === null) return;
  event.preventDefault();
  event.stopPropagation();
  setSubagentPanelRackWidthOverride(nextWidth, { persist: true });
}

function bindSubagentSeparatorResize() {
  if (!els.agentStreamSeparator || els.agentStreamSeparator.dataset.resizeBound === "true") return;
  els.agentStreamSeparator.dataset.resizeBound = "true";
  els.agentStreamSeparator.addEventListener("keydown", handleSubagentSeparatorKeydown);
  if (window.PointerEvent) {
    els.agentStreamSeparator.addEventListener("pointerdown", startSubagentSeparatorResize, { passive: false });
  } else {
    els.agentStreamSeparator.addEventListener("mousedown", startSubagentSeparatorResize, { passive: false });
  }
}

function renderTrack(track, options = {}) {
  const panel = Boolean(options.panel);
  const title = trackTitle(track);
  return `
    <section class="reader-track ${track.depth === 0 ? "main-track" : "subagent-track"} ${panel ? "subagent-panel" : ""}" id="track-${domId(track.id)}" data-agent-id="${escAttr(track.id)}" data-track-kind="${track.depth === 0 ? "main" : "subagent"}">
      <header class="reader-track-header">
        <div>
          <div class="agent-track-kicker">${track.depth === 0 ? "main agent" : "subagent"}</div>
          <h2 title="${escAttr(title)}">${esc(title)}</h2>
        </div>
        <div class="agent-track-actions">
          <span class="count-pill">${track.messages.length} messages</span>
          ${track.problemCount ? `<span class="problem-pill">${track.problemCount} problems</span>` : ""}
          ${panel ? `<button class="agent-panel-close" data-action="close-panel" data-track-id="${escAttr(track.id)}" aria-label="Close ${escAttr(title)}">x</button>` : ""}
        </div>
        ${renderAgentConnector(track)}
      </header>
      <div class="reader-track-body">
        ${track.messages.length ? track.messages.map((message, index) => renderReaderMessage(message, track, index)).join("") : '<div class="agent-track-empty">No messages in this transcript.</div>'}
      </div>
    </section>`;
}

function renderAgentConnector(track) {
  if (!track.parentTaskNav) return "";
  const parentKey = navKeyToCapsuleKey.get(navKey(track.parentTaskNav));
  const resultKey = navKeyToCapsuleKey.get(navKey(track.parentResultNav));
  const parent = parentKey ? capsuleByKey.get(parentKey) : null;
  return `
    <div class="agent-connector" data-source-agent-id="${escAttr(track.parentTrackId || "main")}" data-subagent-id="${escAttr(track.id)}">
      <button type="button" class="agent-connector-node parent" data-action="focus-capsule" data-capsule-key="${escAttr(parentKey || "")}">
        <span class="agent-connector-label">parent message</span>
        <span class="agent-connector-value">${parent ? parent.messageIndex + 1 : "unknown"}</span>
      </button>
      <button type="button" class="agent-connector-node first" data-action="focus-capsule" data-capsule-key="${escAttr(track.firstCapsuleKey)}">
        <span class="agent-connector-label">first message</span>
        <span class="agent-connector-value">${track.messages.length ? "1" : "none"}</span>
      </button>
      ${resultKey ? `<button type="button" class="agent-connector-node result" data-action="focus-capsule" data-capsule-key="${escAttr(resultKey)}"><span class="agent-connector-label">result</span><span class="agent-connector-value">open</span></button>` : ""}
    </div>`;
}

function renderReaderMessage(message, track, index) {
  const key = navKeyToCapsuleKey.get(navKey(message.nav)) || "";
  const capsule = key ? capsuleByKey.get(key) : null;
  const problems = capsule?.problems || [];
  return `
    <article class="reader-message ${escAttr(message.role || "message")} ${problems.length ? "has-problem" : ""} ${key === state.currentCapsuleKey ? "active" : ""}" id="${readerMessageId(track.id, index)}" data-agent-id="${escAttr(track.id)}" data-message-index="${index}" data-capsule-key="${escAttr(key)}" data-testid="transcript-message">
      <div class="message-gutter">
        <span class="role-dot"></span>
        <span>${index + 1}</span>
      </div>
      <div class="message-card">
        <header class="message-header">
          <div class="message-header-left">
            <span class="role-badge ${escAttr(message.role || "message")}">${esc(message.role || "message")}</span>
            <span class="message-meta">
              ${message.time_created ? `<span>${esc(formatFullTime(message.time_created))}</span>` : ""}
              ${message.modelID ? `<span>${esc(message.modelID)}</span>` : ""}
              ${message.agent ? `<span>${esc(message.agent)}</span>` : ""}
              ${problems.length ? `<span class="problem-tag">${problems.length} problems</span>` : ""}
            </span>
          </div>
        </header>
        <div class="message-body">
          ${(message.parts || []).map((part, partIndex) => renderPart(part, { track, message, messageIndex: index, partIndex })).join("") || '<span class="muted">(no content)</span>'}
        </div>
      </div>
    </article>`;
}

function renderPart(part, context) {
  const key = rememberNav(part.nav);
  const style = part.type === "tool_result" ? "tool-result" : part.type === "tool" ? "tool" : part.type || "part";
  const testId = part.type === "tool_result" ? "tool-result" : part.type === "tool" ? "tool-call" : "transcript-part";
  const childTrack = childTrackByParentTaskKey.get(navKey(part.nav));
  const pairedKey = navKeyToCapsuleKey.get(navKey(pairedNav(part))) || "";
  const partBody = part.type === "tool" || part.type === "tool_result"
    ? `<pre>${esc(partText(part) || "(no payload)")}</pre>`
    : `<div class="part-text">${esc(partText(part) || "")}</div>`;
  return `
    <section class="reader-part ${escAttr(style)} ${part.state?.is_error ? "error" : ""}" data-nav-key="${escAttr(key)}" data-testid="${testId}">
      <header class="part-header">
        <strong>${esc(part.type === "tool" ? part.tool || "tool" : typeStyle(part.type).label || part.type)}</strong>
        <div class="part-actions">
          ${part.nav?.toolUseId ? `<span class="tag">${esc(part.nav.toolUseId)}</span>` : ""}
          ${pairedKey ? `<button data-action="focus-capsule" data-capsule-key="${escAttr(pairedKey)}">${part.type === "tool" ? "Result" : "Call"}</button>` : ""}
        </div>
      </header>
      ${partBody}
      ${childTrack ? renderSpawnReference(childTrack, context) : ""}
    </section>`;
}

function renderSpawnReference(track) {
  return `
    <div class="spawn-reference" data-linked-agent-id="${escAttr(track.id)}">
      <div>
        <strong>${esc(trackTitle(track))}</strong>
        <small>${esc(track.agentType)} · ${track.messages.length} messages${track.relationship ? ` · ${track.relationship}` : ""}</small>
      </div>
      <div class="part-actions">
        <button data-action="open-panel" data-track-id="${escAttr(track.id)}">Open subagent</button>
        <button data-action="focus-capsule" data-capsule-key="${escAttr(track.firstCapsuleKey)}">Jump to first</button>
      </div>
    </div>`;
}

function pairedNav(part) {
  const toolId = part?.nav?.toolUseId || part?.state?.tool_use_id || part?.id || "";
  if (!toolId) return null;
  const scoped = scopedToolKey(part.nav, toolId);
  if (part.type === "tool") return toolResultByScopedId.get(scoped) || null;
  if (part.type === "tool_result") return toolCallByScopedId.get(scoped) || null;
  return null;
}

function setLayout(layout, options = {}) {
  state.layout = layout === "graph" ? "graph" : "reader";
  els.workbench.dataset.layout = state.layout;
  els.readerLayout.classList.toggle("hidden", state.layout !== "reader");
  els.graphLayout.classList.toggle("hidden", state.layout !== "graph");
  els.graphLegendSection.classList.toggle("hidden", state.layout !== "graph");
  els.layoutButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.layout === state.layout));
  });
  if (state.layout === "graph") {
    els.readerMainStream.innerHTML = "";
    els.subagentPanelOverlay.innerHTML = "";
    els.subagentPanelOverlay.dataset.openPanelCount = "0";
    els.readerLayout.dataset.openPanelCount = "0";
    updateSubagentPanelOverlayWidth(0);
    renderMessageIndex();
    scheduleGraphRender();
  } else if (!els.readerMainStream.children.length) {
    renderReader();
    renderMessageIndex();
    renderReaderActiveState();
  } else if (state.layout === "reader") {
    updateSubagentPanelOverlayWidth();
  }
  if (options.history !== false) {
    const url = new URL(location.href);
    if (state.layout === "graph") url.searchParams.set("layout", "graph");
    else url.searchParams.delete("layout");
    history.pushState(historyState(), "", url);
  }
  renderBreadcrumb();
  updateNavigationButtons();
}

function scheduleGraphRender() {
  if (state.graphFrame !== null) cancelAnimationFrame(state.graphFrame);
  state.graphFrame = requestAnimationFrame(() => {
    state.graphFrame = null;
    renderGraphVirtual();
  });
}

function graphGroupSize(viewWidth, visibleLaneCount) {
  const estimated = visibleLaneCount * Math.ceil((viewWidth + 600) / model.capsuleStep);
  const target = 4200;
  if (estimated <= target) return 1;
  const needed = Math.ceil(estimated / target);
  return 2 ** Math.ceil(Math.log2(needed));
}

function renderGraphVirtual() {
  if (state.layout !== "graph") return;
  const viewport = els.graphViewport;
  const viewLeft = viewport.scrollLeft;
  const viewTop = viewport.scrollTop;
  const viewRight = viewLeft + viewport.clientWidth;
  const viewBottom = viewTop + viewport.clientHeight;
  const overscanX = 320;
  const overscanY = 180;
  const visibleTracks = model.tracks.filter((track) => track.y + model.laneHeight >= viewTop - overscanY && track.y <= viewBottom + overscanY);
  const groupSize = graphGroupSize(viewport.clientWidth, visibleTracks.length);

  els.graphSizer.style.width = `${model.width}px`;
  els.graphSizer.style.height = `${model.height}px`;
  els.graphLayer.style.width = `${model.width}px`;
  els.graphLayer.style.height = `${model.height}px`;
  els.graphEdges.setAttribute("width", String(model.width));
  els.graphEdges.setAttribute("height", String(model.height));
  els.graphEdges.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);

  els.graphLanes.innerHTML = compactHtml(visibleTracks
    .map((track) => `
      <div class="graph-lane-row" style="left:0px;top:${track.y}px;width:${model.width}px;height:${model.laneHeight}px">
        <button class="graph-lane-label ${track.problemCount ? "has-problem" : ""}" data-action="select-track" data-track-id="${escAttr(track.id)}" style="left:${viewLeft + 10 + track.depth * 14}px">
          <strong>${esc(compact(trackTitle(track), 42))}</strong>
          <small>${esc(track.agentType)} · ${track.capsuleKeys.length} messages${track.problemCount ? ` · ${track.problemCount} problems` : ""}</small>
        </button>
      </div>`)
    .join(""));

  const capsuleHtml = [];
  const rangeStart = Math.max(0, Math.floor((viewLeft - overscanX - model.headerWidth) / model.capsuleStep));
  const rangeEnd = Math.ceil((viewRight + overscanX - model.headerWidth) / model.capsuleStep);
  visibleTracks.forEach((track) => {
    const start = Math.max(0, Math.floor(rangeStart / groupSize) * groupSize);
    const end = Math.min(track.capsuleKeys.length - 1, rangeEnd);
    for (let index = start; index <= end; index += groupSize) {
      const keys = track.capsuleKeys.slice(index, Math.min(index + groupSize, track.capsuleKeys.length));
      if (!keys.length) continue;
      const first = capsuleByKey.get(keys[0]);
      const last = capsuleByKey.get(keys[keys.length - 1]);
      if (!first || !last) continue;
      if (last.x + last.width < viewLeft - overscanX || first.x > viewRight + overscanX) continue;
      const problems = keys.reduce((sum, key) => sum + (capsuleByKey.get(key)?.problemCount || 0), 0);
      const active = keys.includes(state.currentCapsuleKey);
      const selected = keys.some((key) => state.selectedGraphKeys.has(key));
      const type = groupSize === 1 ? first.type : "mixed";
      const style = typeStyle(type);
      const width = Math.max(model.capsuleWidth, last.x + last.width - first.x);
      capsuleHtml.push(`
        <button class="graph-capsule ${style.className} ${active ? "active" : ""} ${selected ? "selected" : ""} ${problems ? "has-problem" : ""}" data-action="graph-capsule" data-capsule-key="${escAttr(first.key)}" data-group-size="${keys.length}" data-testid="graph-capsule" style="left:${first.x}px;top:${first.y}px;width:${width}px;height:${first.height}px" title="${escAttr(groupSize === 1 ? `${style.label}: ${first.summary}` : `${keys.length} messages from ${trackTitle(track)}`)}" aria-label="${escAttr(groupSize === 1 ? `${style.label}: ${first.summary}` : `${keys.length} message group`)}">
          ${problems ? '<span class="problem-marker"></span>' : ""}
        </button>`);
    }
  });
  els.graphCapsules.innerHTML = compactHtml(capsuleHtml.join(""));
  els.graphEdges.innerHTML = renderVisibleEdges(viewLeft - overscanX, viewTop - overscanY, viewRight + overscanX, viewBottom + overscanY);
  renderGraphStatus();
}

function capsuleInView(capsule, left, top, right, bottom) {
  if (!capsule) return false;
  return capsule.x + capsule.width >= left && capsule.x <= right && capsule.y + capsule.height >= top && capsule.y <= bottom;
}

function renderVisibleEdges(left, top, right, bottom) {
  const edgeMap = new Map();
  model.spawnEdges.forEach((edge) => edgeMap.set(`${edge.sourceKey}:${edge.targetKey}:${edge.type}`, edge));
  state.selectedGraphKeys.forEach((key) => {
    (edgesByCapsuleKey.get(key) || []).forEach((edge) => {
      if (edge.type !== "sequence") edgeMap.set(`${key}:${edge.targetKey}:${edge.type}`, { ...edge, sourceKey: key });
    });
  });
  if (state.currentCapsuleKey) {
    (edgesByCapsuleKey.get(state.currentCapsuleKey) || []).forEach((edge) => {
      if (edge.type !== "sequence") edgeMap.set(`${state.currentCapsuleKey}:${edge.targetKey}:${edge.type}`, { ...edge, sourceKey: state.currentCapsuleKey });
    });
  }
  return [...edgeMap.values()]
    .map((edge) => {
      const source = capsuleByKey.get(edge.sourceKey);
      const target = capsuleByKey.get(edge.targetKey);
      if (!source || !target) return "";
      const selected = edge.sourceKey === state.currentCapsuleKey || edge.targetKey === state.currentCapsuleKey || state.selectedGraphKeys.has(edge.sourceKey) || state.selectedGraphKeys.has(edge.targetKey);
      if (!selected && !capsuleInView(source, left, top, right, bottom) && !capsuleInView(target, left, top, right, bottom)) return "";
      const sx = source.x + source.width;
      const sy = source.y + source.height / 2;
      const tx = target.x;
      const ty = target.y + target.height / 2;
      const curve = Math.max(50, Math.min(180, Math.abs(tx - sx) / 2));
      return `<path class="graph-edge ${escAttr(edge.type)} ${selected ? "selected" : ""}" d="M ${sx} ${sy} C ${sx + curve} ${sy - 28}, ${tx - curve} ${ty - 28}, ${tx} ${ty}" />`;
    })
    .join("");
}

function renderGraphStatus() {
  if (state.selectedGraphKeys.size > 1) {
    els.graphStatus.textContent = `${state.selectedGraphKeys.size} transcript elements selected`;
    return;
  }
  const capsule = selectedCapsule();
  els.graphStatus.textContent = capsule
    ? `${typeStyle(capsule.type).label} · ${capsule.nav?.agentPath || "main"} · ${capsule.summary}${capsule.problemCount ? ` · ${capsule.problemCount} problems` : ""}`
    : "";
}

function scrollGraphCapsuleIntoView(capsule, instant = false) {
  if (!capsule) return;
  els.graphViewport.scrollTo({
    left: Math.max(0, capsule.x - els.graphViewport.clientWidth * 0.45),
    top: Math.max(0, capsule.y - els.graphViewport.clientHeight * 0.45),
    behavior: instant ? "auto" : "smooth",
  });
}

function scrollReaderCapsuleIntoView(capsule, instant = false) {
  if (!capsule || capsule.rawOnly) return;
  const track = trackById.get(capsule.trackId);
  if (!track) return;
  if (track.depth > 0 && !state.openPanelIds.has(track.id)) {
    state.openPanelIds.add(track.id);
    renderLeftNavigation();
    renderPanels({ pinTrackId: track.id, instant });
  }
  requestAnimationFrame(() => {
    const element = document.getElementById(readerMessageId(track.id, capsule.messageIndex));
    if (!element) return;
    const container = track.depth === 0 ? els.mainContent : element.closest(".subagent-panel");
    if (container && track.depth > 0) {
      container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * 0.35);
      return;
    }
    element.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "center", inline: "nearest" });
  });
}

function focusCapsule(key, options = {}) {
  const capsule = capsuleByKey.get(key);
  if (!capsule) return;
  if (state.currentCapsuleKey !== key) pushBackNavigation(options);
  state.currentCapsuleKey = key;
  state.selectedTrackId = capsule.trackId;
  if (!options.multi) state.selectedGraphKeys = new Set([key]);
  setLinkStatus("");
  renderLeftNavigation();
  renderReaderActiveState();
  scheduleGraphRender();
  if (options.scroll !== false) {
    if (state.layout === "graph") scrollGraphCapsuleIntoView(capsule, options.instant);
    else scrollReaderCapsuleIntoView(capsule, options.instant);
  }
  renderBreadcrumb();
  renderGraphStatus();
  updateNavigationButtons();
  if (options.history !== false) history.pushState(historyState(), "", urlForHash(hashFor(key)));
}

function toggleGraphSelection(key, event) {
  if (event.metaKey || event.ctrlKey) {
    if (state.selectedGraphKeys.has(key)) state.selectedGraphKeys.delete(key);
    else state.selectedGraphKeys.add(key);
    if (!state.currentCapsuleKey) state.currentCapsuleKey = key;
    renderBreadcrumb();
    renderGraphStatus();
    scheduleGraphRender();
    return;
  }
  state.selectedGraphKeys = new Set([key]);
  focusCapsule(key);
}

function renderReaderActiveState() {
  document.querySelectorAll(".reader-message.active").forEach((node) => node.classList.remove("active"));
  const capsule = selectedCapsule();
  if (!capsule) return;
  const element = document.getElementById(readerMessageId(capsule.trackId, capsule.messageIndex));
  if (element) element.classList.add("active");
}

function focusMessage(trackId, index) {
  const track = trackById.get(trackId);
  const message = track?.messages[index];
  const key = navKeyToCapsuleKey.get(navKey(message?.nav));
  if (key) focusCapsule(key);
}

function selectTrack(trackId, options = {}) {
  const track = trackById.get(trackId);
  if (!track) return;
  const wasSelected = state.selectedTrackId === trackId;
  const wasOpen = state.openPanelIds.has(trackId);
  state.selectedTrackId = trackId;
  const shouldOpen = track.depth > 0 && options.open !== false;
  const openChanged = shouldOpen && !wasOpen;
  if (shouldOpen) {
    state.openPanelIds.add(trackId);
    if (openChanged) state.pendingPanelPinId = trackId;
  }
  renderLeftNavigation();
  if (openChanged) renderPanels({ pinTrackId: trackId, instant: options.instant });
  if (track.firstCapsuleKey && options.focus !== false && !wasSelected) {
    focusCapsule(track.firstCapsuleKey, { scroll: true });
  } else {
    renderReaderActiveState();
    renderBreadcrumb();
    renderGraphStatus();
    updateNavigationButtons();
  }
}

function closePanel(trackId) {
  state.openPanelIds.delete(trackId);
  if (state.selectedTrackId === trackId) {
    const mainTrack = model.tracks[0];
    state.selectedTrackId = mainTrack?.id || "main";
    if (mainTrack?.firstCapsuleKey) {
      state.currentCapsuleKey = mainTrack.firstCapsuleKey;
      state.selectedGraphKeys = new Set([mainTrack.firstCapsuleKey]);
    }
  }
  renderLeftNavigation();
  renderPanels();
  renderReaderActiveState();
  renderBreadcrumb();
  renderGraphStatus();
}

function togglePanel(trackId) {
  const track = trackById.get(trackId);
  if (!track || track.depth === 0) {
    selectTrack(trackId, { open: false });
    return;
  }
  if (state.openPanelIds.has(trackId)) closePanel(trackId);
  else selectTrack(trackId, { open: true });
}

function renderBreadcrumb() {
  const capsule = selectedCapsule();
  const nav = currentNav();
  const parts = ["Sessions", SESSION_DATA.summary?.title || "Session"];
  if (state.layout === "graph") parts.push("Overview");
  else parts.push("Focus");
  if (nav?.agentPath) parts.push(...nav.agentPath.split("/"));
  if (capsule) parts.push(typeStyle(capsule.type).label);
  els.breadcrumb.innerHTML = compactHtml(parts
    .filter(Boolean)
    .map((part, index) => `<span class="crumb${index === parts.length - 1 ? " current" : ""}">${esc(part)}</span>`)
    .join(""));
}

function restoreNavigationSnapshot(item) {
  if (!item) return;
  setLayout(item.layout || state.layout, { history: false });
  state.selectedTrackId = item.selectedTrackId || state.selectedTrackId;
  if (item.key && capsuleByKey.has(item.key)) {
    focusCapsule(item.key, { push: false, history: false, scroll: true, instant: true });
  }
  renderLeftNavigation();
  renderBreadcrumb();
  renderGraphStatus();
  replaceCurrentHistoryState();
  updateNavigationButtons();
}

function returnToPrevious() {
  const item = state.backStack.pop();
  if (!item) return;
  state.forwardStack.push(navigationSnapshot());
  restoreNavigationSnapshot(item);
}

function forwardToReturned() {
  const item = state.forwardStack.pop();
  if (!item) return;
  state.backStack.push(navigationSnapshot());
  restoreNavigationSnapshot(item);
}

function hashFor(key) {
  return `#${encodeURIComponent(key)}`;
}

function urlForHash(hash) {
  const url = new URL(location.href);
  url.hash = hash.slice(1);
  return url;
}

function historyState(extra = {}) {
  return {
    layout: state.layout,
    capsuleKey: state.currentCapsuleKey,
    nav: currentNav(),
    graphScroll: { left: els.graphViewport.scrollLeft, top: els.graphViewport.scrollTop },
    readerScroll: { top: els.mainContent.scrollTop },
    ...extra,
  };
}

function replaceCurrentHistoryState(extra = {}) {
  history.replaceState(historyState(extra), "", location.href);
}

function restoreHashTarget() {
  if (!location.hash) return false;
  let decoded = decodeURIComponent(location.hash.slice(1));
  if (decoded.startsWith("raw:")) {
    decoded = decoded.slice(4);
  }
  if (decoded.startsWith("problem:")) {
    const id = decoded.slice(8);
    const problem = problemsById.get(id);
    const key = navKeyToCapsuleKey.get(navKey(problem?.nav));
    if (key) focusCapsule(key, { push: false, history: false, instant: true });
    else setLinkStatus("Linked problem target is no longer available for this session.");
    return true;
  }
  const capsuleKey = navKeyToCapsuleKey.get(decoded) || decoded;
  if (capsuleByKey.has(capsuleKey)) focusCapsule(capsuleKey, { push: false, history: false, instant: true });
  else setLinkStatus("Linked transcript target is no longer available for this session.");
  return true;
}

function copyText(value) {
  navigator.clipboard?.writeText(value);
  setLinkStatus("Copied link");
  if (state.linkStatusTimer) clearTimeout(state.linkStatusTimer);
  state.linkStatusTimer = setTimeout(() => {
    setLinkStatus("");
    state.linkStatusTimer = null;
  }, 1600);
}

function layoutMetrics() {
  const styles = window.getComputedStyle(els.readerLayout);
  const layoutRect = els.readerLayout.getBoundingClientRect();
  const mainRect = els.mainContent.getBoundingClientRect();
  const streamRect = els.readerMainStream.getBoundingClientRect();
  const overlayRect = els.subagentPanelOverlay.getBoundingClientRect();
  const rack = els.subagentPanelOverlay.querySelector(".subagent-panel-rack");
  const rackStyles = rack ? window.getComputedStyle(rack) : null;
  const streamCenter = streamRect.left + streamRect.width / 2;
  const mainCenter = mainRect.left + mainRect.width / 2;
  return {
    layoutWidth: layoutRect.width,
    mainContentWidth: mainRect.width,
    mainViewportWidth: mainRect.width,
    mainContentLeft: mainRect.left,
    mainStreamWidth: streamRect.width,
    mainStreamLeft: streamRect.left,
    mainStreamRight: streamRect.right,
    mainStreamCenter: streamCenter,
    mainViewportCenter: mainCenter,
    mainStreamCenterDelta: streamCenter - mainCenter,
    mainStreamClippedLeft: streamRect.left < mainRect.left - 1,
    mainStreamClippedRight: streamRect.right > mainRect.right + 1,
    mainStreamOffset: parseFloat(styles.getPropertyValue("--main-stream-left")) || 0,
    mainMinWidth: parseFloat(styles.getPropertyValue("--main-stream-min-width")) || 0,
    mainViewportMinWidth: parseFloat(styles.getPropertyValue("--main-viewport-min-width")) || 0,
    mainMaxWidth: parseFloat(styles.getPropertyValue("--main-stream-max-width")) || 0,
    mainStreamExpectedWidth: parseFloat(styles.getPropertyValue("--main-stream-width")) || 0,
    rackWidth: overlayRect.width,
    rackLeft: overlayRect.left,
    rackScrollLeft: rack?.scrollLeft || 0,
    rackScrollWidth: rack?.scrollWidth || 0,
    rackClientWidth: rack?.clientWidth || 0,
    rackFlexDirection: rackStyles?.flexDirection || "",
    maxRackWidth: Math.max(0, layoutRect.width - (parseFloat(styles.getPropertyValue("--main-stream-min-width")) || 0)),
    openPanelCount: Number(els.subagentPanelOverlay.dataset.openPanelCount || 0),
    goldenSection: GOLDEN_SECTION,
    goldenRemainder: GOLDEN_REMAINDER,
  };
}

function exposeDebugState() {
  window.SESSION_VIEWER = {
    tracks: model.tracks,
    capsules: model.capsules.map((capsule) => ({
      key: capsule.key,
      trackId: capsule.trackId,
      type: capsule.type,
      problemCount: capsule.problemCount,
      rawOnly: capsule.rawOnly,
      nav: capsule.nav,
      x: capsule.x,
      y: capsule.y,
      width: capsule.width,
      height: capsule.height,
    })),
    spawnEdges: model.spawnEdges,
    counts: {
      tracks: model.tracks.length,
      lanes: model.tracks.length,
      capsules: model.capsules.length,
      messages: model.capsules.filter((capsule) => !capsule.rawOnly).length,
      problems: allProblems().length,
    },
    current: () => ({
      layout: state.layout,
      capsuleKey: state.currentCapsuleKey,
      selectedTrackId: state.selectedTrackId,
      selected: [...state.selectedGraphKeys],
      backCount: state.backStack.length,
      forwardCount: state.forwardStack.length,
      leftNavTab: state.leftNavTab,
      openPanels: [...state.openPanelIds],
    }),
    layoutMetrics,
  };
}

function initialize() {
  buildModels();
  state.layout = getLayoutFromUrl();
  state.selectedTrackId = model.tracks[0]?.id || "main";
  bindSubagentSeparatorResize();
  renderSessionSummary();
  renderLegend();
  renderLeftNavigation();
  renderReader();
  setLayout(state.layout, { history: false });
  setLeftNavTab("messages");
  const restored = restoreHashTarget();
  if (!restored && model.capsules.length) focusCapsule(model.capsules[0].key, { push: false, history: false, instant: true });
  exposeDebugState();
  replaceCurrentHistoryState();
}

initialize();

els.layoutButtons.forEach((button) => {
  button.addEventListener("click", () => setLayout(button.dataset.layout));
});

els.leftTabs.forEach((button) => {
  button.addEventListener("click", () => setLeftNavTab(button.dataset.leftTab));
});

els.graphViewport.addEventListener("scroll", scheduleGraphRender, { passive: true });
window.addEventListener("resize", () => {
  scheduleGraphRender();
  updateSubagentPanelOverlayWidth();
});

els.returnButton.addEventListener("click", returnToPrevious);
els.forwardButton.addEventListener("click", forwardToReturned);
document.getElementById("copyLinkBtn").addEventListener("click", () => copyText(window.location.href));

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-panel") {
    event.preventDefault();
    event.stopPropagation();
    closePanel(button.dataset.trackId);
    return;
  }
  event.preventDefault();
  if (action === "select-track") selectTrack(button.dataset.trackId);
  if (action === "toggle-panel") togglePanel(button.dataset.trackId);
  if (action === "open-panel") selectTrack(button.dataset.trackId, { open: true });
  if (action === "focus-message") focusMessage(button.dataset.trackId, Number(button.dataset.messageIndex));
  if (action === "focus-capsule") focusCapsule(button.dataset.capsuleKey);
  if (action === "graph-capsule") toggleGraphSelection(button.dataset.capsuleKey, event);
});

document.addEventListener("keydown", (event) => {
  const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName);
  if (editable) return;
  if (event.key === "Enter" && state.currentCapsuleKey && state.layout === "graph") scrollGraphCapsuleIntoView(selectedCapsule());
});

window.addEventListener("popstate", (event) => {
  const saved = event.state || {};
  setLayout(saved.layout || getLayoutFromUrl(), { history: false });
  if (saved.capsuleKey && capsuleByKey.has(saved.capsuleKey)) {
    focusCapsule(saved.capsuleKey, { push: false, history: false, instant: true });
  } else {
    restoreHashTarget();
  }
  if (saved.graphScroll) {
    els.graphViewport.scrollLeft = saved.graphScroll.left || 0;
    els.graphViewport.scrollTop = saved.graphScroll.top || 0;
  }
  if (saved.readerScroll) els.mainContent.scrollTop = saved.readerScroll.top || 0;
});

window.addEventListener("hashchange", restoreHashTarget);
