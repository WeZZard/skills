const SESSION_DATA = JSON.parse(document.getElementById("conversation-data").textContent);

const state = {
  layout: "graph",
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
  timelineHeaderKey: "",
  timelineTrackKey: "",
  timelineBlockKey: "",
  timelineDetailKey: "",
  pinnedTimelineDetailKeys: [],
  timelineDetailWindowLayout: null,
  readerRawCapsuleKey: "",
  graphStatusText: "",
  timelineHeaderRenderCount: 0,
  timelineTrackRenderCount: 0,
  timelineBlockRenderCount: 0,
  timelineDetailRenderCount: 0,
  agentTreeDrawerOpen: false,
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
const rawEventByAddress = new Map();

const model = {
  tracks: [],
  capsules: [],
  spawnEdges: [],
  width: 1200,
  height: 640,
  trackWidth: 208,
  blockWidth: 118,
  blockHeight: 26,
  blockStepY: 40,
  timelinePadLeft: 36,
  timelinePadTop: 140,
  timelinePadRight: 560,
  timelinePadBottom: 180,
  timelineLayoutVersion: 0,
  timelineLayoutViewportWidth: 0,
  timelineTrackGroupLeft: 36,
  timelineTrackSpan: 0,
};

const GOLDEN_SECTION = 0.61803398875;
const GOLDEN_REMAINDER = 1 - GOLDEN_SECTION;

const els = {
  workbench: document.querySelector(".dual-workbench"),
  commandBar: document.querySelector(".command-bar"),
  breadcrumb: document.getElementById("breadcrumb"),
  sessionInfoButton: document.getElementById("sessionInfoButton"),
  sessionInfoPopover: document.getElementById("sessionInfoPopover"),
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
  agentPaneToggle: document.getElementById("agentPaneToggle"),
  agentTreeDrawer: document.getElementById("agentTreeDrawer"),
  agentTreeDrawerClose: document.getElementById("agentTreeDrawerClose"),
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
  timelineHeader: document.getElementById("timelineHeader"),
  graphSizer: document.getElementById("graphSizer"),
  graphLayer: document.getElementById("graphLayer"),
  graphEdges: document.getElementById("graphEdges"),
  graphLanes: document.getElementById("graphLanes"),
  graphCapsules: document.getElementById("graphCapsules"),
  graphStatus: document.getElementById("graphSelectionStatus"),
  timelineDetailPanel: document.getElementById("timelineDetailPanel"),
  linkStatus: document.getElementById("linkStatus"),
};

const TIMELINE_COLORS = {
  system: "#6b7280",
  user: "#00c853",
  assistant: "#0066ff",
  attachment: "#0e7490",
  noSubtype: "#e5e7eb",
  reasoning: "#a100ff",
  toolCall: "#ff9500",
  toolResult: "#00bcd4",
};

const TYPE_STYLE = {
  system: { label: "system", className: "system", color: TIMELINE_COLORS.system },
  user: { label: "user", className: "user", color: TIMELINE_COLORS.user },
  assistant: { label: "assistant", className: "assistant", color: TIMELINE_COLORS.assistant },
  reasoning: { label: "reasoning", className: "reasoning", color: TIMELINE_COLORS.reasoning },
  tool: { label: "tool call", className: "tool", color: TIMELINE_COLORS.toolCall },
  tool_result: { label: "tool result", className: "tool-result", color: TIMELINE_COLORS.toolResult },
  image: { label: "image", className: "image", color: "#0f766e" },
  patch: { label: "patch", className: "patch", color: "#7c3aed" },
  file: { label: "file", className: "file", color: "#0f766e" },
  compaction: { label: "compaction", className: "compaction", color: "#475569" },
  "step-start": { label: "step start", className: "step-start", color: "#2563eb" },
  "step-finish": { label: "step finish", className: "step-finish", color: "#16a34a" },
  attachment: { label: "attachment", className: "attachment", color: TIMELINE_COLORS.attachment },
  raw_event: { label: "raw event", className: "raw-event", color: TIMELINE_COLORS.noSubtype },
  mixed: { label: "mixed", className: "mixed", color: TIMELINE_COLORS.system },
};

const ATTACHMENT_PREVIEW_CHARS = 300;

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
  if (isAttachmentPart(part)) return attachmentSummary(part, eventAddress(part.nav));
  if (isSystemPart(part)) return systemSummary(part, eventAddress(part.nav));
  if (window.OpenCodeRenderer?.isOpenCodePart(part)) return window.OpenCodeRenderer.openCodePartSummary(part);
  if (part.text) return part.text;
  if (part.state?.input) return text(part.state.input);
  if (part.state?.output) return text(part.state.output);
  if (part.state?.content) return text(part.state.content);
  if (part.state?.error) return text(part.state.error);
  if (part.state) return text(part.state);
  return "";
}

function humanFieldName(value) {
  return String(value || "field")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\b(Id|Url|Api|Mcp)\b/g, (match) => match.toUpperCase());
}

function structuredToolPayload(part) {
  if (part?.type !== "tool") return null;
  const input = part.state?.input;
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  const parsed = tryParseJsonText(partText(part));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return null;
}

function renderStructuredToolPayload(part) {
  const payload = structuredToolPayload(part);
  const entries = payload ? Object.entries(payload).filter(([, value]) => hasValue(value)) : [];
  if (!entries.length) return `<pre>${esc(partText(part) || "(no payload)")}</pre>`;
  return `
    <dl class="tool-payload-fields">
      ${entries.map(([key, value]) => `
        <div class="tool-payload-field tool-payload-field-${escAttr(kindClass(key))}" data-tool-field="${escAttr(key)}">
          <dt>${esc(humanFieldName(key))}</dt>
          <dd><pre class="tool-payload-value">${esc(text(value))}</pre></dd>
        </div>`).join("")}
    </dl>`;
}

function messageText(message) {
  return (message.parts || []).map(partText).filter(Boolean).join("\n");
}

function isAttachmentPart(part) {
  return part?.type === "attachment" || part?.state?.kind === "attachment_event" || part?.nav?.elementType === "attachment";
}

function isSystemPart(part) {
  return part?.type === "system" || part?.state?.kind === "system_event" || part?.nav?.elementType === "system";
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function previewState(value) {
  if (!hasValue(value)) return null;
  const valueText = String(value).trim();
  if (!valueText) return null;
  return {
    preview: valueText.slice(0, ATTACHMENT_PREVIEW_CHARS),
    truncated: valueText.length > ATTACHMENT_PREVIEW_CHARS,
    length: valueText.length,
  };
}

function legacyAttachmentState(part) {
  const state = {};
  text(part?.text || "").split("\n").forEach((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) return;
    const [, key, value] = match;
    if (key === "type") state.attachmentType = value;
    if (key === "hookName") state.hookName = value;
    if (key === "hookEventName") state.hookEventName = value;
    if (key === "toolName") state.toolName = value;
    if (key === "matcher") state.matcher = value;
    if (key === "exitCode") state.exitCode = value;
  });
  return state;
}

function normalizedAttachmentState(part, rawEventKey) {
  const existing = part?.state?.kind === "attachment_event" ? { ...part.state } : {};
  const legacy = legacyAttachmentState(part);
  const rawEvent = rawEventByAddress.get(rawEventKey);
  const raw = rawEvent?.raw && typeof rawEvent.raw === "object" ? rawEvent.raw : null;
  const attachment = raw?.attachment && typeof raw.attachment === "object" ? raw.attachment : null;
  const state = {
    kind: "attachment_event",
    attachmentType: attachment?.type || legacy.attachmentType || existing.attachmentType || raw?.subtype || "unknown",
    sourceEventType: raw?.type || existing.sourceEventType || "attachment",
    hasRawPayload: Boolean(rawEvent || existing.hasRawPayload),
    ...legacy,
    ...existing,
  };
  ["hookEventName", "hookName", "matcher", "toolName"].forEach((key) => {
    if (attachment?.[key] && !state[key]) state[key] = String(attachment[key]);
  });
  if (attachment?.hookEvent && !state.hookEventName) state.hookEventName = String(attachment.hookEvent);
  if (attachment?.exitCode !== undefined && attachment?.exitCode !== null && !hasValue(state.exitCode)) {
    state.exitCode = attachment.exitCode;
  }
  if (hasValue(attachment?.stdout) && !hasValue(state.stdout)) state.stdout = String(attachment.stdout).trim();
  if (hasValue(attachment?.stderr) && !hasValue(state.stderr)) state.stderr = String(attachment.stderr).trim();
  const stdout = previewState(attachment?.stdout);
  const stderr = previewState(attachment?.stderr);
  if (stdout && !hasValue(state.stdoutPreview)) {
    state.stdoutPreview = stdout.preview;
    state.stdoutTruncated = stdout.truncated;
    state.stdoutLength = stdout.length;
  }
  if (stderr && !hasValue(state.stderrPreview)) {
    state.stderrPreview = stderr.preview;
    state.stderrTruncated = stderr.truncated;
    state.stderrLength = stderr.length;
  }
  return state;
}

function rawAttachmentForKey(rawEventKey) {
  const rawEvent = rawEventByAddress.get(rawEventKey);
  const raw = rawEvent?.raw && typeof rawEvent.raw === "object" ? rawEvent.raw : null;
  return raw?.attachment && typeof raw.attachment === "object" ? raw.attachment : null;
}

function rawSystemForKey(rawEventKey) {
  const rawEvent = rawEventByAddress.get(rawEventKey);
  const raw = rawEvent?.raw && typeof rawEvent.raw === "object" ? rawEvent.raw : null;
  return raw?.type === "system" ? raw : null;
}

function humanAttachmentType(type) {
  const special = {
    auto_mode: "Auto Mode",
    auto_mode_exit: "Auto Mode Exit",
    command_permissions: "Command Permissions",
    compact_file_reference: "Compact File Reference",
    date_change: "Date Change",
    deferred_tools_delta: "Deferred Tools Delta",
    edited_text_file: "Edited Text File",
    goal_status: "Goal Status",
    hook_additional_context: "Hook Additional Context",
    hook_blocking_error: "Hook Blocking Error",
    hook_non_blocking_error: "Hook Non-Blocking Error",
    hook_success: "Hook Success",
    invoked_skills: "Invoked Skills",
    mcp_instructions_delta: "MCP Instructions Delta",
    nested_memory: "Nested Memory",
    plan_file_reference: "Plan File Reference",
    plan_mode: "Plan Mode",
    plan_mode_exit: "Plan Mode Exit",
    plan_mode_reentry: "Plan Mode Reentry",
    queued_command: "Queued Command",
    skill_listing: "Skill Listing",
    task_reminder: "Task Reminder",
    task_status: "Task Status",
    todo_reminder: "Todo Reminder",
    ultra_effort_enter: "Ultra Effort Enter",
    ultra_effort_exit: "Ultra Effort Exit",
  };
  if (special[type]) return special[type];
  return String(type || "attachment")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanSystemSubtype(type) {
  const special = {
    api_error: "API Error",
    away_summary: "Away Summary",
    bridge_status: "Bridge Status",
    compact_boundary: "Compact Boundary",
    informational: "Informational",
    local_command: "Local Command",
    scheduled_task_fire: "Scheduled Task Fire",
    stop_hook_summary: "Stop Hook Summary",
    turn_duration: "Turn Duration",
  };
  if (special[type]) return special[type];
  return String(type || "system")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanRawEventType(type) {
  const special = {
    "agent-name": "Agent Name",
    "ai-title": "AI Title",
    "bridge-session": "Bridge Session",
    "file-history-snapshot": "File History Snapshot",
    "last-prompt": "Last Prompt",
    mode: "Mode",
    "permission-mode": "Permission Mode",
    "queue-operation": "Queue Operation",
    result: "Result",
    started: "Started",
  };
  const key = String(type || "raw_event");
  if (special[key]) return special[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bAi\b/g, "AI")
    .replace(/\bId\b/g, "ID")
    .replace(/\bUuid\b/g, "UUID");
}

function humanRawFieldName(field) {
  const special = {
    aiTitle: "AI Title",
    agentName: "Agent Name",
    bridgeSessionId: "Bridge Session ID",
    cwd: "Working Directory",
    leafUuid: "Leaf UUID",
    lastSequenceNum: "Last Sequence Number",
    messageId: "Message ID",
    permissionMode: "Permission Mode",
    requestId: "Request ID",
    sessionId: "Session ID",
    toolUseId: "Tool Use ID",
    uuid: "UUID",
  };
  if (special[field]) return special[field];
  return String(field || "Field")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bAi\b/g, "AI")
    .replace(/\bId\b/g, "ID")
    .replace(/\bUuid\b/g, "UUID");
}

function basename(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function yesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return value;
}

function valueCount(value) {
  return Number(value || 0).toLocaleString();
}

function plural(count, singular, pluralText = `${singular}s`) {
  return `${valueCount(count)} ${Number(count || 0) === 1 ? singular : pluralText}`;
}

function attachmentItems(value) {
  if (!hasValue(value)) return [];
  if (Array.isArray(value)) return value.filter(hasValue).map((item) => text(item).trim()).filter(Boolean);
  return [text(value).trim()].filter(Boolean);
}

function attachmentText(value) {
  return attachmentItems(value).join("\n\n").trim();
}

function tryParseJsonText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatDurationMs(value) {
  return hasValue(value) ? `${Number(value).toLocaleString()} ms` : "";
}

function formatHumanDurationMs(value) {
  if (!hasValue(value)) return "";
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms.toLocaleString()} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds.toLocaleString()}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatChars(value) {
  return `${valueCount(String(value || "").length)} chars`;
}

function compactAttachmentRows(rows) {
  return rows.filter(([, value]) => hasValue(value));
}

function makeAttachmentDisplay(type, badge, title, summary) {
  return {
    type,
    badge,
    title,
    summary,
    rows: [],
    sections: [],
  };
}

function makeSystemDisplay(type, title, summary) {
  return {
    type,
    title,
    summary,
    rows: [],
    sections: [],
  };
}

function listAttachmentSection(fieldKey, label, items, options = {}) {
  return {
    kind: "list",
    fieldKey,
    label,
    items: attachmentItems(items),
    emptyText: options.emptyText || "None",
    ordered: options.ordered === true,
  };
}

function tableAttachmentSection(fieldKey, label, columns, rows, options = {}) {
  const normalizedRows = (rows || []).map((row) => row.map((value) => text(value).trim())).filter((row) => row.some(Boolean));
  if (!normalizedRows.length && options.keepEmpty !== true) return null;
  return {
    kind: "table",
    fieldKey,
    label,
    columns,
    rows: normalizedRows,
    emptyText: options.emptyText || "None",
  };
}

function textAttachmentSection(fieldKey, label, value, options = {}) {
  const valueText = attachmentText(value);
  if (!valueText && options.keepEmpty !== true) return null;
  return {
    kind: "text",
    fieldKey,
    label,
    text: valueText,
    emptyText: options.emptyText || "None",
    countLabel: options.countLabel || (valueText ? formatChars(valueText) : "0 chars"),
  };
}

function statusAttachmentSection(fieldKey, label, lines) {
  const values = attachmentItems(lines);
  if (!values.length) return null;
  return { kind: "status", fieldKey, label, lines: values };
}

function addSection(display, section) {
  if (section) display.sections.push(section);
}

function meaningfulLineDetails(lines, names) {
  const lineItems = attachmentItems(lines);
  const nameItems = attachmentItems(names);
  if (!lineItems.length) return [];
  if (lineItems.length !== nameItems.length) return lineItems;
  return lineItems.some((item, index) => item !== nameItems[index]) ? lineItems : [];
}

function skillNamesFromContent(content) {
  return attachmentText(content).split("\n").map((line) => {
    const match = line.match(/^-\s*([^:]+):/);
    return match ? match[1].trim() : "";
  }).filter(Boolean);
}

