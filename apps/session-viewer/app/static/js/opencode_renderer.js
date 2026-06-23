/**
 * OpenCode session renderer.
 *
 * Renders OpenCode-specific message part types for the shared session viewer
 * Timeline/Waterfall layouts. Loaded before conversation.js so the shared
 * renderer can dispatch OpenCode parts here.
 *
 * Design principles (aligned with apps/session-viewer/.plan):
 * - Each part card has a title bar with two-level category badges
 *   ("OpenCode / <subtype>"), a timestamp, Raw, and Copy JSON actions.
 * - Content is rendered as derived form rows; long values live in bounded
 *   scroll blocks. Type/subtype metadata is not repeated in the body.
 * - Array fields are grouped into nested tables.
 */

(function opencodeRenderer() {
  const OPENCODE_KINDS = new Set([
    "opencode_text",
    "opencode_reasoning",
    "opencode_tool",
    "opencode_tool_result",
    "opencode_patch",
    "opencode_file",
    "opencode_compaction",
    "opencode_step",
    "opencode_part",
  ]);

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

  function compact(value, length = 160) {
    const oneLine = text(value).replace(/\s+/g, " ").trim();
    return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
  }

  function hasValue(value) {
    return value !== null && value !== undefined && value !== "";
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

  function languageFromPath(path) {
    if (!path) return "";
    const match = String(path).match(/\.([a-zA-Z0-9_+-]+)$/);
    return match ? match[1] : "";
  }

  function statusClass(status) {
    const key = String(status || "").toLowerCase();
    if (key === "completed" || key === "success" || key === "succeeded") return "status-completed";
    if (key === "error" || key === "failed" || key === "failure") return "status-error";
    if (key === "pending" || key === "running" || key === "in_progress") return "status-pending";
    return "status-unknown";
  }

  function renderStatusBadge(status) {
    if (!hasValue(status)) return "";
    return `<span class="opencode-status-badge ${escAttr(statusClass(status))}">${esc(status)}</span>`;
  }

  function badgeClassForSubtype(kind) {
    if (kind === "opencode_tool") return "tool";
    if (kind === "opencode_tool_result") return "tool-result";
    if (kind === "opencode_reasoning") return "reasoning";
    if (kind === "opencode_text") return "message";
    if (kind === "opencode_patch") return "patch";
    if (kind === "opencode_file") return "file";
    if (kind === "opencode_compaction") return "compaction";
    if (kind === "opencode_step") return "step";
    return "opencode";
  }

  function subtypeLabel(part) {
    return openCodePartKindLabel(part);
  }

  function openCodeState(part) {
    return part?.state || {};
  }

  function isOpenCodePart(part) {
    return OPENCODE_KINDS.has(openCodeState(part).kind);
  }

  function openCodePartClass(part) {
    const state = openCodeState(part);
    if (state.kind === "opencode_tool_result") return "tool-result";
    if (state.kind === "opencode_tool") return "tool";
    if (state.kind === "opencode_reasoning") return "reasoning";
    const type = part?.type || state.partType || "part";
    return type.replace(/_/g, "-");
  }

  function openCodePartKindLabel(part) {
    const state = openCodeState(part);
    if (state.kind === "opencode_tool") return state.toolName || "tool call";
    if (state.kind === "opencode_tool_result") return "tool result";
    if (state.kind === "opencode_patch") return "patch";
    if (state.kind === "opencode_file") return "file";
    if (state.kind === "opencode_compaction") return "compaction";
    if (state.kind === "opencode_step") return state.stepType === "start" ? "step start" : "step finish";
    if (state.kind === "opencode_reasoning") return "reasoning";
    if (state.kind === "opencode_text") return "message";
    return state.partType || part?.type || "part";
  }

  function openCodePartSummary(part) {
    const state = openCodeState(part);
    if (state.kind === "opencode_tool") {
      return state.title || state.toolName || "Tool call";
    }
    if (state.kind === "opencode_tool_result") {
      return state.is_error ? "Tool error" : "Tool result";
    }
    if (state.kind === "opencode_patch") {
      return state.path ? `Patch: ${state.path}` : "Patch";
    }
    if (state.kind === "opencode_file") {
      return state.path ? `File: ${state.path}` : "File";
    }
    if (state.kind === "opencode_compaction") {
      return state.summary || "Compaction";
    }
    if (state.kind === "opencode_step") {
      return state.title || "Step";
    }
    if (state.kind === "opencode_reasoning") {
      return state.preview || "Reasoning";
    }
    if (state.kind === "opencode_text") {
      return state.preview || part?.text || "Message";
    }
    return state.preview || compact(part?.text) || `${state.partType || "part"}`;
  }

  function openCodeContentKind(part, lineKind = {}) {
    const state = openCodeState(part);
    const label = openCodePartKindLabel(part);
    const compactLabel = (fallback) => compactKindLabel(label, fallback);
    if (state.kind === "opencode_text") {
      if (lineKind.key === "assistant" || lineKind.key === "user") return { key: "message", label: "message", compact: "MSG" };
      return { key: lineKind.key || "message", label, compact: compactLabel("MSG") };
    }
    if (state.kind === "opencode_reasoning") return { key: "reasoning", label: "reasoning", compact: "REASON" };
    if (state.kind === "opencode_tool") return { key: "tool", label, compact: compactLabel("TOOL") };
    if (state.kind === "opencode_tool_result") return { key: "tool_result", label: "tool result", compact: "RESULT" };
    if (state.kind === "opencode_patch") return { key: "patch", label: "patch", compact: "PATCH" };
    if (state.kind === "opencode_file") return { key: "file", label: "file", compact: "FILE" };
    if (state.kind === "opencode_compaction") return { key: "compaction", label: "compaction", compact: "COMPACT" };
    if (state.kind === "opencode_step") return { key: `step-${state.stepType || "start"}`, label, compact: compactLabel("STEP") };
    return { key: part?.type || "mixed", label, compact: compactLabel("PART") };
  }

  function compactKindLabel(label, fallback) {
    if (!label) return fallback || "PART";
    const key = String(label).toLowerCase();
    if (key.startsWith("step ")) return `STEP ${key.split(" ").pop()?.toUpperCase().slice(0, 4) || "START"}`;
    return String(label).split(" ").map((word) => word[0]?.toUpperCase()).join("").slice(0, 6) || fallback;
  }

  function renderOpenCodeKindStack(part) {
    const state = openCodeState(part);
    const subtype = subtypeLabel(part);
    const subtypeClass = badgeClassForSubtype(state.kind);
    return `
      <span class="portfolio-kind-stack opencode-kind-stack" data-opencode-kind="${escAttr(state.kind || "")}">
        <span class="portfolio-kind-badge opencode-line-kind opencode">OpenCode</span>
        <span class="portfolio-kind-separator" aria-hidden="true">/</span>
        <span class="portfolio-subtype-badge opencode-content-kind ${escAttr(subtypeClass)}">${esc(subtype)}</span>
      </span>`;
  }

  function renderOpenCodePartHeaderActions(part) {
    const state = openCodeState(part);
    const isTool = state.kind === "opencode_tool";
    const isResult = state.kind === "opencode_tool_result";
    const toolUseId = state.callID || state.tool_use_id || "";
    const status = state.status || "";
    const actions = [];
    if (isTool || isResult) {
      if (toolUseId) actions.push(`<span class="tag opencode-tool-id">${esc(toolUseId)}</span>`);
      if (isTool && status) actions.push(renderStatusBadge(status));
    }
    return actions.join("");
  }

  function formRow(label, value, options = {}) {
    const valueText = hasValue(value) ? text(value) : options.emptyText || "Not provided";
    const multiline = options.multiline !== false && (valueText.includes("\n") || valueText.length > 80 || options.alwaysBlock);
    const preClass = options.preClass || "";
    return `
      <section class="portfolio-form-row opencode-form-row${multiline ? " multiline" : ""}">
        <header><strong>${esc(label)}</strong></header>
        <pre class="${escAttr(preClass)}">${esc(valueText)}</pre>
      </section>`;
  }

  function formBlock(label, bodyHtml) {
    if (!bodyHtml) return "";
    return `
      <section class="portfolio-form-block opencode-form-block">
        <header><strong>${esc(label)}</strong></header>
        ${bodyHtml}
      </section>`;
  }

  function boundedPre(value, options = {}) {
    const valueText = hasValue(value) ? text(value) : options.emptyText || "(empty)";
    return `<pre class="opencode-bounded-pre ${escAttr(options.preClass || "")}"><code>${esc(valueText)}</code></pre>`;
  }

  function isScalarArray(items) {
    return Array.isArray(items) && items.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item));
  }

  function scalarArrayRow(items) {
    if (!items.length) return "";
    return formRow("Items", items.map((item) => text(item)).join("\n"), { multiline: true });
  }

  function objectArrayColumns(items) {
    const keys = new Set();
    items.forEach((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        Object.keys(item).forEach((key) => keys.add(key));
      }
    });
    return [...keys];
  }

  function objectArrayTable(items, columns) {
    const cols = columns && columns.length ? columns : objectArrayColumns(items);
    if (!cols.length) return scalarArrayRow(items);
    const header = cols.map((key) => `<th>${esc(humanFieldName(key))}</th>`).join("");
    const rows = items
      .map((item, index) => {
        const cells = cols
          .map((key) => {
            const raw = item && typeof item === "object" ? item[key] : "";
            return `<td>${esc(compact(raw, 200))}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    return `
      <div class="portfolio-table-scroll opencode-table-scroll">
        <table class="portfolio-form-table opencode-form-table">
          <thead><tr>${header}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderArrayField(label, items, options = {}) {
    if (!Array.isArray(items) || !items.length) return formRow(label, null, { emptyText: options.emptyText || "Not provided" });
    if (isScalarArray(items)) return scalarArrayRow(items);
    const columns = options.columns || objectArrayColumns(items);
    return formBlock(label, objectArrayTable(items, columns));
  }

  function renderInputFields(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "";
    const entries = Object.entries(input).filter(([, value]) => hasValue(value));
    if (!entries.length) return "";
    const rows = entries
      .map(([key, value]) => {
        if (Array.isArray(value)) return renderArrayField(humanFieldName(key), value);
        return formRow(humanFieldName(key), value);
      })
      .join("");
    return formBlock("Input", rows);
  }

  function renderToolBody(state, options = {}) {
    const showInlineResult = options.showInlineResult !== false && (state.output !== undefined || state.error !== undefined);
    const rows = [];
    rows.push(formRow("Tool Name", state.toolName || "tool"));
    if (state.callID) rows.push(formRow("Call ID", state.callID));
    if (state.status) rows.push(formRow("Status", state.status));
    if (state.title && String(state.title).toLowerCase() !== String(state.toolName || "").toLowerCase()) rows.push(formRow("Title", state.title));

    let body = rows.join("");
    body += renderInputFields(state.input);

    if (showInlineResult) {
      if (state.error !== undefined && state.error !== null) {
        body += formBlock("Error", boundedPre(state.error, { preClass: "opencode-tool-result-error" }));
      } else if (state.output !== undefined && state.output !== null) {
        body += formBlock("Output", boundedPre(state.output));
      }
    }

    if (!body.trim()) {
      body = `<div class="part-text opencode-tool-empty">${esc(compact(state.preview) || "No tool details available.")}</div>`;
    }
    return body;
  }

  function renderToolResultBody(state) {
    const isError = Boolean(state.is_error);
    const value = isError ? (state.error !== undefined ? state.error : null) : (state.output !== undefined ? state.output : null);
    const rows = [];
    if (state.toolName) rows.push(formRow("Tool Name", state.toolName));
    if (state.tool_use_id) rows.push(formRow("Call ID", state.tool_use_id));
    rows.push(formRow("Status", isError ? "error" : "completed"));
    if (value !== null && value !== undefined) {
      rows.push(formBlock(isError ? "Error" : "Output", boundedPre(value, { preClass: isError ? "opencode-tool-result-error" : "" })));
    } else {
      rows.push(formRow(isError ? "Error" : "Output", null, { emptyText: "(no result)" }));
    }
    return rows.join("");
  }

  function renderPatchBody(state) {
    const path = state.path || "unknown file";
    const language = state.language || languageFromPath(path);
    const added = state.added ?? 0;
    const removed = state.removed ?? 0;
    const rows = [
      formRow("Path", path),
      formRow("Language", language || "Not provided"),
      formRow("Added", added),
      formRow("Removed", removed),
    ];
    rows.push(formBlock("Diff", renderDiffLines(state.diff)));
    return rows.join("");
  }

  function renderDiffLines(diff) {
    if (!diff) return `<pre class="opencode-diff-empty">(no diff)</pre>`;
    const lines = String(diff).split("\n");
    return `
      <div class="opencode-diff-body">
        ${lines
          .map((line, index) => {
            let cls = "diff-line-context";
            if (line.startsWith("+") && !line.startsWith("+++ ")) cls = "diff-line-added";
            else if (line.startsWith("-") && !line.startsWith("--- ")) cls = "diff-line-removed";
            else if (line.startsWith("@@")) cls = "diff-line-hunk";
            const num = String(index + 1).padStart(4, " ");
            return `<div class="opencode-diff-line ${cls}"><span class="opencode-diff-line-number">${num}</span><code>${esc(line)}</code></div>`;
          })
          .join("")}
      </div>`;
  }

  function renderFileBody(state) {
    const path = state.path || "unknown file";
    const language = state.language || languageFromPath(path);
    const rows = [
      formRow("Path", path),
      formRow("Language", language || "Not provided"),
      formRow("Lines", state.lineCount ?? "Not provided"),
    ];
    rows.push(formBlock("Content", boundedPre(state.content || "", { emptyText: "(empty file)" })));
    return rows.join("");
  }

  function renderCompactionBody(state) {
    const rows = [];
    if (state.summary) rows.push(formRow("Summary", state.summary));
    if (state.preTokens !== undefined) rows.push(formRow("Pre-compaction tokens", state.preTokens));
    if (state.postTokens !== undefined) rows.push(formRow("Post-compaction tokens", state.postTokens));
    if (!rows.length) rows.push(formRow("Summary", null, { emptyText: "Compaction" }));
    return rows.join("");
  }

  function renderStepBody(state) {
    const stepType = state.stepType || "start";
    const title = state.title || "Step";
    const status = state.status || (stepType === "start" ? "started" : "finished");
    const rows = [
      formRow("Step Type", stepType === "start" ? "Start" : "Finish"),
      formRow("Title", title),
      formRow("Status", status),
    ];
    if (state.durationMs !== undefined && state.durationMs !== null) rows.push(formRow("Duration", `${state.durationMs} ms`));
    return rows.join("");
  }

  function renderTextBody(state, partText) {
    return `<div class="part-text opencode-text">${esc(partText || "")}</div>`;
  }

  function renderReasoningBody(state, partText) {
    return `<div class="part-text opencode-reasoning-text">${esc(partText || "")}</div>`;
  }

  function renderFallbackBody(state, partText) {
    const partType = state.partType || "part";
    const summary = state.preview || compact(partText) || `${partType} event`;
    const rows = [formRow("Type", humanFieldName(partType))];
    rows.push(formRow("Summary", summary));
    if (state.payload) {
      rows.push(formBlock("Payload", boundedPre(state.payload)));
    }
    return rows.join("");
  }

  function renderOpenCodePartBody(part, options = {}) {
    const state = openCodeState(part);
    const partText = part?.text || "";
    switch (state.kind) {
      case "opencode_text":
        return renderTextBody(state, partText);
      case "opencode_reasoning":
        return renderReasoningBody(state, partText);
      case "opencode_tool":
        return renderToolBody(state, options);
      case "opencode_tool_result":
        return renderToolResultBody(state);
      case "opencode_patch":
        return renderPatchBody(state);
      case "opencode_file":
        return renderFileBody(state);
      case "opencode_compaction":
        return renderCompactionBody(state);
      case "opencode_step":
        return renderStepBody(state);
      default:
        return renderFallbackBody(state, partText);
    }
  }

  function renderOpenCodePart(part, options = {}) {
    return renderOpenCodePartBody(part, options);
  }

  function renderOpenCodeTimelinePart(part) {
    return `<div class="timeline-detail-part opencode-timeline-part ${escAttr(openCodePartClass(part))}">${renderOpenCodePartBody(part, { showInlineResult: true })}</div>`;
  }

  function renderOpenCodePortfolioPart(part) {
    const state = openCodeState(part);
    if (state.kind === "opencode_tool") {
      return renderPortfolioDisplayBody({
        summary: "",
        rows: [
          ["Tool", state.toolName || "tool"],
          ...(state.callID ? [["Call ID", state.callID]] : []),
          ...(state.status ? [["Status", state.status]] : []),
        ],
        sections: [textAttachmentSection("input", "Input", state.input || {}, { keepEmpty: true })],
      }, { includeSummary: false });
    }
    if (state.kind === "opencode_tool_result") {
      return renderPortfolioDisplayBody({
        summary: "",
        rows: state.tool_use_id ? [["Call ID", state.tool_use_id]] : [],
        sections: [textAttachmentSection("output", state.is_error ? "Error" : "Output", part?.text || "(no result)", { keepEmpty: true })],
      }, { includeSummary: false });
    }
    if (state.kind === "opencode_patch") {
      return renderPortfolioDisplayBody({
        summary: state.path ? `Patch for ${state.path}` : "Patch",
        rows: [
          ["Path", state.path || "unknown"],
          ["Added", state.added ?? "?"],
          ["Removed", state.removed ?? "?"],
        ],
        sections: [textAttachmentSection("diff", "Diff", state.diff || "", { keepEmpty: true })],
      }, { includeSummary: true });
    }
    if (state.kind === "opencode_file") {
      return renderPortfolioDisplayBody({
        summary: state.path ? `File: ${state.path}` : "File",
        rows: [
          ["Path", state.path || "unknown"],
          ["Lines", state.lineCount ?? "?"],
        ],
        sections: [textAttachmentSection("content", "Content", state.content || "", { keepEmpty: true })],
      }, { includeSummary: true });
    }
    if (state.kind === "opencode_compaction") {
      return renderPortfolioDisplayBody({
        summary: state.summary || "Compaction",
        rows: [
          ["Pre-compaction tokens", state.preTokens ?? "?"],
          ["Post-compaction tokens", state.postTokens ?? "?"],
        ],
        sections: [],
      }, { includeSummary: true });
    }
    if (state.kind === "opencode_step") {
      return renderPortfolioDisplayBody({
        summary: `${state.stepType === "start" ? "Started" : "Finished"}: ${state.title || "step"}`,
        rows: [
          ["Status", state.status || "unknown"],
          ["Duration", state.durationMs !== undefined ? `${state.durationMs} ms` : "?"],
        ],
        sections: [],
      }, { includeSummary: true });
    }
    return renderPortfolioFormText(openCodePartKindLabel(part), part?.text || "(empty)", { multiline: true });
  }

  window.OpenCodeRenderer = {
    isOpenCodePart,
    openCodePartClass,
    openCodePartKindLabel,
    openCodePartSummary,
    openCodeContentKind,
    renderOpenCodeKindStack,
    renderOpenCodePart,
    renderOpenCodePartHeaderActions,
    renderOpenCodeTimelinePart,
    renderOpenCodePortfolioPart,
  };
})();