function attachmentDisplayModel(part, rawEventKey) {
  const state = normalizedAttachmentState(part, rawEventKey);
  const attachment = rawAttachmentForKey(rawEventKey) || {};
  const type = state.attachmentType || attachment.type || "unknown";
  const display = makeAttachmentDisplay(type, humanAttachmentType(type).toUpperCase(), humanAttachmentType(type), "Attachment payload available in Raw");

  if (type === "hook_success") {
    const stdoutJson = tryParseJsonText(attachment.stdout);
    const hookOutput = stdoutJson?.hookSpecificOutput && typeof stdoutJson.hookSpecificOutput === "object" ? stdoutJson.hookSpecificOutput : null;
    const additionalContext = hookOutput?.additionalContext || "";
    const hookEvent = hookOutput?.hookEventName || state.hookEventName || attachment.hookEvent;
    display.badge = "HOOK SUCCESS";
    display.title = state.hookName || hookEvent || "Hook success";
    display.summary = additionalContext ? `${hookEvent || "Hook"} hook added execution context` : "Hook completed successfully";
    display.rows = compactAttachmentRows([
      ["Hook Event", hookEvent],
      ["Hook Name", state.hookName],
      ["Tool Use ID", attachment.toolUseID],
      ["Command", attachment.command],
      ["Exit Code", state.exitCode],
      ["Duration", formatDurationMs(attachment.durationMs)],
    ]);
    addSection(display, textAttachmentSection("stdout.hookSpecificOutput.additionalContext", "Additional Context", additionalContext));
  } else if (type === "hook_additional_context") {
    const content = attachment.content || [];
    display.badge = "HOOK CONTEXT";
    display.title = state.hookEventName || state.hookName || "Hook context";
    display.summary = "Additional context injected into the prompt";
    display.rows = compactAttachmentRows([
      ["Hook Event", state.hookEventName],
      ["Hook Name", state.hookName],
      ["Tool Use ID", attachment.toolUseID],
      ["Content", `${plural(attachmentItems(content).length, "item")} / ${formatChars(attachmentText(content))}`],
    ]);
    addSection(display, textAttachmentSection("content", "Additional Context", content));
  } else if (type === "deferred_tools_delta") {
    const added = attachmentItems(attachment.addedNames);
    const removed = attachmentItems(attachment.removedNames);
    const readded = attachmentItems(attachment.readdedNames);
    const pending = attachmentItems(attachment.pendingMcpServers);
    display.badge = "TOOLS DELTA";
    display.title = "Deferred tools changed";
    display.summary = `${valueCount(added.length)} tools added, ${valueCount(removed.length)} removed, ${valueCount(readded.length)} re-added`;
    display.rows = compactAttachmentRows([
      ["Added Tools", added.length],
      ["Removed Tools", removed.length],
      ["Re-added Tools", readded.length],
      ["Pending MCP Servers", pending.length],
    ]);
    addSection(display, listAttachmentSection("addedNames", "Added Tools", added));
    addSection(display, listAttachmentSection("removedNames", "Removed Tools", removed));
    addSection(display, listAttachmentSection("readdedNames", "Re-added Tools", readded));
    addSection(display, listAttachmentSection("pendingMcpServers", "Pending MCP Servers", pending));
    const details = meaningfulLineDetails(attachment.addedLines, added);
    if (details.length) addSection(display, listAttachmentSection("addedLines", "Tool Details", details));
  } else if (type === "agent_listing_delta") {
    const added = attachmentItems(attachment.addedTypes);
    const removed = attachmentItems(attachment.removedTypes);
    display.badge = "AGENTS DELTA";
    display.title = "Agent catalog changed";
    display.summary = `${valueCount(added.length)} agents added, ${valueCount(removed.length)} removed`;
    display.rows = compactAttachmentRows([
      ["Added Agents", added.length],
      ["Removed Agents", removed.length],
      ["Initial Listing", yesNo(attachment.isInitial)],
      ["Concurrency Note", attachment.showConcurrencyNote ? "Available" : ""],
    ]);
    addSection(display, listAttachmentSection("addedTypes", "Added Agents", added));
    addSection(display, listAttachmentSection("removedTypes", "Removed Agents", removed));
    addSection(display, listAttachmentSection("addedLines", "Agent Details", attachment.addedLines));
    if (attachment.showConcurrencyNote) addSection(display, statusAttachmentSection("showConcurrencyNote", "Concurrency Note", ["Additional concurrency guidance is available in Raw"]));
  } else if (type === "mcp_instructions_delta") {
    const added = attachmentItems(attachment.addedNames);
    const removed = attachmentItems(attachment.removedNames);
    const blocks = attachmentItems(attachment.addedBlocks);
    display.badge = "MCP INSTRUCTIONS";
    display.title = "MCP instructions changed";
    display.summary = `${plural(added.length, "MCP server")} added, ${valueCount(removed.length)} removed`;
    display.rows = compactAttachmentRows([
      ["Added Servers", added.length],
      ["Removed Servers", removed.length],
      ["Instruction Blocks", blocks.length],
    ]);
    addSection(display, listAttachmentSection("addedNames", "Added Servers", added));
    addSection(display, listAttachmentSection("removedNames", "Removed Servers", removed));
    addSection(display, listAttachmentSection("addedBlocks", "Instruction Blocks", blocks));
  } else if (type === "skill_listing") {
    const names = attachmentItems(attachment.names);
    const fallbackNames = names.length ? names : skillNamesFromContent(attachment.content);
    const skillCount = hasValue(attachment.skillCount) ? Number(attachment.skillCount) : fallbackNames.length;
    display.badge = "SKILL LISTING";
    display.title = "Available skills";
    display.summary = `${valueCount(skillCount)} skills listed`;
    display.rows = compactAttachmentRows([
      ["Skill Count", skillCount],
      ["Initial Listing", yesNo(attachment.isInitial)],
      ["Skill Names", fallbackNames.length],
      ["Descriptions", hasValue(attachment.content) ? formatChars(attachment.content) : ""],
    ]);
    addSection(display, listAttachmentSection("names", "Skill Names", fallbackNames));
    addSection(display, textAttachmentSection("content", "Skill Descriptions", attachment.content));
  } else if (type === "task_reminder" || type === "todo_reminder") {
    const items = attachmentItems(attachment.content);
    const itemCount = hasValue(attachment.itemCount) ? Number(attachment.itemCount) : items.length;
    const todo = type === "todo_reminder";
    display.badge = todo ? "TODO REMINDER" : "TASK REMINDER";
    display.title = todo ? "Todo reminder" : "Task reminder";
    display.summary = itemCount ? `${valueCount(itemCount)} active ${todo ? "todo" : "task"} reminders` : `No active ${todo ? "todo" : "task"} reminders`;
    display.rows = compactAttachmentRows([[todo ? "Todo Items" : "Reminder Items", itemCount]]);
    addSection(display, listAttachmentSection("content", todo ? "Todos" : "Reminders", items));
  } else if (type === "queued_command") {
    display.badge = "QUEUED COMMAND";
    display.title = "Prompt queued";
    display.summary = "A command-mode prompt was queued for the session";
    display.rows = compactAttachmentRows([
      ["Command Mode", attachment.commandMode],
      ["Source UUID", attachment.source_uuid],
      ["Origin", attachment.origin],
    ]);
    addSection(display, textAttachmentSection("prompt", "Queued Prompt", attachment.prompt));
  } else if (type === "command_permissions") {
    const allowed = attachmentItems(attachment.allowedTools);
    display.badge = "COMMAND PERMISSIONS";
    display.title = "Tool permissions updated";
    display.summary = `${plural(allowed.length, "tool")} allowed`;
    display.rows = compactAttachmentRows([["Allowed Tools", allowed.length]]);
    addSection(display, listAttachmentSection("allowedTools", "Allowed Tools", allowed));
  } else if (type === "edited_text_file") {
    display.badge = "EDITED FILE";
    display.title = basename(attachment.filename) || "Edited file";
    display.summary = "Text file edit recorded";
    display.rows = compactAttachmentRows([["File", attachment.filename]]);
    addSection(display, textAttachmentSection("snippet", "Snippet", attachment.snippet));
  } else if (type === "plan_mode") {
    display.badge = "PLAN MODE";
    display.title = "Entered plan mode";
    display.summary = "Planning reminder is active";
    display.rows = compactAttachmentRows([
      ["Reminder Type", attachment.reminderType],
      ["Subagent", yesNo(attachment.isSubAgent)],
      ["Plan File", attachment.planFilePath],
      ["Plan Exists", yesNo(attachment.planExists)],
    ]);
    if (attachment.planExists === false) addSection(display, statusAttachmentSection("planFileStatus", "Plan File Status", ["Plan file is referenced but does not exist on disk."]));
  } else if (type === "plan_mode_exit") {
    display.badge = "PLAN MODE EXIT";
    display.title = "Exited plan mode";
    display.summary = "Planning mode ended";
    display.rows = compactAttachmentRows([
      ["Plan File", attachment.planFilePath],
      ["Plan Exists", yesNo(attachment.planExists)],
    ]);
    if (attachment.planExists === false) addSection(display, statusAttachmentSection("planFileStatus", "Plan File Status", ["Plan file is referenced but does not exist on disk."]));
  } else if (type === "plan_mode_reentry") {
    display.badge = "PLAN MODE REENTRY";
    display.title = "Re-entered plan mode";
    display.summary = "Existing plan workflow resumed";
    display.rows = compactAttachmentRows([["Plan File", attachment.planFilePath]]);
  } else if (type === "file") {
    const file = attachment.content?.file && typeof attachment.content.file === "object" ? attachment.content.file : null;
    const fileContent = file?.content || attachment.content;
    display.badge = "FILE";
    display.title = basename(attachment.filename || file?.filePath) || "File";
    display.summary = "File content attached";
    display.rows = compactAttachmentRows([
      ["File", attachment.filename || file?.filePath],
      ["Display Path", attachment.displayPath],
      ["Content Type", attachment.content?.type],
      ["Lines", file?.numLines || file?.totalLines],
    ]);
    addSection(display, textAttachmentSection("content.file.content", "File Content", fileContent, { countLabel: file?.numLines ? `${valueCount(file.numLines)} lines` : "" }));
  } else if (type === "date_change") {
    display.badge = "DATE CHANGE";
    display.title = "Date changed";
    display.summary = `Session date changed to ${attachment.newDate || "unknown date"}`;
    display.rows = compactAttachmentRows([["New Date", attachment.newDate]]);
  } else if (type === "nested_memory") {
    const memory = attachment.content && typeof attachment.content === "object" ? attachment.content : {};
    display.badge = "NESTED MEMORY";
    display.title = basename(attachment.path || memory.path) || "Nested memory";
    display.summary = "Project memory loaded";
    display.rows = compactAttachmentRows([
      ["Path", attachment.path || memory.path],
      ["Display Path", attachment.displayPath],
      ["Memory Type", memory.type],
      ["Differs From Disk", yesNo(memory.contentDiffersFromDisk)],
    ]);
    addSection(display, textAttachmentSection("content.content", "Memory Content", memory.content));
  } else if (type === "hook_non_blocking_error") {
    display.badge = "HOOK WARNING";
    display.title = state.hookName || "Hook warning";
    display.summary = "Hook failed with non-blocking error";
    display.rows = compactAttachmentRows([
      ["Hook Event", state.hookEventName],
      ["Hook Name", state.hookName],
      ["Tool Use ID", attachment.toolUseID],
      ["Command", attachment.command],
      ["Exit Code", state.exitCode],
      ["Duration", formatDurationMs(attachment.durationMs)],
    ]);
    addSection(display, textAttachmentSection("stderr", "Error Message", attachment.stderr));
  } else if (type === "auto_mode" || type === "auto_mode_exit") {
    const exit = type === "auto_mode_exit";
    display.badge = exit ? "AUTO MODE EXIT" : "AUTO MODE";
    display.title = exit ? "Auto mode disabled" : "Auto mode enabled";
    display.summary = exit ? "Claude exited automatic execution mode" : "Claude entered automatic execution mode";
  } else if (type === "plan_file_reference") {
    display.badge = "PLAN FILE";
    display.title = basename(attachment.planFilePath) || "Plan file";
    display.summary = "Plan file referenced";
    display.rows = compactAttachmentRows([
      ["Plan File", attachment.planFilePath],
      ["Content", hasValue(attachment.planContent) ? formatChars(attachment.planContent) : ""],
    ]);
    addSection(display, textAttachmentSection("planContent", "Plan Content", attachment.planContent));
  } else if (type === "invoked_skills") {
    const skills = Array.isArray(attachment.skills) ? attachment.skills : [];
    display.badge = "INVOKED SKILLS";
    display.title = "Skills loaded";
    display.summary = `${plural(skills.length, "skill")} invoked`;
    display.rows = compactAttachmentRows([["Skills", skills.length]]);
    addSection(display, tableAttachmentSection(
      "skills",
      "Skills",
      ["Name", "Content"],
      skills.map((skill) => [skill?.name || "", skill?.content || ""]),
    ));
  } else if (type === "compact_file_reference") {
    display.badge = "FILE REFERENCE";
    display.title = basename(attachment.filename) || "File reference";
    display.summary = "File referenced";
    display.rows = compactAttachmentRows([
      ["File", attachment.filename],
      ["Display Path", attachment.displayPath],
    ]);
  } else if (type === "task_status") {
    display.badge = "TASK STATUS";
    display.title = attachment.description || "Task status";
    display.summary = `${attachment.taskType || "Task"} task ${attachment.status || "updated"}`;
    display.rows = compactAttachmentRows([
      ["Task ID", attachment.taskId],
      ["Task Type", attachment.taskType],
      ["Status", attachment.status],
      ["Output File", attachment.outputFilePath],
    ]);
    addSection(display, textAttachmentSection("description", "Description", attachment.description));
    if ("deltaSummary" in attachment) addSection(display, statusAttachmentSection("deltaSummary", "Delta Summary", [attachment.deltaSummary || "None"]));
  } else if (type === "ultra_effort_enter") {
    display.badge = "ULTRA EFFORT";
    display.title = "Ultra effort enabled";
    display.summary = "Full reminder instructions are active";
    display.rows = compactAttachmentRows([["Reminder Type", attachment.reminderType]]);
  } else if (type === "ultra_effort_exit") {
    display.badge = "ULTRA EFFORT EXIT";
    display.title = "Ultra effort disabled";
    display.summary = attachment.reason || "Session returned to normal effort mode";
    display.rows = compactAttachmentRows([
      ["Duration", formatDurationMs(attachment.durationMs)],
      ["Reason", attachment.reason],
    ]);
  } else if (type === "goal_status") {
    display.badge = "GOAL STATUS";
    display.title = attachment.met ? "Goal met" : "Goal not met";
    display.summary = attachment.met ? "Goal condition has been satisfied" : "Goal condition still requires attention";
    display.rows = compactAttachmentRows([
      ["Met", yesNo(attachment.met)],
      ["Sentinel", yesNo(attachment.sentinel)],
      ["Iterations", attachment.iterations],
      ["Duration", hasValue(attachment.durationMs) ? `${valueCount(attachment.durationMs)} ms` : ""],
      ["Tokens", hasValue(attachment.tokens) ? valueCount(attachment.tokens) : ""],
    ]);
    addSection(display, textAttachmentSection("condition", "Goal Condition", attachment.condition));
    addSection(display, textAttachmentSection("reason", "Reason", attachment.reason));
  } else if (type === "hook_blocking_error") {
    const blocking = attachment.blockingError && typeof attachment.blockingError === "object" ? attachment.blockingError : {};
    display.badge = "HOOK BLOCKED";
    display.title = state.hookName || "Hook blocked";
    display.summary = "Hook blocked execution";
    display.rows = compactAttachmentRows([
      ["Hook Event", state.hookEventName],
      ["Hook Name", state.hookName],
      ["Tool Use ID", attachment.toolUseID],
    ]);
    addSection(display, textAttachmentSection("blockingError.blockingError", "Blocking Error", blocking.blockingError));
    addSection(display, textAttachmentSection("blockingError.command", "Blocking Command", blocking.command));
  } else {
    display.badge = "ATTACHMENT";
    display.title = humanAttachmentType(type);
    display.summary = "Attachment payload available in Raw";
    display.rows = compactAttachmentRows(Object.entries(attachment)
      .filter(([key, value]) => key !== "type" && key !== "stdout" && key !== "stderr" && !Array.isArray(value) && (typeof value !== "object" || value === null))
      .map(([key, value]) => [humanAttachmentType(key), yesNo(value)]));
    Object.entries(attachment).forEach(([key, value]) => {
      if (["type", "stdout", "stderr"].includes(key)) return;
      if (Array.isArray(value)) addSection(display, listAttachmentSection(key, humanAttachmentType(key), value));
      else if (typeof value === "object" && value !== null) addSection(display, textAttachmentSection(key, humanAttachmentType(key), value));
      else if (typeof value === "string" && value.length > 120) addSection(display, textAttachmentSection(key, humanAttachmentType(key), value));
    });
  }

  if (!display.sections.length && !display.rows.length) {
    display.sections.push(statusAttachmentSection("status", "Status", [display.summary]));
  }
  return display;
}

function attachmentSummary(part, rawEventKey) {
  const display = attachmentDisplayModel(part, rawEventKey);
  return [display.title, display.summary].filter(Boolean).join(" · ");
}

function parseJsonObjectText(value) {
  const parsed = tryParseJsonText(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function xmlTagValue(value, tag) {
  const match = text(value).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function systemSectionKey(rawEventKey, section) {
  return `${rawEventKey || "system"}::system::${section.fieldKey || section.label}`;
}

function listSystemSection(fieldKey, label, items, options = {}) {
  return {
    kind: "list",
    fieldKey,
    label,
    items: attachmentItems(items),
    emptyText: options.emptyText || "None",
    ordered: options.ordered === true,
  };
}

function textSystemSection(fieldKey, label, value, options = {}) {
  const valueText = attachmentText(value);
  if (!valueText && options.keepEmpty !== true) return null;
  return {
    kind: "text",
    fieldKey,
    label,
    text: valueText,
    emptyText: options.emptyText || "None",
    countLabel: options.countLabel || (valueText ? formatChars(valueText) : "0 chars"),
  };
}

function statusSystemSection(fieldKey, label, lines) {
  const values = attachmentItems(lines);
  if (!values.length) return null;
  return { kind: "status", fieldKey, label, lines: values };
}

function compactPercent(numerator, denominator) {
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return "";
  return `${Math.round((top / bottom) * 100).toLocaleString()}%`;
}

function scalarSystemRows(raw, omit = new Set()) {
  return compactAttachmentRows(Object.entries(raw || {})
    .filter(([key, value]) => !omit.has(key) && !Array.isArray(value) && (typeof value !== "object" || value === null))
    .map(([key, value]) => [humanSystemSubtype(key), yesNo(value)]));
}

function systemDisplayModel(part, rawEventKey) {
  const raw = rawSystemForKey(rawEventKey) || {};
  const subtype = raw.subtype || part?.state?.subtype || "system";
  const label = humanSystemSubtype(subtype);
  const display = makeSystemDisplay(subtype, label, "System event payload available in Raw");
  const contentText = attachmentText(raw.content);

  if (subtype === "stop_hook_summary") {
    const hookInfos = Array.isArray(raw.hookInfos) ? raw.hookInfos : [];
    const hookErrors = attachmentItems(raw.hookErrors);
    const additionalContext = attachmentItems(raw.hookAdditionalContext);
    display.title = "Stop Hook Summary";
    display.summary = raw.preventedContinuation
      ? "Stop hooks prevented continuation"
      : raw.hasOutput
        ? "Stop hooks completed with output"
        : "Stop hooks completed";
    display.rows = compactAttachmentRows([
      ["Hook Count", hasValue(raw.hookCount) ? raw.hookCount : hookInfos.length],
      ["Stop Reason", raw.stopReason || "empty"],
      ["Prevented Continue", yesNo(raw.preventedContinuation)],
      ["Has Output", yesNo(raw.hasOutput)],
      ["Tool Use ID", raw.toolUseID || raw.toolUseId],
      ["Level", raw.level],
      ["Additional Context", additionalContext.length ? plural(additionalContext.length, "item") : ""],
      ["Hook Errors", hookErrors.length],
    ]);
    addSection(display, listSystemSection("hookInfos", "Hook Runs", hookInfos.map((item) => {
      if (!item || typeof item !== "object") return text(item);
      const command = item.command || item.hookName || item.hookEventName || "Hook";
      const duration = formatDurationMs(item.durationMs);
      const exitCode = hasValue(item.exitCode) ? `exit ${item.exitCode}` : "";
      return [command, exitCode, duration].filter(Boolean).join(" - ");
    })));
    addSection(display, listSystemSection("hookErrors", "Hook Errors", hookErrors));
    addSection(display, textSystemSection("hookAdditionalContext", "Additional Context", additionalContext));
  } else if (subtype === "turn_duration") {
    const duration = formatHumanDurationMs(raw.durationMs);
    display.title = "Turn Duration";
    display.summary = duration
      ? `Turn completed in ${duration}${hasValue(raw.messageCount) ? ` across ${valueCount(raw.messageCount)} messages` : ""}`
      : "Turn duration recorded";
    display.rows = compactAttachmentRows([
      ["Duration", raw.durationMs ? `${duration} (${formatDurationMs(raw.durationMs)})` : ""],
      ["Message Count", raw.messageCount],
      ["Pending Agents", raw.pendingBackgroundAgentCount],
      ["Pending Workflows", raw.pendingWorkflowCount],
      ["Meta Event", yesNo(raw.isMeta)],
      ["Level", raw.level],
    ]);
  } else if (subtype === "away_summary") {
    display.title = "Away Summary";
    display.summary = "Away summary generated for the session";
    display.rows = scalarSystemRows(raw, new Set(["type", "subtype", "content", "uuid", "timestamp"]));
    addSection(display, textSystemSection("content", "Summary", raw.content || part?.text));
  } else if (subtype === "local_command") {
    const commandName = xmlTagValue(raw.content, "command-name");
    const commandMessage = xmlTagValue(raw.content, "command-message");
    const commandArgs = xmlTagValue(raw.content, "command-args");
    display.title = commandName || "Local Command";
    display.summary = commandMessage || "Local command context was injected into the session";
    display.rows = compactAttachmentRows([
      ["Command Name", commandName],
      ["Command Message", commandMessage],
      ["Arguments", commandArgs || "empty"],
      ["Level", raw.level],
    ]);
    if (contentText && !commandName && !commandMessage) addSection(display, textSystemSection("content", "Content", contentText));
  } else if (subtype === "api_error") {
    const error = raw.error && typeof raw.error === "object" ? raw.error : {};
    display.title = "API Error";
    display.summary = error.message || raw.message || "API request failed";
    display.rows = compactAttachmentRows([
      ["Status", error.status || raw.status],
      ["Message", error.message || raw.message],
      ["Request ID", error.requestId || error.requestID || raw.requestId || raw.requestID],
      ["Network Down", yesNo(raw.networkDown || error.networkDown)],
      ["Retry Attempt", hasValue(raw.retryAttempt) && hasValue(raw.maxRetries) ? `${raw.retryAttempt} / ${raw.maxRetries}` : raw.retryAttempt],
      ["Retry In", formatDurationMs(raw.retryAfterMs || raw.retryDelayMs)],
      ["Level", raw.level],
    ]);
    addSection(display, textSystemSection("error.formatted", "Error Details", error.formatted || error.details || raw.formatted));
    addSection(display, textSystemSection("cause", "Cause", raw.cause || error.cause));
  } else if (subtype === "compact_boundary") {
    const meta = raw.compactMetadata && typeof raw.compactMetadata === "object" ? raw.compactMetadata : {};
    const preservedMessages = meta.preservedMessages && typeof meta.preservedMessages === "object" ? meta.preservedMessages : {};
    const preservedSegment = meta.preservedSegment && typeof meta.preservedSegment === "object" ? meta.preservedSegment : {};
    const reduction = hasValue(meta.preTokens) && hasValue(meta.postTokens)
      ? `${compactPercent(Number(meta.preTokens) - Number(meta.postTokens), meta.preTokens)} reduced`
      : "";
    display.title = "Compact Boundary";
    display.summary = meta.trigger ? `Conversation compacted by ${meta.trigger} trigger` : "Conversation compacted";
    display.rows = compactAttachmentRows([
      ["Trigger", meta.trigger],
      ["Pre Tokens", hasValue(meta.preTokens) ? valueCount(meta.preTokens) : ""],
      ["Post Tokens", hasValue(meta.postTokens) ? valueCount(meta.postTokens) : ""],
      ["Token Reduction", reduction],
      ["Duration", formatDurationMs(meta.durationMs || raw.durationMs)],
      ["Precomputed", yesNo(meta.usedPrecomputed || meta.precomputed)],
      ["Agent ID", meta.agentId || raw.agentId],
      ["Logical Parent", meta.logicalParentUuid || raw.logicalParentUuid],
      ["Preserved Anchor", preservedMessages.anchorUuid],
      ["Segment Head", preservedSegment.headUuid],
      ["Segment Anchor", preservedSegment.anchorUuid],
      ["Segment Tail", preservedSegment.tailUuid],
    ]);
    addSection(display, listSystemSection("compactMetadata.preCompactDiscoveredTools", "Pre-Compact Tools", meta.preCompactDiscoveredTools));
    addSection(display, listSystemSection("compactMetadata.preservedMessages.allUuids", "All UUIDs", preservedMessages.allUuids));
    addSection(display, listSystemSection("compactMetadata.preservedMessages.uuids", "UUIDs", preservedMessages.uuids));
  } else if (subtype === "scheduled_task_fire") {
    const schedule = contentText.match(/\(([^()]+)\)\s*$/)?.[1] || raw.schedule || "";
    display.title = "Scheduled Task Fire";
    display.summary = contentText ? compact(contentText, 180) : "Scheduled task fired";
    display.rows = compactAttachmentRows([
      ["Message", contentText],
      ["Schedule", schedule],
      ["Level", raw.level],
    ]);
  } else if (subtype === "informational") {
    const parsed = parseJsonObjectText(raw.content);
    const infoMessage = parsed?.status?.message || parsed?.message || contentText;
    display.title = "Informational";
    display.summary = infoMessage || "Informational system message";
    display.rows = compactAttachmentRows([
      ["Message", infoMessage],
      ["Level", raw.level],
    ]);
    if (contentText && contentText !== infoMessage) addSection(display, textSystemSection("content", "Content", contentText));
  } else if (subtype === "bridge_status") {
    const parsed = parseJsonObjectText(raw.content) || {};
    display.title = "Bridge Status";
    display.summary = parsed.message || contentText || "Bridge status changed";
    display.rows = compactAttachmentRows([
      ["URL", raw.url || parsed.url],
      ["Message", parsed.message || contentText],
      ["Level", raw.level],
    ]);
  } else {
    display.title = label;
    display.summary = contentText ? compact(contentText, 180) : "Unknown system event payload available in Raw";
    display.rows = scalarSystemRows(raw, new Set(["type", "subtype", "content", "uuid", "timestamp"]));
    if (contentText) addSection(display, textSystemSection("content", "Content", contentText));
    Object.entries(raw).forEach(([key, value]) => {
      if (["type", "subtype", "content", "uuid", "timestamp"].includes(key)) return;
      if (Array.isArray(value)) addSection(display, listSystemSection(key, humanSystemSubtype(key), value));
      else if (typeof value === "object" && value !== null) addSection(display, textSystemSection(key, humanSystemSubtype(key), value));
      else if (typeof value === "string" && value.length > 120) addSection(display, textSystemSection(key, humanSystemSubtype(key), value));
    });
  }

  if (!display.sections.length && !display.rows.length) {
    display.sections.push(statusSystemSection("status", "Status", [display.summary]));
  }
  return display;
}

function systemSummary(part, rawEventKey) {
  const display = systemDisplayModel(part, rawEventKey);
  return [display.title, display.summary].filter(Boolean).join(" · ");
}

function rawEventForMessage(message) {
  return rawEventByAddress.get(eventAddress(message?.nav)) || null;
}

function kindClass(value) {
  const key = String(value || "mixed").replace(/_/g, "-");
  if (key === "tool-call" || key === "tool-use") return "tool";
  if (key === "tool-result" || key === "tool-used") return "tool-result";
  return key;
}

function portfolioBadgeClass(value) {
  const className = kindClass(value);
  return className === "raw-event" ? "raw_event raw-event" : className;
}

function kindForLineType(value) {
  const key = String(value || "raw_event").replace(/-/g, "_");
  if (key === "user") return { key: "user", label: "user", compact: "USER" };
  if (key === "assistant") return { key: "assistant", label: "assistant", compact: "ASST" };
  if (key === "attachment") return { key: "attachment", label: "attachment", compact: "ATT" };
  if (key === "system") return { key: "system", label: "system", compact: "SYS" };
  return { key: "raw_event", label: keyTitle(key), compact: "RAW" };
}

function keyTitle(value) {
  return String(value || "unknown")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .toLowerCase();
}

function compactKindLabel(label, fallback = "KIND") {
  const firstWord = String(label || fallback).split(/\s+/).filter(Boolean)[0] || fallback;
  const normalized = firstWord.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (normalized || fallback).slice(0, 6);
}

function partContentKind(part, lineKind) {
  if (isAttachmentPart(part)) {
    const rawEventKey = eventAddress(part.nav);
    const attachment = rawAttachmentForKey(rawEventKey) || {};
    const subtype = attachment.type || part?.state?.attachmentType || "attachment";
    const label = humanAttachmentType(subtype);
    return { key: "attachment", label, compact: compactKindLabel(label, "ATT") };
  }
  if (isSystemPart(part) || lineKind.key === "system") {
    const rawEventKey = eventAddress(part?.nav);
    const raw = rawSystemForKey(rawEventKey) || {};
    const subtype = raw.subtype || part?.state?.subtype || "system";
    const label = humanSystemSubtype(subtype);
    return { key: subtype || "system", label, compact: compactKindLabel(label, "SYS") };
  }
  if (window.OpenCodeRenderer?.isOpenCodePart(part)) {
    return window.OpenCodeRenderer.openCodeContentKind(part, lineKind);
  }
  if (part?.type === "tool_result") return { key: "tool_result", label: "tool result", compact: "RESULT" };
  if (part?.type === "tool") return { key: "tool", label: "tool call", compact: "TOOL" };
  if (part?.type === "reasoning") return { key: "reasoning", label: "reasoning", compact: "REASON" };
  if (part?.type === "text") {
    if (lineKind.key === "assistant" || lineKind.key === "user") return { key: "message", label: "message", compact: "MSG" };
    if (lineKind.key === "attachment") return { key: "attachment", label: "attachment", compact: "ATT" };
    return { key: lineKind.key, label: lineKind.label, compact: lineKind.compact };
  }
  const style = typeStyle(part?.type);
  return {
    key: part?.type || "mixed",
    label: style.label || keyTitle(part?.type),
    compact: compactKindLabel(style.label || part?.type, "MIX"),
  };
}

function uniqueContentKinds(kinds) {
  const seen = new Set();
  const out = [];
  kinds.forEach((kind) => {
    const signature = `${kind.key}:${kind.label}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push(kind);
  });
  return out;
}

function primaryKindKey(lineKind, contentKinds) {
  const keys = contentKinds.map((kind) => kind.key);
  if (lineKind.key === "attachment") return "attachment";
  if (lineKind.key === "system") return "system";
  if (lineKind.key === "user") return keys.includes("tool_result") ? "tool_result" : "user";
  if (lineKind.key === "assistant") {
    if (keys.includes("tool")) return "tool";
    if (keys.includes("message")) return "assistant";
    if (keys.includes("reasoning")) return "reasoning";
    return "assistant";
  }
  if (keys.length === 1) return keys[0];
  return lineKind.key || "mixed";
}

function messageKindModel(message) {
  const rawEvent = rawEventForMessage(message);
  const rawType = rawEvent?.raw && typeof rawEvent.raw === "object" ? rawEvent.raw.type : "";
  const lineKind = kindForLineType(rawType || message?.role || "raw_event");
  const contentKinds = uniqueContentKinds((message?.parts || []).map((part) => partContentKind(part, lineKind)));
  if (!contentKinds.length) contentKinds.push({ key: lineKind.key, label: lineKind.label, compact: lineKind.compact });
  const primaryKey = primaryKindKey(lineKind, contentKinds);
  const contentLabel = contentKinds.map((kind) => kind.label).join(" + ");
  return {
    line: lineKind,
    contentKinds,
    primaryKey,
    primaryStyle: typeStyle(primaryKey),
    fullLabel: `${lineKind.label} / ${contentLabel}`,
    compactLabel: `${lineKind.compact} · ${contentKinds[0].compact}`,
    contentLabel,
  };
}

function rawEventKindModel(event) {
  const rawType = event?.raw && typeof event.raw === "object" ? event.raw.type : "raw_event";
  const lineKind = kindForLineType(rawType || "raw_event");
  if (lineKind.key === "system") {
    const subtype = event?.raw?.subtype || "system";
    const label = humanSystemSubtype(subtype);
    const contentKinds = [{ key: subtype, label, compact: compactKindLabel(label, "SYS") }];
    return {
      line: lineKind,
      contentKinds,
      primaryKey: "system",
      primaryStyle: typeStyle("system"),
      fullLabel: `${lineKind.label} / ${label}`,
      compactLabel: `${lineKind.compact} · ${contentKinds[0].compact}`,
      contentLabel: label,
    };
  }
  return {
    line: lineKind,
    contentKinds: [],
    primaryKey: "raw_event",
    primaryStyle: typeStyle("raw_event"),
    fullLabel: lineKind.label,
    compactLabel: lineKind.compact,
    contentLabel: "",
  };
}

function titleBarContentKinds(kind) {
  if (kind.line.key !== "assistant") return kind.contentKinds;
  return uniqueContentKinds(kind.contentKinds.map((item) => (
    item.key === "assistant" || item.key === "message"
      ? { key: "message", label: "message", compact: "MSG" }
      : item
  )));
}

function renderMessageKindStack(kind) {
  const contentKinds = titleBarContentKinds(kind);
  return `
    <span class="portfolio-kind-stack message-kind-stack" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(contentKinds.map((item) => item.label).join(","))}">
      <span class="portfolio-kind-badge message-line-kind ${escAttr(portfolioBadgeClass(kind.line.key))}">${esc(kind.line.label)}</span>
      ${contentKinds.map((item) => `
        <span class="portfolio-kind-separator" aria-hidden="true">/</span>
        <span class="portfolio-subtype-badge message-content-kind ${escAttr(portfolioBadgeClass(kind.line.key))} ${escAttr(portfolioBadgeClass(item.key))}">${esc(item.label)}</span>
      `).join("")}
    </span>`;
}

function renderMessageIndexKind(kind) {
  const contentKinds = titleBarContentKinds(kind);
  return `
    <span class="portfolio-nav-kind message-index-kind" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(contentKinds.map((item) => item.label).join(","))}">
      <span class="portfolio-kind-badge message-index-line-kind ${escAttr(portfolioBadgeClass(kind.line.key))}">${esc(kind.line.label)}</span>
      ${contentKinds.map((item) => `
        <span class="portfolio-kind-separator message-index-kind-separator" aria-hidden="true">/</span>
        <span class="portfolio-subtype-badge message-index-content-kind ${escAttr(portfolioBadgeClass(kind.line.key))} ${escAttr(portfolioBadgeClass(item.key))}">${esc(item.label)}</span>
      `).join("")}
    </span>`;
}

function renderTimelineDetailKindStack(kind) {
  return `
    <div class="portfolio-kind-stack timeline-detail-kind-stack" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(kind.contentKinds.map((item) => item.label).join(","))}">
      <span class="portfolio-kind-badge timeline-detail-type ${escAttr(portfolioBadgeClass(kind.line.key))}">${esc(kind.line.label)}</span>
      ${kind.contentKinds.map((item) => `
        <span class="portfolio-kind-separator" aria-hidden="true">/</span>
        <span class="portfolio-subtype-badge timeline-detail-content-type ${escAttr(portfolioBadgeClass(kind.line.key))} ${escAttr(portfolioBadgeClass(item.key))}">${esc(item.label)}</span>
      `).join("")}
    </div>`;
}

function attachmentSectionKey(rawEventKey, section) {
  return `${rawEventKey || "attachment"}::${section.fieldKey || section.label}`;
}

function renderAttachmentSection(section, rawEventKey) {
  if (!section) return "";
  if (section.kind === "list") {
    const items = (section.items || []).filter(Boolean);
    const tag = section.ordered ? "ol" : "ul";
    const body = items.length
      ? `<${tag}>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</${tag}>`
      : `<p>${esc(section.emptyText || "None")}</p>`;
    return `
      <section class="attachment-section" data-attachment-section="${escAttr(section.label)}" data-attachment-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong><span>${items.length.toLocaleString()} items</span></header>
        ${body}
      </section>`;
  }
  if (section.kind === "table") {
    const rows = section.rows || [];
    const body = rows.length
      ? `<div class="attachment-table-scroll"><table><thead><tr>${section.columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : `<p>${esc(section.emptyText || "None")}</p>`;
    return `
      <section class="attachment-section" data-attachment-section="${escAttr(section.label)}" data-attachment-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong><span>${rows.length.toLocaleString()} items</span></header>
        ${body}
      </section>`;
  }
  if (section.kind === "text") {
    const fullText = section.text || "";
    return `
      <section class="attachment-section" data-attachment-section="${escAttr(section.label)}" data-attachment-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong><span>${esc(section.countLabel || formatChars(fullText))}</span></header>
        <pre>${esc(fullText || section.emptyText || "None")}</pre>
      </section>`;
  }
  if (section.kind === "status") {
    return `
      <section class="attachment-section" data-attachment-section="${escAttr(section.label)}" data-attachment-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong></header>
        <div class="attachment-status-list">${section.lines.map((line) => `<p>${esc(line)}</p>`).join("")}</div>
      </section>`;
  }
  return "";
}

function renderSystemSection(section, rawEventKey) {
  if (!section) return "";
  if (section.kind === "list") {
    const items = (section.items || []).filter(Boolean);
    const tag = section.ordered ? "ol" : "ul";
    const body = items.length
      ? `<${tag}>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</${tag}>`
      : `<p>${esc(section.emptyText || "None")}</p>`;
    return `
      <section class="system-section" data-system-section="${escAttr(section.label)}" data-system-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong><span>${items.length.toLocaleString()} items</span></header>
        ${body}
      </section>`;
  }
  if (section.kind === "text") {
    const fullText = section.text || "";
    return `
      <section class="system-section" data-system-section="${escAttr(section.label)}" data-system-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong><span>${esc(section.countLabel || formatChars(fullText))}</span></header>
        <pre>${esc(fullText || section.emptyText || "None")}</pre>
      </section>`;
  }
  if (section.kind === "status") {
    return `
      <section class="system-section" data-system-section="${escAttr(section.label)}" data-system-field="${escAttr(section.fieldKey)}">
        <header><strong>${esc(section.label)}</strong></header>
        <div class="system-status-list">${section.lines.map((line) => `<p>${esc(line)}</p>`).join("")}</div>
      </section>`;
  }
  return "";
}

function renderPortfolioFormText(label, value, options = {}) {
  const valueText = text(yesNo(value));
  const multiline = options.multiline !== false;
  return `
    <section class="portfolio-form-row${multiline ? " multiline" : ""}">
      <header><strong>${esc(label)}</strong></header>
      <pre>${esc(valueText || options.emptyText || "None")}</pre>
    </section>`;
}

function renderPortfolioFormTable(label, columns, rows, options = {}) {
  const normalizedRows = (rows || []).map((row) => row.map((value) => text(yesNo(value))));
  return `
    <section class="portfolio-form-block portfolio-form-table">
      <header>
        <strong>${esc(label)}</strong>
        <span>${esc(options.countLabel || `${normalizedRows.length.toLocaleString()} items`)}</span>
      </header>
      ${normalizedRows.length ? `
        <div class="portfolio-table-scroll">
          <table>
            <thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead>
            <tbody>
              ${normalizedRows.map((row) => `<tr>${row.map((value) => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>` : `<p class="portfolio-empty-value">${esc(options.emptyText || "None")}</p>`}
    </section>`;
}

function renderPortfolioDisplaySection(section) {
  if (!section) return "";
  if (section.kind === "list") {
    const items = (section.items || []).filter(Boolean);
    return renderPortfolioFormTable(
      section.label,
      ["Item"],
      items.map((item) => [item]),
      { countLabel: `${items.length.toLocaleString()} items`, emptyText: section.emptyText || "None" },
    );
  }
  if (section.kind === "table") {
    const rows = section.rows || [];
    return renderPortfolioFormTable(
      section.label,
      section.columns || ["Item"],
      rows,
      { countLabel: `${rows.length.toLocaleString()} items`, emptyText: section.emptyText || "None" },
    );
  }
  if (section.kind === "text") {
    const fullText = section.text || "";
    return renderPortfolioFormText(section.label, fullText || section.emptyText || "None", { multiline: true });
  }
  if (section.kind === "status") {
    const lines = section.lines || [];
    return renderPortfolioFormTable(
      section.label,
      ["Item"],
      lines.map((line) => [line]),
      { countLabel: `${lines.length.toLocaleString()} items`, emptyText: "None" },
    );
  }
  return "";
}

function renderPortfolioDisplayBody(display, options = {}) {
  const blocks = [];
  if (display.summary && options.includeSummary !== false) {
    blocks.push(renderPortfolioFormText("Details", display.summary, { multiline: false }));
  }
  (display.rows || []).forEach(([label, value]) => {
    blocks.push(renderPortfolioFormText(label, value, { multiline: String(text(value)).length > 80 }));
  });
  (display.sections || []).forEach((section) => {
    const html = renderPortfolioDisplaySection(section);
    if (html) blocks.push(html);
  });
  if (!blocks.length) {
    blocks.push(`<p class="portfolio-empty-value">${esc(options.emptyText || "No derived content fields are present in this sample.")}</p>`);
  }
  return `<div class="portfolio-detail-form timeline-detail-form">${blocks.join("")}</div>`;
}

function renderPortfolioAttachmentPartBody(part, rawEventKey) {
  return renderPortfolioDisplayBody(attachmentDisplayModel(part, rawEventKey));
}

function renderPortfolioSystemPartBody(part, rawEventKey) {
  return renderPortfolioDisplayBody(systemDisplayModel(part, rawEventKey));
}

function renderPortfolioRawEventBody(rawEvent) {
  return renderPortfolioDisplayBody(rawEventDisplayModel(rawEvent));
}

function renderAttachmentMetaRows(rows) {
  if (!rows.length) return "";
  return `
    <dl class="attachment-meta">
      ${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(yesNo(value))}</dd>`).join("")}
    </dl>`;
}

function normalizedLabel(value) {
  return String(value || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function isDuplicateAttachmentSubtypeTitle(display) {
  const title = normalizedLabel(display?.title);
  if (!title) return true;
  return title === normalizedLabel(display.badge) || title === normalizedLabel(humanAttachmentType(display.type));
}

function renderAttachmentPartBody(part, rawEventKey, options = {}) {
  const display = attachmentDisplayModel(part, rawEventKey);
  const showRawPayload = options.showRawPayload !== false;
  const heading = isDuplicateAttachmentSubtypeTitle(display)
    ? ""
    : `<div class="attachment-display-heading"><strong>${esc(display.title)}</strong></div>`;
  return `
    <div class="attachment-event" data-raw-event-key="${escAttr(rawEventKey)}" data-attachment-type="${escAttr(display.type)}">
      ${heading}
      <p class="attachment-summary">${esc(display.summary)}</p>
      ${renderAttachmentMetaRows(display.rows)}
      <div class="attachment-sections">
        ${display.sections.map((section) => renderAttachmentSection(section, rawEventKey)).join("")}
      </div>
      ${showRawPayload ? `<div class="attachment-raw hidden" data-raw-payload data-raw-event-key="${escAttr(rawEventKey)}"></div>` : ""}
    </div>`;
}

function renderSystemMetaRows(rows) {
  if (!rows.length) return "";
  return `
    <dl class="system-meta">
      ${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(yesNo(value))}</dd>`).join("")}
    </dl>`;
}

function renderSystemPartBody(part, rawEventKey) {
  const display = systemDisplayModel(part, rawEventKey);
  return `
    <div class="system-event" data-raw-event-key="${escAttr(rawEventKey)}" data-system-subtype="${escAttr(display.type)}">
      <p class="system-summary">${esc(display.summary)}</p>
      ${renderSystemMetaRows(display.rows)}
      <div class="system-sections">
        ${display.sections.map((section) => renderSystemSection(section, rawEventKey)).join("")}
      </div>
    </div>`;
}

function rawEventSummary(raw, typeLabel) {
  if (!raw || typeof raw !== "object") return `${typeLabel} payload is available in Raw`;
  const candidates = [
    raw.aiTitle,
    raw.agentName,
    raw.mode,
    raw.permissionMode,
    raw.operation,
    raw.queueOperation,
    raw.action,
    raw.status,
    raw.message,
    raw.summary,
    raw.title,
    raw.prompt,
    raw.content,
    raw.result,
    raw.path,
    raw.filePath,
    raw.sessionId,
    raw.bridgeSessionId,
  ];
  const value = candidates.find((item) => hasValue(item));
  if (value === undefined || value === null || value === "") return `${typeLabel} event`;
  return compact(text(value), 180);
}

function rawEventScalarRows(raw) {
  if (!raw || typeof raw !== "object") return [];
  const excluded = new Set(["type", "content", "result", "prompt", "message", "summary"]);
  return compactAttachmentRows(Object.entries(raw)
    .filter(([key, value]) => !excluded.has(key) && (typeof value !== "object" || value === null))
    .map(([key, value]) => [humanRawFieldName(key), value]));
}

function rawEventSections(raw) {
  if (!raw || typeof raw !== "object") return [];
  const sections = [];
  Object.entries(raw).forEach(([key, value]) => {
    if (key === "type") return;
    const label = humanRawFieldName(key);
    if (Array.isArray(value)) {
      sections.push(listAttachmentSection(key, label, value));
    } else if (value && typeof value === "object") {
      sections.push(textAttachmentSection(key, label, value));
    } else if (typeof value === "string" && (value.length > 100 || ["content", "result", "prompt", "message", "summary"].includes(key))) {
      sections.push(textAttachmentSection(key, label, value));
    }
  });
  return sections.filter(Boolean);
}

function rawEventDisplayModel(rawEvent) {
  const raw = rawEvent?.raw && typeof rawEvent.raw === "object" ? rawEvent.raw : {};
  const type = raw.type || "raw_event";
  const label = humanRawEventType(type);
  const display = {
    type,
    title: label,
    summary: rawEventSummary(raw, label),
    rows: rawEventScalarRows(raw),
    sections: rawEventSections(raw),
  };
  if (!display.sections.length && !display.rows.length) {
    display.sections.push(statusAttachmentSection("status", "Status", [display.summary]));
  }
  return display;
}

function renderRawEventBody(rawEvent) {
  const rawEventKey = eventAddress(rawEvent?.nav);
  const display = rawEventDisplayModel(rawEvent);
  return `
    <div class="raw-event" data-raw-event-key="${escAttr(rawEventKey)}" data-raw-event-type="${escAttr(display.type)}">
      <p class="raw-event-summary">${esc(display.summary)}</p>
      ${display.rows.length ? `<dl class="raw-event-meta attachment-meta">${display.rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(yesNo(value))}</dd>`).join("")}</dl>` : ""}
      <div class="raw-event-sections attachment-sections">
        ${display.sections.map((section) => renderAttachmentSection(section, rawEventKey)).join("")}
      </div>
    </div>`;
}

function rawPayloadTextForKey(rawEventKey) {
  const rawEvent = rawEventByAddress.get(rawEventKey);
  return rawEvent ? text(rawEvent.raw) : "";
}

function capsuleType(message) {
  if (!message) return "raw_event";
  return messageKindModel(message).primaryKey;
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
    agentDescription: transcript.agent_description || "",
    modelName: transcript.summary?.model || "",
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
      rawEventByAddress.set(eventAddress(event.nav), event);
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
      const kindModel = messageKindModel(message);
      const type = kindModel.primaryKey;
      const capsule = {
        key,
        trackId: track.id,
        laneIndex,
        message,
        nav: message.nav,
        role: message.role || "",
        type,
        label: `${kindModel.fullLabel} ${messageIndex + 1}`,
        kindModel,
        lineType: kindModel.line.label,
        contentTypes: kindModel.contentKinds.map((kind) => kind.label),
        summary: compact(messageText(message) || message.role || "message"),
        timestamp: message.time_created || 0,
        lineNumber: message.nav?.lineNumber || 0,
        messageIndex,
        partTypes: parts.map((part) => part.type),
        problems,
        problemCount: problems.length,
        rawEvent: null,
        rawOnly: false,
        x: 0,
        y: 0,
        width: model.blockWidth,
        height: model.blockHeight,
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
      const kindModel = rawEventKindModel(event);
      const capsule = {
        key,
        trackId: track.id,
        laneIndex,
        message: null,
        nav: event.nav,
        role: "raw",
        type: kindModel.primaryKey,
        label: kindModel.fullLabel,
        kindModel,
        lineType: kindModel.line.label,
        contentTypes: kindModel.contentKinds.map((kind) => kind.label),
        summary: compact(rawText(event)),
        timestamp: Date.parse(event.raw?.timestamp || "") || 0,
        lineNumber: event.nav?.lineNumber || 0,
        messageIndex: track.capsuleKeys.length,
        partTypes: ["raw_event"],
        problems: problemsByNavKey.get(key) || [],
        problemCount: (problemsByNavKey.get(key) || []).length,
        rawEvent: event,
        rawOnly: true,
        x: 0,
        y: 0,
        width: model.blockWidth,
        height: model.blockHeight,
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

function timelineTrackGroupLeftForViewport(viewportWidth, trackSpan) {
  if (viewportWidth > 0 && trackSpan <= viewportWidth) {
    return Math.max(0, (viewportWidth - trackSpan) / 2);
  }
  return model.timelinePadLeft;
}

function layoutGraph(viewportWidth = 0) {
  const layoutViewportWidth = Math.max(0, Math.floor(viewportWidth || 0));
  const trackSpan = model.tracks.length * model.trackWidth;
  const trackGroupLeft = timelineTrackGroupLeftForViewport(layoutViewportWidth, trackSpan);
  let maxBottom = model.timelinePadTop;
  model.tracks.forEach((track, laneIndex) => {
    const parentKey = navKeyToCapsuleKey.get(navKey(track.parentTaskNav));
    const parentCapsule = capsuleByKey.get(parentKey);
    const startY = parentCapsule
      ? parentCapsule.y + model.blockStepY
      : model.timelinePadTop;
    const trackLeft = trackGroupLeft + laneIndex * model.trackWidth;
    track.x = trackLeft;
    track.y = startY;
    track.width = model.trackWidth;
    track.timelineStartY = startY;
    track.timelineEndY = startY + Math.max(1, track.capsuleKeys.length) * model.blockStepY;
    track.capsuleKeys.forEach((key, index) => {
      const capsule = capsuleByKey.get(key);
      if (!capsule) return;
      capsule.x = trackLeft + (model.trackWidth - model.blockWidth) / 2;
      capsule.y = startY + index * model.blockStepY;
      capsule.width = model.blockWidth;
      capsule.height = model.blockHeight;
      maxBottom = Math.max(maxBottom, capsule.y + capsule.height);
    });
  });
  const trailingPad = layoutViewportWidth > 0 && trackSpan <= layoutViewportWidth
    ? trackGroupLeft
    : model.timelinePadRight;
  const nextWidth = Math.max(layoutViewportWidth || 1200, trackGroupLeft + trackSpan + trailingPad);
  const nextHeight = Math.max(640, maxBottom + model.timelinePadBottom);
  const layoutChanged = (
    model.width !== nextWidth ||
    model.height !== nextHeight ||
    model.timelineLayoutViewportWidth !== layoutViewportWidth ||
    model.timelineTrackGroupLeft !== trackGroupLeft ||
    model.timelineTrackSpan !== trackSpan
  );
  model.width = nextWidth;
  model.height = nextHeight;
  model.timelineLayoutViewportWidth = layoutViewportWidth;
  model.timelineTrackGroupLeft = trackGroupLeft;
  model.timelineTrackSpan = trackSpan;
  if (layoutChanged) model.timelineLayoutVersion += 1;
}

function getLayoutFromUrl() {
  const layout = new URLSearchParams(location.search).get("layout");
  if (["waterfall", "focus", "reader"].includes(layout)) return "reader";
  if (["timeline", "graph"].includes(layout)) return "graph";
  return els.workbench?.dataset.defaultLayout === "reader" ? "reader" : "graph";
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

function updateCommandBarHeight() {
  const height = els.commandBar?.getBoundingClientRect().height || 80;
  document.documentElement.style.setProperty("--command-bar-height", `${height}px`);
}

function setSessionInfoOpen(open) {
  if (!els.sessionInfoButton || !els.sessionInfoPopover) return;
  els.sessionInfoButton.setAttribute("aria-expanded", String(open));
  els.sessionInfoPopover.classList.toggle("hidden", !open);
}

function toggleSessionInfo() {
  const open = els.sessionInfoButton?.getAttribute("aria-expanded") === "true";
  setSessionInfoOpen(!open);
}

function setAgentTreeDrawerOpen(open) {
  state.agentTreeDrawerOpen = Boolean(open);
  els.agentTreeDrawer?.classList.toggle("hidden", !state.agentTreeDrawerOpen);
  els.agentPaneToggle?.setAttribute("aria-expanded", String(state.agentTreeDrawerOpen));
  els.workbench?.setAttribute("data-agent-tree-open", String(state.agentTreeDrawerOpen));
  updateSubagentPanelOverlayWidth();
  requestAnimationFrame(() => updateSubagentPanelOverlayWidth());
}

function readerMessageId(trackId, index) {
  return `msg-${domId(trackId)}-${index}`;
}

function trackTitle(track) {
  return track?.title || track?.id || "Transcript";
}

function renderSessionSummary() {
  const problems = allProblems().length;
  const html = compactHtml(`
    <dl class="mini-stats">
      <dt>Sessions</dt><dd>1</dd>
      <dt>Agents</dt><dd>${model.tracks.length}</dd>
      <dt>Messages</dt><dd>${model.capsules.filter((item) => !item.rawOnly).length}</dd>
      <dt>Raw-only</dt><dd>${model.capsules.filter((item) => item.rawOnly).length}</dd>
      <dt>Problem events</dt><dd>${problems}</dd>
    </dl>`);
  if (els.sessionSummary) els.sessionSummary.innerHTML = html;
  if (els.sessionInfoPopover) els.sessionInfoPopover.innerHTML = html;
}

function renderAgentSelector() {
  if (!els.agentSelector || !els.openAgentChips) return;
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
          <button class="agent-tree-select" data-action="select-track" data-track-id="${escAttr(track.id)}" data-open="false" aria-current="${active ? "true" : "false"}">
            <span class="agent-option-kind">${isSubagent ? "subagent" : "main"}</span>
            <span class="agent-option-title">${esc(compact(title, 58))}</span>
            <span class="agent-option-count">${track.messages.length}</span>
          </button>
          ${isSubagent ? `<button class="agent-tree-toggle" data-action="toggle-panel" data-track-id="${escAttr(track.id)}" data-testid="subagent-toggle" aria-pressed="${open ? "true" : "false"}" aria-label="${open ? "Unpin panel for" : "Pin panel for"} ${escAttr(title)}" title="${open ? "Unpin panel" : "Pin panel"}"><svg class="agent-tree-pin-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-.59-1.42L16 11.41V6h1a1 1 0 0 0 1-1V2H6v3a1 1 0 0 0 1 1h1v5.41l-2.41 2.41A2 2 0 0 0 5 15.24Z" /></svg></button>` : '<span class="agent-tree-toggle-placeholder" aria-hidden="true"></span>'}
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
  els.messageNavPanel?.classList.toggle("hidden", state.leftNavTab !== "messages");
  els.agentTreePanel?.classList.toggle("hidden", state.leftNavTab !== "agents");
}

function renderLeftNavigation() {
  renderAgentSelector();
  renderAgentTree();
  renderMessageIndex();
}

function renderMessageIndex() {
  if (state.layout === "graph") {
    els.messageIndex.innerHTML = '<div class="nav-item muted">Timeline uses tracks and message blocks for navigation.</div>';
    return;
  }
  const track = trackById.get(state.selectedTrackId) || model.tracks[0];
  if (!track) return;
  const maxItems = 1400;
  const capsules = track.capsuleKeys.map((key) => capsuleByKey.get(key)).filter(Boolean);
  const shownCapsules = capsules.slice(0, maxItems);
  els.messageIndex.innerHTML = compactHtml(shownCapsules
    .map((capsule) => {
      const key = capsule.key;
      const active = key && key === state.currentCapsuleKey;
      const problems = capsule.problems || [];
      const problemText = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
      const kind = capsule.kindModel || (capsule.rawOnly ? rawEventKindModel(capsule.rawEvent) : messageKindModel(capsule.message));
      const contentKinds = titleBarContentKinds(kind);
      return `
        <button class="nav-item portfolio-navigation-item message-index-item ${active ? "active selected" : ""} ${problems.length ? "has-problem" : ""}" data-action="focus-capsule" data-track-id="${escAttr(track.id)}" data-message-index="${capsule.messageIndex}" data-capsule-key="${escAttr(key)}" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(contentKinds.map((item) => item.label).join(","))}" aria-current="${active ? "true" : "false"}">
          <span class="portfolio-nav-line message-index-nav-line">
            ${renderMessageIndexKind(kind)}
            <span class="message-index-nav-meta">
              ${problems.length ? `<span class="message-index-problem" aria-label="${escAttr(problemText)}"><span class="message-index-problem-dot" aria-hidden="true"></span><span>${esc(problemText)}</span></span>` : ""}
              <span class="portfolio-nav-time message-index-time">${esc(formatTime(capsule.timestamp))}</span>
            </span>
          </span>
          <span class="message-preview">${esc(compact(capsule.summary || "(no content)", 110))}</span>
        </button>`;
    })
    .join("") + (capsules.length > maxItems ? `<div class="nav-item muted">Showing first ${maxItems.toLocaleString()} of ${capsules.length.toLocaleString()} blocks.</div>` : ""));
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
  const capsules = track.capsuleKeys.map((key) => capsuleByKey.get(key)).filter(Boolean);
  return `
    <section class="reader-track ${track.depth === 0 ? "main-track" : "subagent-track"} ${panel ? "subagent-panel" : ""}" id="track-${domId(track.id)}" data-agent-id="${escAttr(track.id)}" data-track-kind="${track.depth === 0 ? "main" : "subagent"}">
      <header class="reader-track-header">
        <div>
          <div class="agent-track-kicker">${track.depth === 0 ? "main agent" : "subagent"}</div>
          <h2 title="${escAttr(title)}">${esc(title)}</h2>
        </div>
        <div class="agent-track-actions">
          <span class="count-pill">${capsules.length} blocks</span>
          ${track.problemCount ? `<span class="problem-pill">${track.problemCount} problems</span>` : ""}
          ${panel ? `<button class="agent-panel-close" data-action="close-panel" data-track-id="${escAttr(track.id)}" aria-label="Close ${escAttr(title)}">x</button>` : ""}
        </div>
        ${renderAgentConnector(track)}
      </header>
      <div class="reader-track-body">
        ${capsules.length ? capsules.map((capsule) => renderReaderCapsule(capsule, track)).join("") : '<div class="agent-track-empty">No messages in this transcript.</div>'}
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
        <span class="agent-connector-value">${track.capsuleKeys.length ? "1" : "none"}</span>
      </button>
      ${resultKey ? `<button type="button" class="agent-connector-node result" data-action="focus-capsule" data-capsule-key="${escAttr(resultKey)}"><span class="agent-connector-label">result</span><span class="agent-connector-value">open</span></button>` : ""}
    </div>`;
}

function renderReaderCapsule(capsule, track) {
  if (capsule.rawOnly) return renderReaderRawEvent(capsule, track);
  return renderReaderMessage(capsule.message, track, capsule.messageIndex);
}

function renderReaderRawEvent(capsule, track) {
  const kind = capsule.kindModel || rawEventKindModel(capsule.rawEvent);
  const problems = capsule.problems || [];
  const index = capsule.messageIndex;
  return `
    <article class="reader-message ${escAttr(kindClass(kind.line.key))} raw-event ${problems.length ? "has-problem" : ""} ${capsule.key === state.currentCapsuleKey ? "active" : ""}" id="${readerMessageId(track.id, index)}" data-action="focus-capsule" data-agent-id="${escAttr(track.id)}" data-message-index="${index}" data-capsule-key="${escAttr(capsule.key)}" data-testid="transcript-message" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(kind.contentKinds.map((item) => item.label).join(","))}" role="button" tabindex="0" aria-current="${capsule.key === state.currentCapsuleKey ? "true" : "false"}" aria-label="${escAttr(`${kind.fullLabel} block ${index + 1}`)}">
      <div class="message-card">
        <header class="portfolio-card-header message-header">
          <div class="message-header-left">
            ${renderMessageKindStack(kind)}
            <span class="message-meta">
              <span>${esc(capsule.nav?.agentPath || "main")}</span>
              ${problems.length ? `<span class="problem-tag">${problems.length} problems</span>` : ""}
            </span>
          </div>
          <div class="portfolio-card-header-actions message-header-actions">
            ${capsule.timestamp ? `<span class="portfolio-card-time">${esc(formatTime(capsule.timestamp))}</span>` : ""}
            <button type="button" class="portfolio-mini-button message-raw-button" data-action="open-reader-raw">Raw</button>
            <span class="message-card-index" aria-label="Block ${index + 1}">#${index + 1}</span>
          </div>
        </header>
        <div class="message-body">
          <section class="reader-part raw-event" data-nav-key="${escAttr(capsule.key)}" data-raw-event-key="${escAttr(eventAddress(capsule.rawEvent?.nav))}" data-testid="raw-event">
            <header class="part-header"><strong>Details</strong></header>
            ${renderRawEventBody(capsule.rawEvent)}
          </section>
        </div>
      </div>
    </article>`;
}

function renderReaderMessage(message, track, index) {
  const key = navKeyToCapsuleKey.get(navKey(message.nav)) || "";
  const capsule = key ? capsuleByKey.get(key) : null;
  const problems = capsule?.problems || [];
  const kind = capsule?.kindModel || messageKindModel(message);
  return `
    <article class="reader-message ${escAttr(kindClass(kind.line.key))} ${problems.length ? "has-problem" : ""} ${key === state.currentCapsuleKey ? "active" : ""}" id="${readerMessageId(track.id, index)}" data-action="focus-capsule" data-agent-id="${escAttr(track.id)}" data-message-index="${index}" data-capsule-key="${escAttr(key)}" data-testid="transcript-message" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(kind.contentKinds.map((item) => item.label).join(","))}" role="button" tabindex="0" aria-current="${key === state.currentCapsuleKey ? "true" : "false"}" aria-label="${escAttr(`${kind.fullLabel} message ${index + 1}`)}">
      <div class="message-card">
        <header class="portfolio-card-header message-header">
          <div class="message-header-left">
            ${renderMessageKindStack(kind)}
            <span class="message-meta">
              ${message.modelID ? `<span>${esc(message.modelID)}</span>` : ""}
              ${message.agent ? `<span>${esc(message.agent)}</span>` : ""}
              ${problems.length ? `<span class="problem-tag">${problems.length} problems</span>` : ""}
            </span>
          </div>
          <div class="portfolio-card-header-actions message-header-actions">
            ${message.time_created ? `<span class="portfolio-card-time">${esc(formatTime(message.time_created))}</span>` : ""}
            <button type="button" class="portfolio-mini-button message-raw-button" data-action="open-reader-raw">Raw</button>
            <span class="message-card-index" aria-label="Message ${index + 1}">#${index + 1}</span>
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
  const attachment = isAttachmentPart(part);
  const system = isSystemPart(part);
  const rawEventKey = eventAddress(part.nav);
  const style = part.type === "tool_result" ? "tool-result" : part.type === "tool" ? "tool" : attachment ? "attachment" : system ? "system" : part.type || "part";
  const partKind = partContentKind(part, kindForLineType(rawEventByAddress.get(rawEventKey)?.raw?.type || context?.message?.role || ""));
  const testId = part.type === "tool_result" ? "tool-result" : part.type === "tool" ? "tool-call" : system ? "system-message" : "transcript-part";
  const childTrack = childTrackByParentTaskKey.get(navKey(part.nav));
  const pairedKey = navKeyToCapsuleKey.get(navKey(pairedNav(part))) || "";
  const hasRawPayload = attachment && rawEventByAddress.has(rawEventKey);
  const partHeaderLabel = attachment || system ? "Details" : part.type === "tool" ? part.tool || partKind.label : partKind.label;
  if (window.OpenCodeRenderer?.isOpenCodePart(part)) {
    const ocClass = window.OpenCodeRenderer.openCodePartClass(part);
    const ocKindStack = window.OpenCodeRenderer.renderOpenCodeKindStack(part);
    const ocBody = window.OpenCodeRenderer.renderOpenCodePart(part, { showInlineResult: true });
    const ocActions = window.OpenCodeRenderer.renderOpenCodePartHeaderActions(part);
    const ocTime = part.time_created || context?.message?.time_created;
    return `
      <section class="reader-part ${escAttr(ocClass)} ${part.state?.is_error ? "error" : ""}" data-nav-key="${escAttr(key)}" data-raw-event-key="${escAttr(rawEventKey)}" data-opencode-kind="${escAttr(part.state?.kind || "")}" data-testid="${testId}">
        <header class="part-header opencode-part-header">
          <div class="part-header-left">
            ${ocKindStack}
            ${ocActions}
          </div>
          <div class="part-header-actions opencode-part-header-actions">
            ${ocTime ? `<span class="portfolio-card-time">${esc(formatTime(ocTime))}</span>` : ""}
            <button type="button" class="portfolio-mini-button opencode-raw-button" data-action="open-reader-raw">Raw</button>
            <button type="button" class="portfolio-mini-button opencode-copy-button" data-action="copy-raw-payload" data-raw-event-key="${escAttr(rawEventKey)}">Copy JSON</button>
            ${pairedKey ? `<button data-action="focus-capsule" data-capsule-key="${escAttr(pairedKey)}">${part.type === "tool" ? "Result" : "Call"}</button>` : ""}
          </div>
        </header>
        ${ocBody}
        ${childTrack ? renderSpawnReference(childTrack, context) : ""}
      </section>`;
  }
  const partBody = attachment
    ? renderAttachmentPartBody(part, rawEventKey)
    : system
    ? renderSystemPartBody(part, rawEventKey)
    : part.type === "tool"
    ? renderStructuredToolPayload(part)
    : part.type === "tool_result"
    ? `<pre>${esc(partText(part) || "(no payload)")}</pre>`
    : `<div class="part-text">${esc(partText(part) || "")}</div>`;
  return `
    <section class="reader-part ${escAttr(style)} ${part.state?.is_error ? "error" : ""}" data-nav-key="${escAttr(key)}" data-raw-event-key="${escAttr(rawEventKey)}" data-testid="${testId}">
      <header class="part-header">
        <strong>${esc(partHeaderLabel)}</strong>
        <div class="part-actions">
          ${part.type === "tool" && part.tool ? `<span class="tag">${esc(partKind.label)}</span>` : ""}
          ${part.nav?.toolUseId ? `<span class="tag">${esc(part.nav.toolUseId)}</span>` : ""}
          ${pairedKey ? `<button data-action="focus-capsule" data-capsule-key="${escAttr(pairedKey)}">${part.type === "tool" ? "Result" : "Call"}</button>` : ""}
          ${hasRawPayload ? `<button type="button" data-action="toggle-raw-payload" data-raw-event-key="${escAttr(rawEventKey)}" aria-expanded="false">View payload</button><button type="button" data-action="copy-raw-payload" data-raw-event-key="${escAttr(rawEventKey)}">Copy JSON</button>` : ""}
        </div>
      </header>
      ${partBody}
      ${childTrack ? renderSpawnReference(childTrack, context) : ""}
    </section>`;
}

function renderSpawnReference(track) {
  return `
    <div class="spawn-reference" data-linked-agent-id="${escAttr(track.id)}" aria-label="Subagent actions">
      <button data-action="open-panel" data-track-id="${escAttr(track.id)}">Open Subagent</button>
      <button data-action="focus-capsule" data-capsule-key="${escAttr(track.firstCapsuleKey)}">Jump to First</button>
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
  if (state.layout === "graph") state.readerRawCapsuleKey = "";
  els.workbench.dataset.layout = state.layout;
  els.readerLayout.classList.toggle("hidden", state.layout !== "reader");
  els.graphLayout.classList.toggle("hidden", state.layout !== "graph");
  els.graphLegendSection.classList.toggle("hidden", state.layout !== "graph");
  els.layoutButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.layout === state.layout));
  });
  if (state.layout === "graph") {
    setAgentTreeDrawerOpen(false);
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
    renderGraphStatus();
  } else if (state.layout === "reader") {
    updateSubagentPanelOverlayWidth();
    renderGraphStatus();
  }
  if (options.history !== false) {
    const url = new URL(location.href);
    if (state.layout === "reader") url.searchParams.set("layout", "waterfall");
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

function timelineTrackLabel(track, index = 0) {
  if (!track) return "Track";
  if (track.depth === 0) return "MAIN";
  const genericNames = new Set(["", "agent transcript", "subagent", "workflow-subagent"]);
  const agentType = String(track.agentType || "").trim();
  if (!genericNames.has(agentType.toLowerCase())) return agentType;
  const title = String(trackTitle(track) || "").trim();
  if (!genericNames.has(title.toLowerCase())) return title;
  return `Subagent ${index}`;
}

function timelineTrackMeta(track) {
  if (!track) return "";
  const count = track.capsuleKeys.length.toLocaleString();
  return `${count} blocks`;
}

function timelineTrackProblemLabel(track) {
  if (!track?.problemCount) return "";
  const count = track.problemCount.toLocaleString();
  return `${count} ${track.problemCount === 1 ? "problem" : "problems"}`;
}

function timelineTrackDescription(track) {
  if (!track) return "";
  if (track.depth === 0) return "";
  return track.agentDescription || track.title || "";
}

function compactModelName(value) {
  const modelName = String(value || "").trim();
  if (!modelName || modelName.toLowerCase() === "unknown") return "model unavailable";
  const parts = modelName
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-")
    .filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (/^\d+$/.test(parts[index]) && /^\d+$/.test(parts[index + 1])) {
      parts.splice(index, 2, `${parts[index]}.${parts[index + 1]}`);
      break;
    }
  }
  return parts.join(" ");
}

function timelineTrackModel(track) {
  return compactModelName(track?.modelName || track?.transcript?.summary?.model || "");
}

function timelineTrackKind(track) {
  return track?.depth === 0 ? "main" : "subagent";
}

function timelineBlockTypeName(type) {
  return typeStyle(type).label.toUpperCase();
}

const timelineBlockMeasure = {
  canvas: null,
  context: null,
};

function timelineBlockLabelName(kind, capsule) {
  if (kind?.contentLabel) return kind.contentLabel;
  if (kind?.line?.label) return kind.line.label;
  return typeStyle(capsule?.type).label || capsule?.type || "kind";
}

function timelineBlockTextWidth(value) {
  if (!timelineBlockMeasure.canvas) {
    timelineBlockMeasure.canvas = document.createElement("canvas");
    timelineBlockMeasure.context = timelineBlockMeasure.canvas.getContext("2d");
  }
  if (!timelineBlockMeasure.context) return String(value || "").length * 6;
  timelineBlockMeasure.context.font = "800 10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  return timelineBlockMeasure.context.measureText(String(value || "").toUpperCase()).width;
}

function timelineBlockLabelFits(label, capsule) {
  const width = Number(capsule?.width || model.blockWidth || 0);
  const horizontalChrome = 20;
  return timelineBlockTextWidth(label) <= Math.max(0, width - horizontalChrome);
}

function timelineBlockKindLabel(capsule, index) {
  void index;
  const kind = capsule?.kindModel;
  const labelName = kind ? timelineBlockLabelName(kind, capsule) : timelineBlockTypeName(capsule?.type).toLowerCase();
  const words = String(labelName || "kind").split(/\s+/).filter(Boolean);
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = words.slice(0, length).join(" ");
    if (timelineBlockLabelFits(candidate, capsule)) return candidate;
  }
  return words[0] || "kind";
}

function timelineTrackBounds(track) {
  return {
    left: track.x || 0,
    right: (track.x || 0) + model.trackWidth,
    top: track.timelineStartY || model.timelinePadTop,
    bottom: track.timelineEndY || model.height,
  };
}

function renderTimelineHeader() {
  if (!els.timelineHeader) return;
  const key = `${model.timelineLayoutVersion}:${model.width}:${model.tracks.length}:${state.selectedTrackId}:${model.tracks.map((track) => track.problemCount).join(",")}`;
  els.timelineHeader.style.width = `${model.width}px`;
  if (state.timelineHeaderKey === key) return;
  state.timelineHeaderKey = key;
  state.timelineHeaderRenderCount += 1;
  els.timelineHeader.innerHTML = compactHtml(model.tracks
    .map((track, index) => {
      const selected = track.id === state.selectedTrackId;
      const isMainTrack = track.depth === 0;
      const label = timelineTrackLabel(track, index);
      const description = timelineTrackDescription(track);
      const modelLabel = timelineTrackModel(track);
      const problemLabel = timelineTrackProblemLabel(track);
      const titleParts = [label, description, modelLabel, problemLabel].filter(Boolean);
      return `
        <div class="timeline-header-track ${timelineTrackKind(track)} ${selected ? "selected" : ""}" style="left:${track.x}px;width:${model.trackWidth}px">
          <button class="timeline-track-label ${isMainTrack ? "is-main" : ""} ${track.problemCount ? "has-problem" : ""}" data-action="select-track" data-track-id="${escAttr(track.id)}" data-testid="timeline-track-label" aria-selected="${selected ? "true" : "false"}" title="${escAttr(titleParts.join(" · "))}">
            <span class="timeline-track-kicker">${esc(isMainTrack ? "MAIN" : "SUBAGENT")}</span>
            ${isMainTrack ? "" : `<strong>${esc(label)}</strong>
            <span class="timeline-track-description">${esc(description || "No description")}</span>`}
            <span class="timeline-track-model">${esc(modelLabel)}</span>
            <small>${esc(timelineTrackMeta(track))}</small>
            ${problemLabel ? `<span class="timeline-track-error-icon" aria-label="${escAttr(problemLabel)}" title="${escAttr(problemLabel)}">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5v4" />
                <path d="M8 11.5h.01" />
              </svg>
            </span>` : ""}
          </button>
        </div>`;
    })
    .join(""));
}

function renderTimelineTracks(visibleTracks) {
  const key = `${model.timelineLayoutVersion}:${model.width}:${model.height}:${state.selectedTrackId}:${visibleTracks.map((track) => track.id).join("|")}`;
  if (state.timelineTrackKey === key) return;
  state.timelineTrackKey = key;
  state.timelineTrackRenderCount += 1;
  els.graphLanes.innerHTML = compactHtml(visibleTracks
    .map((track) => {
      const selected = track.id === state.selectedTrackId;
      return `
      <div class="timeline-track ${timelineTrackKind(track)} ${selected ? "selected" : ""}" data-track-id="${escAttr(track.id)}" style="left:${track.x}px;top:0px;width:${model.trackWidth}px;height:${model.height}px"></div>`;
    })
    .join(""));
}

function renderGraphVirtual() {
  if (state.layout !== "graph") return;
  const viewport = els.graphViewport;
  layoutGraph(viewport.clientWidth);
  const viewLeft = viewport.scrollLeft;
  const viewTop = viewport.scrollTop;
  const viewRight = viewLeft + viewport.clientWidth;
  const viewBottom = viewTop + viewport.clientHeight;
  const overscanX = 320;
  const overscanY = Math.max(360, Math.min(640, viewport.clientHeight * 0.22));
  const verticalChunkHeight = model.blockStepY * 96;
  const visibleTracks = model.tracks.filter((track) => {
    const bounds = timelineTrackBounds(track);
    return bounds.right >= viewLeft - overscanX && bounds.left <= viewRight + overscanX;
  });

  els.graphSizer.style.width = `${model.width}px`;
  els.graphSizer.style.height = `${model.height}px`;
  els.graphLayer.style.width = `${model.width}px`;
  els.graphLayer.style.height = `${model.height}px`;
  els.graphEdges.setAttribute("width", String(model.width));
  els.graphEdges.setAttribute("height", String(model.height));
  els.graphEdges.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);

  renderTimelineHeader();
  renderTimelineTracks(visibleTracks);

  const windowTop = Math.max(0, Math.floor((viewTop - overscanY) / verticalChunkHeight) * verticalChunkHeight);
  const windowBottom = Math.ceil((viewBottom + overscanY) / verticalChunkHeight) * verticalChunkHeight;
  const rangeByTrack = visibleTracks.map((track) => ({
    track,
    start: Math.max(0, Math.floor((windowTop - track.timelineStartY) / model.blockStepY)),
    end: Math.min(track.capsuleKeys.length - 1, Math.ceil((windowBottom - track.timelineStartY) / model.blockStepY)),
  }));
  const selectionKey = `${state.currentCapsuleKey}:${[...state.selectedGraphKeys].sort().join(",")}`;
  const blockKey = `${model.timelineLayoutVersion}:${selectionKey}:${windowTop}:${windowBottom}:${visibleTracks.map((track) => track.id).join("|")}`;
  if (state.timelineBlockKey !== blockKey) {
    state.timelineBlockKey = blockKey;
    state.timelineBlockRenderCount += 1;
    const blockHtml = [];
    rangeByTrack.forEach(({ track, start, end }) => {
      for (let index = start; index <= end; index += 1) {
        const key = track.capsuleKeys[index];
        const capsule = capsuleByKey.get(key);
        if (!capsule) continue;
        const active = key === state.currentCapsuleKey;
        const selected = state.selectedGraphKeys.has(key);
        const style = typeStyle(capsule.type);
        const kind = capsule.kindModel || rawEventKindModel(capsule.rawEvent);
        const noSubtype = kind.contentKinds.length ? "" : "no-subtype";
        blockHtml.push(`
          <button class="portfolio-timeline-block timeline-block ${style.className} ${noSubtype} ${active ? "active" : ""} ${selected ? "selected" : ""} ${capsule.problemCount ? "has-problem" : ""}" data-action="timeline-block" data-capsule-key="${escAttr(key)}" data-testid="timeline-block" data-line-kind="${escAttr(kind.line.key)}" data-content-kinds="${escAttr(kind.contentKinds.map((item) => item.label).join(","))}" style="left:${capsule.x}px;top:${capsule.y}px;width:${capsule.width}px;height:${capsule.height}px" title="${escAttr(`${kind.fullLabel}: ${capsule.summary}`)}" aria-label="${escAttr(`${timelineTrackLabel(track)} ${index + 1}, ${kind.fullLabel}${capsule.problemCount ? `, ${capsule.problemCount} problems` : ""}`)}">
            <span class="portfolio-timeline-block-label timeline-block-label" data-full-label="${escAttr(timelineBlockKindLabel(capsule, index))}">${esc(timelineBlockKindLabel(capsule, index))}</span>
          </button>`);
      }
    });
    els.graphCapsules.innerHTML = compactHtml(blockHtml.join(""));
  }
  els.graphEdges.innerHTML = renderVisibleEdges(viewLeft - overscanX, viewTop - overscanY, viewRight + overscanX, viewBottom + overscanY);
  renderGraphStatus();
}

function capsuleInView(capsule, left, top, right, bottom) {
  if (!capsule) return false;
  return capsule.x + capsule.width >= left && capsule.x <= right && capsule.y + capsule.height >= top && capsule.y <= bottom;
}

function renderVisibleEdges(left, top, right, bottom) {
  const defs = `
    <defs>
      <marker id="timelineArrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L8,3 z" class="timeline-arrow-head"></path>
      </marker>
      <marker id="timelineArrowSelected" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L8,3 z" class="timeline-arrow-head selected"></path>
      </marker>
    </defs>`;
  const paths = model.spawnEdges
    .map((edge) => {
      const source = capsuleByKey.get(edge.sourceKey);
      const target = capsuleByKey.get(edge.targetKey);
      if (!source || !target) return "";
      const selected = edge.sourceKey === state.currentCapsuleKey || edge.targetKey === state.currentCapsuleKey || state.selectedGraphKeys.has(edge.sourceKey) || state.selectedGraphKeys.has(edge.targetKey);
      const targetTrack = trackById.get(edge.trackId || target.trackId);
      const sx = source.x + source.width;
      const sy = source.y + source.height / 2;
      const columnCenterX = targetTrack
        ? targetTrack.x + targetTrack.width / 2
        : target.x + target.width / 2;
      const targetTopCenterY = target.y;
      const edgeLeft = Math.min(sx, columnCenterX);
      const edgeRight = Math.max(sx, columnCenterX);
      const edgeTop = Math.min(sy, targetTopCenterY);
      const edgeBottom = Math.max(sy, targetTopCenterY);
      const edgeVisible = edgeRight >= left && edgeLeft <= right && edgeBottom >= top && edgeTop <= bottom;
      if (!selected && !edgeVisible) return "";
      const d = `M ${sx} ${sy} L ${columnCenterX} ${sy} L ${columnCenterX} ${targetTopCenterY}`;
      return `<path class="timeline-connector ${escAttr(edge.type)} ${selected ? "selected" : ""}" data-testid="timeline-spawn-connector" data-source-key="${escAttr(edge.sourceKey)}" data-target-key="${escAttr(edge.targetKey)}" d="${escAttr(d)}" marker-end="url(#${selected ? "timelineArrowSelected" : "timelineArrow"})" />`;
    })
    .join("");
  return defs + paths;
}

function timelinePinnedDetailKeys() {
  const seen = new Set();
  const keys = state.pinnedTimelineDetailKeys.filter((key) => {
    if (!capsuleByKey.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (keys.length !== state.pinnedTimelineDetailKeys.length) state.pinnedTimelineDetailKeys = keys;
  return keys;
}

function timelineDetailWindows(capsule) {
  const pinnedKeys = timelinePinnedDetailKeys();
  const windows = pinnedKeys
    .map((key) => capsuleByKey.get(key))
    .filter(Boolean)
    .map((pinnedCapsule) => ({ mode: "pinned", capsule: pinnedCapsule }));
  const selectedKeys = [...state.selectedGraphKeys].filter((key) => capsuleByKey.has(key) && !pinnedKeys.includes(key));
  if (selectedKeys.length > 1) {
    selectedKeys.forEach((key) => windows.push({ mode: "live", capsule: capsuleByKey.get(key) }));
  } else {
    const liveCapsule = capsule || capsuleByKey.get(selectedKeys[0]);
    if (liveCapsule && !pinnedKeys.includes(liveCapsule.key)) {
      windows.push({ mode: "live", capsule: liveCapsule });
    }
  }
  return windows;
}

function timelineDetailWindowLayoutArea() {
  const viewportRect = els.graphViewport?.getBoundingClientRect() || {
    left: 0,
    top: 0,
    right: window.innerWidth,
    width: window.innerWidth,
  };
  const headerBeforeHeight = els.timelineHeader
    ? Number.parseFloat(window.getComputedStyle(els.timelineHeader, "::before").height) || 0
    : 0;
  const labelBottoms = [...document.querySelectorAll("[data-testid='timeline-track-label']")]
    .map((label) => label.getBoundingClientRect().bottom)
    .filter((value) => Number.isFinite(value));
  const agentListBottom = Math.max(viewportRect.top + headerBeforeHeight, ...labelBottoms);
  const gapBelowAgentList = 12;
  const viewportInset = 24;
  const left = Math.max(0, viewportRect.left);
  const right = Math.min(window.innerWidth, Math.max(left, viewportRect.right || window.innerWidth));
  const top = Math.max(0, agentListBottom + gapBelowAgentList);
  const height = Math.max(180, window.innerHeight - top - viewportInset);
  const width = Math.max(0, right - left);
  return {
    left,
    top,
    right,
    bottom: top + height,
    width,
    height,
    agentListBottom,
    gapBelowAgentList,
  };
}

function applyTimelineDetailWindowLayout(layout) {
  if (!els.timelineDetailPanel) return;
  const { area } = layout;
  els.timelineDetailPanel.style.setProperty("--timeline-detail-layout-left", `${area.left}px`);
  els.timelineDetailPanel.style.setProperty("--timeline-detail-layout-top", `${area.top}px`);
  els.timelineDetailPanel.style.setProperty("--timeline-detail-layout-width", `${area.width}px`);
  els.timelineDetailPanel.style.setProperty("--timeline-detail-layout-height", `${area.height}px`);
  els.timelineDetailPanel.style.setProperty("--timeline-detail-window-width", `${layout.panelWidth}px`);
  els.timelineDetailPanel.style.setProperty("--timeline-detail-window-max-height", `${layout.panelMaxHeight}px`);
  els.timelineDetailPanel.dataset.columns = String(layout.columns);
  els.timelineDetailPanel.dataset.rows = String(layout.rows);
  els.timelineDetailPanel.dataset.windowLayoutAreaLeft = String(Math.round(area.left));
  els.timelineDetailPanel.dataset.windowLayoutAreaTop = String(Math.round(area.top));
  els.timelineDetailPanel.dataset.windowLayoutAreaRight = String(Math.round(area.right));
  els.timelineDetailPanel.dataset.windowLayoutAreaBottom = String(Math.round(area.bottom));
  els.timelineDetailPanel.dataset.windowLayoutAreaWidth = String(Math.round(area.width));
  els.timelineDetailPanel.dataset.windowLayoutAreaHeight = String(Math.round(area.height));
  els.timelineDetailPanel.dataset.windowLayoutAgentListBottom = String(Math.round(area.agentListBottom));
}

function updateTimelineDetailDockLayout(count = document.querySelectorAll("[data-testid='timeline-detail-panel']").length) {
  if (!els.timelineDetailPanel) return;
  const gap = 12;
  const minPanelWidth = 320;
  const maxPanelWidth = 480;
  const minPanelHeight = 220;
  const dockPaddingInline = 24;
  const dockPaddingBottom = 24;
  const area = timelineDetailWindowLayoutArea();
  const usableWidth = Math.max(160, area.width - dockPaddingInline * 2);
  const usableHeight = Math.max(160, area.height - dockPaddingBottom);
  const effectiveMinPanelWidth = Math.min(minPanelWidth, Math.max(220, usableWidth));
  const maxColumns = Math.max(1, Math.floor((usableWidth + gap) / (effectiveMinPanelWidth + gap)));
  const columns = Math.max(1, Math.min(Math.max(count, 1), maxColumns));
  const widthByColumns = Math.floor((usableWidth - gap * (columns - 1)) / columns);
  const panelWidth = Math.min(maxPanelWidth, Math.max(160, widthByColumns));
  const rows = Math.max(1, Math.ceil(Math.max(count, 1) / columns));
  const heightByRows = Math.floor((usableHeight - gap * (rows - 1)) / rows);
  const panelMaxHeight = Math.min(620, Math.max(minPanelHeight, heightByRows));
  const layout = {
    area,
    columns,
    rows,
    count,
    gap,
    panelWidth,
    panelMaxHeight,
    dockPaddingInline,
    dockPaddingBottom,
  };
  state.timelineDetailWindowLayout = layout;
  applyTimelineDetailWindowLayout(layout);
}

function renderTimelineDetailPart(part, partIndex) {
  const attachment = isAttachmentPart(part);
  const system = isSystemPart(part);
  const rawEventKey = eventAddress(part.nav);
  const lineKind = kindForLineType(rawEventByAddress.get(rawEventKey)?.raw?.type || "");
  const partKind = partContentKind(part, lineKind);
  const partHeaderLabel = attachment || system ? "Details" : part.type === "tool" ? part.tool || partKind.label : partKind.label;
  if (window.OpenCodeRenderer?.isOpenCodePart(part)) {
    return window.OpenCodeRenderer.renderOpenCodeTimelinePart(part);
  }
  if (attachment) return renderPortfolioAttachmentPartBody(part, rawEventKey);
  if (system) return renderPortfolioSystemPartBody(part, rawEventKey);
  if (part.type === "tool") {
    const rows = [["Tool", part.tool || partKind.label]];
    if (part.nav?.toolUseId) rows.push(["Tool Use ID", part.nav.toolUseId]);
    return renderPortfolioDisplayBody({
      summary: "",
      rows,
      sections: [textAttachmentSection("input", "Input", part.state?.input || part.state || {}, { keepEmpty: true })],
    }, { includeSummary: false });
  }
  if (part.type === "tool_result") {
    const rows = [];
    if (part.nav?.toolUseId) rows.push(["Tool Use ID", part.nav.toolUseId]);
    return renderPortfolioDisplayBody({
      summary: "",
      rows,
      sections: [textAttachmentSection("output", part.state?.is_error ? "Error" : "Output", partText(part) || "(no payload)", { keepEmpty: true })],
    }, { includeSummary: false });
  }
  return renderPortfolioFormText(partHeaderLabel || `Part ${partIndex + 1}`, partText(part) || "(empty)", { multiline: true });
}

function timelineDetailProblemText(problem) {
  return compact(`${problem.kind || "problem"}: ${problem.message || problem.reason || problem.id || ""}`, 180);
}

function timelineDetailCommonFailures(problems, parts) {
  const failures = [];
  problems.forEach((problem) => {
    const haystack = `${problem.kind || ""} ${problem.message || ""} ${problem.reason || ""}`.toLowerCase();
    if (/(error|failure|failed|interrupted|denied|not found|hook|parser)/.test(haystack)) {
      failures.push(timelineDetailProblemText(problem));
    }
  });
  parts.forEach((part) => {
    if (part.state?.is_error) failures.push(`${typeStyle(part.type).label || part.type || "part"} reported an error`);
  });
  return [...new Set(failures)].filter(Boolean);
}

function timelineDetailHasError(problems, parts) {
  return problems.some((problem) => problem.severity === "error") || timelineDetailCommonFailures(problems, parts).length > 0;
}

function timelineDetailRawEvents(displayCapsule, parts) {
  const addresses = new Set();
  if (displayCapsule.rawOnly && displayCapsule.rawEvent) addresses.add(eventAddress(displayCapsule.rawEvent.nav));
  addresses.add(eventAddress(displayCapsule.nav));
  parts.forEach((part) => addresses.add(eventAddress(part.nav)));
  const seen = new Set();
  return [...addresses]
    .filter(Boolean)
    .map((address) => rawEventByAddress.get(address))
    .filter(Boolean)
    .filter((event) => {
      const key = eventAddress(event.nav);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatRawJsonlValue(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return text(value);
}

function renderTimelineDetailRaw(displayCapsule, parts) {
  const rawEvents = timelineDetailRawEvents(displayCapsule, parts);
  const fallback = displayCapsule.rawOnly ? displayCapsule.rawEvent?.raw : displayCapsule.message || displayCapsule.rawEvent?.raw;
  const rawValue = rawEvents.length === 1
    ? rawEvents[0].raw
    : rawEvents.length
      ? rawEvents.map((event) => event.raw)
      : fallback;
  return `<pre class="portfolio-detail-raw timeline-detail-raw-code"><code>${esc(formatRawJsonlValue(rawValue) || "(raw JSONL unavailable)")}</code></pre>`;
}

function pinIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="timeline-detail-pin-icon"><path d="M12 17v5" /><path d="M5 17h14v-1.8a2 2 0 0 0-.6-1.4L16 11.4V6h1a1 1 0 0 0 1-1V2H6v3a1 1 0 0 0 1 1h1v5.4l-2.4 2.4A2 2 0 0 0 5 15.2Z" /></svg>`;
}

function renderTimelineDetailMetadata(displayCapsule, track, timestamp, problems, parts, kind) {
  const commonFailures = timelineDetailCommonFailures(problems, parts);
  const problemSummary = problems.length === 1 ? "1 problem" : problems.length ? `${problems.length} problems` : "None";
  return `
    <div class="portfolio-detail-form timeline-detail-form">
    <dl class="portfolio-meta timeline-detail-meta">
      <dt>Line type</dt><dd>${esc(kind?.line?.label || displayCapsule.lineType || "Unknown")}</dd>
      <dt>Content types</dt><dd>${esc(kind?.contentLabel || (displayCapsule.contentTypes || []).join(", ") || "Unknown")}</dd>
      <dt>Agent</dt><dd>${esc(timelineTrackLabel(track))}</dd>
      <dt>Block</dt><dd>${displayCapsule.messageIndex + 1}</dd>
      <dt>Time</dt><dd>${timestamp ? esc(timestamp) : "Unknown"}</dd>
      <dt>Line</dt><dd>${displayCapsule.nav?.lineNumber || "Unknown"}</dd>
      <dt>Path</dt><dd>${esc(displayCapsule.nav?.agentPath || "main")}</dd>
      <dt>Problems</dt><dd>${esc(problemSummary)}</dd>
      <dt>Common failures</dt><dd>${commonFailures.length ? commonFailures.map(esc).join("<br>") : "None"}</dd>
    </dl>
    ${problems.length ? renderPortfolioFormTable(
      "Problems",
      ["Kind", "Message"],
      problems.map((problem) => [problem.kind || "problem", problem.message || problem.reason || problem.id || ""]),
      { countLabel: `${problems.length.toLocaleString()} items` },
    ) : ""}
    </div>`;
}

function renderTimelineDetailWindow(item, index) {
  const displayCapsule = item.capsule;
  const pinned = item.mode === "pinned";
  const canPin = state.layout === "graph";
  const track = trackById.get(displayCapsule.trackId);
  const kind = displayCapsule.kindModel || (displayCapsule.rawOnly ? rawEventKindModel(displayCapsule.rawEvent) : messageKindModel(displayCapsule.message));
  const timestamp = formatFullTime(displayCapsule.timestamp);
  const problems = displayCapsule.problems || [];
  const parts = displayCapsule.message?.parts || [];
  const hasError = timelineDetailHasError(problems, parts);
  const detailId = `timeline-detail-${index}-${domId(displayCapsule.key)}`;
  const initialTab = ["contents", "metadata", "raw"].includes(item.initialTab) ? item.initialTab : "contents";
  const titlebarContent = item.mode === "reader-raw"
    ? `<strong>${esc(item.title || "Raw JSON")}</strong>`
    : renderTimelineDetailKindStack(kind);
  const bodyHtml = displayCapsule.rawOnly
    ? renderPortfolioRawEventBody(displayCapsule.rawEvent)
    : `<div class="portfolio-detail-form timeline-detail-form timeline-detail-parts">
        ${parts.map(renderTimelineDetailPart).join("") || '<p class="muted">(no content)</p>'}
      </div>`;
  const metadataHtml = renderTimelineDetailMetadata(displayCapsule, track, timestamp, problems, parts, kind);
  const rawHtml = renderTimelineDetailRaw(displayCapsule, parts);
  return `
    <article class="portfolio-detail-window timeline-detail-window ${pinned ? "pinned" : "live"}" data-testid="timeline-detail-panel" data-detail-mode="${escAttr(item.mode)}" data-detail-capsule-key="${escAttr(displayCapsule.key)}" data-detail-index="${index}" data-detail-tab="${escAttr(initialTab)}">
      <header class="portfolio-detail-titlebar timeline-detail-titlebar" data-detail-section="titlebar">
        ${titlebarContent}
        <div class="timeline-detail-actions">
          ${canPin ? `<button type="button" class="timeline-detail-pin ${pinned ? "active" : ""}" data-action="toggle-timeline-detail-pin" data-testid="timeline-detail-pin" aria-pressed="${pinned ? "true" : "false"}" aria-label="${pinned ? "Unpin message detail" : "Pin message detail"}" title="${pinned ? "Unpin" : "Pin"}">${pinIconSvg()}</button>` : ""}
          <button type="button" class="timeline-detail-close" data-action="close-timeline-detail" aria-label="Close timeline detail">&times;</button>
        </div>
      </header>
      <section class="portfolio-detail-switches timeline-detail-switch-section" data-detail-section="switches">
        <div class="portfolio-detail-tabs timeline-detail-tablist" role="tablist" aria-label="Message detail sections">
          <button type="button" class="timeline-detail-tab ${initialTab === "contents" ? "active" : ""}" role="tab" data-action="timeline-detail-tab" data-portfolio-detail-tab="contents" data-detail-tab-target="contents" id="${detailId}-contents-tab" aria-controls="${detailId}-contents-panel" aria-selected="${initialTab === "contents" ? "true" : "false"}" ${initialTab === "contents" ? "" : 'tabindex="-1"'}>Contents</button>
          <button type="button" class="timeline-detail-tab ${initialTab === "metadata" ? "active" : ""}" role="tab" data-action="timeline-detail-tab" data-portfolio-detail-tab="metadata" data-detail-tab-target="metadata" id="${detailId}-metadata-tab" aria-controls="${detailId}-metadata-panel" aria-selected="${initialTab === "metadata" ? "true" : "false"}" ${initialTab === "metadata" ? "" : 'tabindex="-1"'}>Metadata${hasError ? '<span class="timeline-detail-tab-alert" aria-label="Contains errors">!</span>' : ""}</button>
          <button type="button" class="timeline-detail-tab ${initialTab === "raw" ? "active" : ""}" role="tab" data-action="timeline-detail-tab" data-portfolio-detail-tab="raw" data-detail-tab-target="raw" id="${detailId}-raw-tab" aria-controls="${detailId}-raw-panel" aria-selected="${initialTab === "raw" ? "true" : "false"}" ${initialTab === "raw" ? "" : 'tabindex="-1"'}>Raw</button>
        </div>
      </section>
      <section class="portfolio-detail-active-panel timeline-detail-active-section" data-detail-section="active-panel">
        <div class="portfolio-detail-panel timeline-detail-panel-section" data-portfolio-detail-panel="contents" data-detail-panel="contents" id="${detailId}-contents-panel" role="tabpanel" aria-labelledby="${detailId}-contents-tab" ${initialTab === "contents" ? "" : "hidden"}>
          ${bodyHtml}
        </div>
        <div class="portfolio-detail-panel timeline-detail-panel-section" data-portfolio-detail-panel="metadata" data-detail-panel="metadata" id="${detailId}-metadata-panel" role="tabpanel" aria-labelledby="${detailId}-metadata-tab" ${initialTab === "metadata" ? "" : "hidden"}>
          ${metadataHtml}
        </div>
        <div class="portfolio-detail-panel timeline-detail-panel-section" data-portfolio-detail-panel="raw" data-detail-panel="raw" id="${detailId}-raw-panel" role="tabpanel" aria-labelledby="${detailId}-raw-tab" ${initialTab === "raw" ? "" : "hidden"}>
          ${rawHtml}
        </div>
      </section>
    </article>`;
}

function renderTimelineDetailPanel(capsule) {
  if (!els.timelineDetailPanel) {
    state.timelineDetailKey = "";
    state.pinnedTimelineDetailKeys = [];
    return;
  }
  const readerRawCapsule = state.layout === "reader" && state.readerRawCapsuleKey
    ? capsuleByKey.get(state.readerRawCapsuleKey)
    : null;
  const windows = state.layout === "graph"
    ? timelineDetailWindows(capsule)
    : readerRawCapsule
      ? [{ capsule: readerRawCapsule, mode: "reader-raw", initialTab: "raw", title: "Raw JSON" }]
      : [];
  updateTimelineDetailDockLayout(windows.length);
  if (!windows.length) {
    if (state.timelineDetailKey !== "" || !els.timelineDetailPanel.classList.contains("hidden")) {
      state.timelineDetailKey = "";
      els.timelineDetailPanel.classList.add("hidden");
      els.timelineDetailPanel.dataset.pinned = "false";
      els.timelineDetailPanel.dataset.detailCapsuleKey = "";
      els.timelineDetailPanel.innerHTML = "";
    }
    return;
  }
  const detailKey = windows.map((item) => `${item.mode}:${item.capsule.key}:${item.capsule.problemCount}`).join("|");
  if (state.timelineDetailKey === detailKey) return;
  state.timelineDetailKey = detailKey;
  state.timelineDetailRenderCount += 1;
  els.timelineDetailPanel.classList.remove("hidden");
  els.timelineDetailPanel.dataset.pinned = String(windows.some((item) => item.mode === "pinned"));
  els.timelineDetailPanel.dataset.detailCapsuleKey = windows[0]?.capsule.key || "";
  els.timelineDetailPanel.innerHTML = compactHtml(windows.map(renderTimelineDetailWindow).join(""));
}

function renderGraphStatus() {
  if (state.selectedGraphKeys.size > 1) {
    const textContent = `${state.selectedGraphKeys.size} transcript elements selected`;
    if (state.graphStatusText !== textContent) {
      state.graphStatusText = textContent;
      els.graphStatus.textContent = textContent;
    }
    renderTimelineDetailPanel(null);
    return;
  }
  const capsule = selectedCapsule();
  const textContent = capsule
    ? `${capsule.kindModel?.fullLabel || typeStyle(capsule.type).label} · ${capsule.nav?.agentPath || "main"} · ${capsule.summary}${capsule.problemCount ? ` · ${capsule.problemCount} problems` : ""}`
    : "";
  if (state.graphStatusText !== textContent) {
    state.graphStatusText = textContent;
    els.graphStatus.textContent = textContent;
  }
  renderTimelineDetailPanel(capsule);
}

function scrollGraphCapsuleIntoView(capsule, instant = false) {
  if (!capsule) return;
  const viewport = els.graphViewport;
  layoutGraph(viewport.clientWidth);
  const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const targetLeft = capsule.x + capsule.width / 2 - viewport.clientWidth / 2;
  const targetTop = capsule.y + capsule.height / 2 - viewport.clientHeight / 2;
  els.graphViewport.scrollTo({
    left: Math.min(maxLeft, Math.max(0, targetLeft)),
    top: Math.min(maxTop, Math.max(0, targetTop)),
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

function removePinnedTimelineDetailKey(key) {
  state.pinnedTimelineDetailKeys = state.pinnedTimelineDetailKeys.filter((pinnedKey) => pinnedKey !== key);
}

function toggleTimelineDetailPin(button) {
  const detailWindow = button?.closest("[data-testid='timeline-detail-panel']");
  const detailKey = detailWindow?.dataset.detailCapsuleKey || "";
  const targetKey = detailKey || state.currentCapsuleKey;
  if (!targetKey || !capsuleByKey.has(targetKey)) return;
  if (state.pinnedTimelineDetailKeys.includes(targetKey)) removePinnedTimelineDetailKey(targetKey);
  else state.pinnedTimelineDetailKeys.push(targetKey);
  state.timelineDetailKey = "";
  renderGraphStatus();
}

function closeTimelineDetail(button) {
  const detailWindow = button?.closest("[data-testid='timeline-detail-panel']");
  const detailKey = detailWindow?.dataset.detailCapsuleKey || "";
  const mode = detailWindow?.dataset.detailMode || "";
  if (mode === "reader-raw") {
    state.readerRawCapsuleKey = "";
  } else if (mode === "pinned" && detailKey) {
    removePinnedTimelineDetailKey(detailKey);
    if (state.currentCapsuleKey === detailKey) {
      state.currentCapsuleKey = "";
      state.selectedGraphKeys.delete(detailKey);
    }
  } else if (detailKey) {
    state.selectedGraphKeys.delete(detailKey);
    if (state.currentCapsuleKey === detailKey) state.currentCapsuleKey = "";
  } else {
    state.selectedGraphKeys.clear();
    state.currentCapsuleKey = "";
  }
  state.timelineDetailKey = "";
  renderGraphStatus();
  renderReaderActiveState();
  renderBreadcrumb();
  scheduleGraphRender();
  updateNavigationButtons();
}

function openReaderRaw(button) {
  const key = button?.closest(".reader-message")?.dataset.capsuleKey || "";
  if (!key || !capsuleByKey.has(key)) return;
  state.readerRawCapsuleKey = key;
  focusCapsule(key, { scroll: false });
  renderTimelineDetailPanel(capsuleByKey.get(key));
}

function setTimelineDetailTab(button) {
  const detailWindow = button?.closest("[data-testid='timeline-detail-panel']");
  const target = button?.dataset.detailTabTarget || "contents";
  const tab = ["contents", "metadata", "raw"].includes(target) ? target : "contents";
  if (!detailWindow) return;
  detailWindow.dataset.detailTab = tab;
  detailWindow.querySelectorAll(".timeline-detail-tab").forEach((tabButton) => {
    const selected = tabButton.dataset.detailTabTarget === tab;
    tabButton.setAttribute("aria-selected", String(selected));
    tabButton.tabIndex = selected ? 0 : -1;
    tabButton.classList.toggle("active", selected);
  });
  detailWindow.querySelectorAll("[data-detail-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.detailPanel !== tab;
  });
}

function renderReaderActiveState() {
  document.querySelectorAll(".reader-message.active").forEach((node) => {
    node.classList.remove("active");
    node.setAttribute("aria-current", "false");
  });
  const capsule = selectedCapsule();
  if (!capsule) return;
  const element = document.getElementById(readerMessageId(capsule.trackId, capsule.messageIndex));
  if (element) {
    element.classList.add("active");
    element.setAttribute("aria-current", "true");
  }
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
  const canFocusTrack = track.depth === 0 || shouldOpen || wasOpen;
  if (track.firstCapsuleKey && options.focus !== false && !wasSelected && canFocusTrack) {
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
  if (!els.breadcrumb) return;
  const capsule = selectedCapsule();
  const nav = currentNav();
  const parts = ["Sessions", SESSION_DATA.summary?.title || "Session"];
  if (state.layout === "graph") parts.push("Timeline");
  else parts.push("Waterfall");
  if (nav?.agentPath) parts.push(...nav.agentPath.split("/"));
  if (capsule) parts.push(capsule.kindModel?.fullLabel || typeStyle(capsule.type).label);
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

function copyText(value, message = "Copied link") {
  navigator.clipboard?.writeText(value);
  setLinkStatus(message);
  if (state.linkStatusTimer) clearTimeout(state.linkStatusTimer);
  state.linkStatusTimer = setTimeout(() => {
    setLinkStatus("");
    state.linkStatusTimer = null;
  }, 1600);
}

function rawPayloadContainerForButton(button) {
  const scope = button.closest(".reader-part");
  return scope?.querySelector("[data-raw-payload]") || null;
}

function toggleRawPayload(button) {
  const rawEventKey = button.dataset.rawEventKey || button.closest("[data-raw-event-key]")?.dataset.rawEventKey || "";
  const target = rawPayloadContainerForButton(button);
  if (!rawEventKey || !target) return;
  const opening = target.classList.contains("hidden");
  if (opening && !target.dataset.loaded) {
    const payload = rawPayloadTextForKey(rawEventKey);
    target.innerHTML = `<header>Raw JSON</header><pre>${esc(payload || "(raw payload unavailable)")}</pre>`;
    target.dataset.loaded = "true";
  }
  target.classList.toggle("hidden", !opening);
  button.setAttribute("aria-expanded", String(opening));
  button.textContent = opening ? "Hide payload" : "View payload";
}

function copyRawPayload(button) {
  const rawEventKey = button.dataset.rawEventKey || button.closest("[data-raw-event-key]")?.dataset.rawEventKey || "";
  const payload = rawPayloadTextForKey(rawEventKey);
  if (payload) copyText(payload, "Copied raw JSON");
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

function timelineMetrics() {
  const viewportRect = els.graphViewport.getBoundingClientRect();
  const headerRect = els.timelineHeader.getBoundingClientRect();
  const detailDockRect = els.timelineDetailPanel?.getBoundingClientRect() || { left: 0, right: 0, width: 0, height: 0 };
  const detailWindowLayoutArea = state.timelineDetailWindowLayout?.area || null;
  const mainTrack = model.tracks[0] || null;
  const trackGroupRight = model.timelineTrackGroupLeft + model.timelineTrackSpan;
  const trackGroupCenter = model.timelineTrackGroupLeft + model.timelineTrackSpan / 2;
  const currentBlock = state.currentCapsuleKey
    ? [...document.querySelectorAll("[data-testid='timeline-block']")].find((element) => element.dataset.capsuleKey === state.currentCapsuleKey)
    : null;
  const currentBlockRect = currentBlock?.getBoundingClientRect();
  const currentBlockCenterDelta = currentBlockRect
    ? {
      x: currentBlockRect.left + currentBlockRect.width / 2 - (viewportRect.left + viewportRect.width / 2),
      y: currentBlockRect.top + currentBlockRect.height / 2 - (viewportRect.top + viewportRect.height / 2),
    }
    : null;
  const blocks = [...document.querySelectorAll("[data-testid='timeline-block']")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      color: window.getComputedStyle(element).backgroundColor,
      key: element.dataset.capsuleKey || "",
    };
  });
  const labels = [...document.querySelectorAll("[data-testid='timeline-track-label']")].map((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      zIndex: Number.parseInt(style.zIndex, 10) || 0,
      text: element.innerText.replace(/\s+/g, " ").trim(),
    };
  });
  const viewportStyle = window.getComputedStyle(els.graphViewport);
  const headerStyle = window.getComputedStyle(els.timelineHeader);
  const blockStyle = blocks.length ? window.getComputedStyle(document.querySelector("[data-testid='timeline-block']")) : null;
  const detailWindows = [...document.querySelectorAll("[data-testid='timeline-detail-panel']")].map((element) => {
    const rect = element.getBoundingClientRect();
    const pin = element.querySelector("[data-testid='timeline-detail-pin']");
    return {
      key: element.dataset.detailCapsuleKey || "",
      mode: element.dataset.detailMode || "",
      pinned: element.dataset.detailMode === "pinned",
      pinPressed: pin?.getAttribute("aria-pressed") || "",
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
  return {
    viewportWidth: viewportRect.width,
    viewportHeight: viewportRect.height,
    viewportScrollLeft: els.graphViewport.scrollLeft,
    viewportScrollTop: els.graphViewport.scrollTop,
    scrollWidth: els.graphViewport.scrollWidth,
    trackWidth: model.trackWidth,
    trackSpan: model.timelineTrackSpan,
    trackGroupLeft: model.timelineTrackGroupLeft,
    trackGroupRight,
    trackGroupCenter,
    trackGroupCenterDelta: trackGroupCenter - (els.graphViewport.scrollLeft + viewportRect.width / 2),
    trackGroupFitsViewport: model.timelineTrackSpan <= viewportRect.width,
    mainTrackLeft: mainTrack?.x || 0,
    mainTrackRight: mainTrack ? mainTrack.x + model.trackWidth : 0,
    mainTrackVisibleInitially: mainTrack
      ? mainTrack.x + model.trackWidth > els.graphViewport.scrollLeft && mainTrack.x < els.graphViewport.scrollLeft + viewportRect.width
      : false,
    renderedBlocks: blocks.length,
    renderedConnectors: document.querySelectorAll(".timeline-connector.spawn").length,
    renderedHeaderLabels: labels.length,
    uniqueBlockWidths: [...new Set(blocks.map((block) => block.width))],
    uniqueBlockHeights: [...new Set(blocks.map((block) => block.height))],
    uniqueBlockColors: [...new Set(blocks.map((block) => block.color))],
    uniqueHeaderHeights: [...new Set(labels.map((label) => label.height))],
    uniqueHeaderTops: [...new Set(labels.map((label) => label.top))],
    maxHeaderTextLength: labels.reduce((max, label) => Math.max(max, label.text.length), 0),
    headerPosition: headerStyle.position,
    headerZIndex: Number.parseInt(headerStyle.zIndex, 10) || 0,
    blockZIndex: blockStyle ? Number.parseInt(blockStyle.zIndex, 10) || 0 : 0,
    backgroundImage: viewportStyle.backgroundImage,
    renderCounts: {
      header: state.timelineHeaderRenderCount,
      tracks: state.timelineTrackRenderCount,
      blocks: state.timelineBlockRenderCount,
      detail: state.timelineDetailRenderCount,
    },
    detailVisible: Boolean(els.timelineDetailPanel && !els.timelineDetailPanel.classList.contains("hidden") && detailWindows.length > 0),
    detailPinned: detailWindows.some((windowItem) => windowItem.pinned),
    detailWindowCount: detailWindows.length,
    detailWindows,
    detailDockColumns: Number(els.timelineDetailPanel?.dataset.columns || 0),
    detailDockRows: Number(els.timelineDetailPanel?.dataset.rows || 0),
    detailWindowLayoutArea,
    pinnedDetailKey: state.pinnedTimelineDetailKeys[0] || "",
    pinnedDetailKeys: [...state.pinnedTimelineDetailKeys],
    detailCapsuleKey: detailWindows[0]?.key || "",
    currentBlockCenterDelta,
    detailRect: {
      left: detailDockRect.left,
      top: detailDockRect.top,
      right: detailDockRect.right,
      bottom: detailDockRect.bottom,
      width: detailDockRect.width,
      height: detailDockRect.height,
    },
    headerRect: {
      top: headerRect.top,
      left: headerRect.left,
      width: headerRect.width,
    },
  };
}

function exposeDebugState() {
  window.SESSION_VIEWER = {
    tracks: model.tracks,
    capsules: model.capsules.map((capsule) => ({
      key: capsule.key,
      trackId: capsule.trackId,
      type: capsule.type,
      lineType: capsule.lineType,
      contentTypes: capsule.contentTypes,
      summary: capsule.summary,
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
      pinnedDetails: [...state.pinnedTimelineDetailKeys],
      backCount: state.backStack.length,
      forwardCount: state.forwardStack.length,
      leftNavTab: state.leftNavTab,
      openPanels: [...state.openPanelIds],
      agentTreeDrawerOpen: state.agentTreeDrawerOpen,
    }),
    layoutMetrics,
    timelineMetrics,
  };
}

function initialize() {
  buildModels();
  updateCommandBarHeight();
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
  updateCommandBarHeight();
  scheduleGraphRender();
  updateTimelineDetailDockLayout();
  updateSubagentPanelOverlayWidth();
});

els.returnButton.addEventListener("click", returnToPrevious);
els.forwardButton.addEventListener("click", forwardToReturned);
document.getElementById("copyLinkBtn").addEventListener("click", () => copyText(window.location.href));
els.sessionInfoButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleSessionInfo();
});
els.sessionInfoPopover?.addEventListener("click", (event) => event.stopPropagation());
els.agentPaneToggle?.addEventListener("click", () => setAgentTreeDrawerOpen(!state.agentTreeDrawerOpen));
els.agentTreeDrawerClose?.addEventListener("click", () => setAgentTreeDrawerOpen(false));

document.addEventListener("click", (event) => {
  if (els.sessionInfoButton?.getAttribute("aria-expanded") === "true") setSessionInfoOpen(false);
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-panel") {
    event.preventDefault();
    event.stopPropagation();
    closePanel(button.dataset.trackId);
    return;
  }
  if (action === "close-timeline-detail") {
    event.preventDefault();
    event.stopPropagation();
    closeTimelineDetail(button);
    return;
  }
  if (action === "toggle-timeline-detail-pin") {
    event.preventDefault();
    event.stopPropagation();
    toggleTimelineDetailPin(button);
    return;
  }
  if (action === "timeline-detail-tab") {
    event.preventDefault();
    event.stopPropagation();
    setTimelineDetailTab(button);
    return;
  }
  if (action === "toggle-raw-payload") {
    event.preventDefault();
    event.stopPropagation();
    toggleRawPayload(button);
    return;
  }
  if (action === "open-reader-raw") {
    event.preventDefault();
    event.stopPropagation();
    openReaderRaw(button);
    return;
  }
  if (action === "copy-raw-payload") {
    event.preventDefault();
    event.stopPropagation();
    copyRawPayload(button);
    return;
  }
  event.preventDefault();
  if (action === "select-track") selectTrack(button.dataset.trackId, { open: button.dataset.open !== "false" });
  if (action === "toggle-panel") togglePanel(button.dataset.trackId);
  if (action === "open-panel") selectTrack(button.dataset.trackId, { open: true });
  if (action === "focus-message") focusMessage(button.dataset.trackId, Number(button.dataset.messageIndex));
  if (action === "focus-capsule") focusCapsule(button.dataset.capsuleKey);
  if (action === "timeline-block") toggleGraphSelection(button.dataset.capsuleKey, event);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSessionInfoOpen(false);
    setAgentTreeDrawerOpen(false);
    if (state.readerRawCapsuleKey) {
      state.readerRawCapsuleKey = "";
      renderTimelineDetailPanel(null);
    }
  }
  const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName);
  if (editable) return;
  const readerMessage = event.target?.closest?.(".reader-message[data-action='focus-capsule']");
  if (readerMessage && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    focusCapsule(readerMessage.dataset.capsuleKey);
    return;
  }
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
