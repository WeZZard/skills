/**
 * Shared text utilities for the session viewer.
 *
 * Loaded before opencode_renderer.js and conversation.js so both can consume
 * the same escaping, normalization, fuzzy matching, and search-hit highlighting
 * machinery.
 *
 * Design:
 * - esc/escAttr/escapeRegExp are single-sourced here to avoid duplication.
 * - normalizeForSearch converts snake_case/camelCase to whitespace-separated
 *   lowercase tokens so "hook" matches "hook_success" and "agentDescription".
 * - levenshtein is bounded (early-exit when distance > maxDist) for performance.
 * - fuzzyMatchHaystack tries exact substring first (fast path), then falls back
 *   to per-token Levenshtein ≤ 2 for typo tolerance.
 * - renderTextWithHighlights wraps every occurrence of a matching search term
 *   in <mark class="search-hit"> (or <mark class="search-hit current"> when
 *   the text belongs to the capsule under the search cursor).
 * - Highlighting is scope-aware: "value" scope highlights terms from
 *   Field-value badges; "key" scope highlights Field-key badge terms; "raw"
 *   scope highlights both (used in the Raw JSON tab).
 * - The RegExp is memoized per term-set so a full Reader rebuild reuses one
 *   compiled pattern across thousands of per-part calls.
 * - Highlighting is gated by setHighlightingActive so non-search rebuilds pay
 *   zero regex cost (falls through to plain esc()).
 * - setCurrentHitKey + beginCapsule/endCapsule provide per-capsule "current
 *   hit" context for leaf renderers that don't receive a capsule key arg.
 */
(function textUtils() {
  "use strict";

  let currentExpression = null;
  let currentHitKey = "";
  let currentCapsuleKey = "";
  let highlightingActive = false;
  let regexCache = null;
  let regexCacheKey = "";

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = value === null || value === undefined ? "" : String(value);
    return div.innerHTML;
  }

  function escAttr(value) {
    return esc(value).replace(/"/g, "&quot;");
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeForSearch(value) {
    return String(value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .toLowerCase()
      .trim();
  }

  function levenshtein(a, b, maxDist) {
    if (a === b) return 0;
    const alen = a.length;
    const blen = b.length;
    if (Math.abs(alen - blen) > maxDist) return maxDist + 1;
    if (alen === 0) return blen;
    if (blen === 0) return alen;
    let prev = new Array(blen + 1);
    let curr = new Array(blen + 1);
    for (let j = 0; j <= blen; j++) prev[j] = j;
    for (let i = 1; i <= alen; i++) {
      curr[0] = i;
      let best = curr[0];
      for (let j = 1; j <= blen; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < best) best = curr[j];
      }
      if (best > maxDist) return maxDist + 1;
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[blen];
  }

  function fuzzyMatchHaystack(haystack, term, maxDist) {
    const dist = maxDist === undefined ? 2 : maxDist;
    if (!haystack || !term) return false;
    if (haystack.includes(term)) return true;
    if (dist <= 0) return false;
    const tokens = haystack.split(/\s+/);
    return tokens.some((token) => token.length > 0 && levenshtein(term, token, dist) <= dist);
  }

  function setExpression(expr) {
    currentExpression = expr || null;
    regexCache = null;
    regexCacheKey = "";
  }

  function setHighlightingActive(active) {
    highlightingActive = Boolean(active);
  }

  function setCurrentHitKey(key) {
    currentHitKey = key || "";
  }

  function beginCapsule(key) {
    currentCapsuleKey = key || "";
  }

  function endCapsule() {
    currentCapsuleKey = "";
  }

  function collectTermsForScope(expr, scope) {
    if (!expr) return [];
    if (expr.op === "TERM") {
      if (scope === "raw") return expr.tokens || [];
      if (expr.category === scope) return expr.tokens || [];
      return [];
    }
    if (expr.op === "AND" || expr.op === "OR") {
      const result = [];
      for (const child of expr.children) {
        const childTerms = collectTermsForScope(child, scope);
        for (const t of childTerms) result.push(t);
      }
      return result;
    }
    return [];
  }

  function getRegex(tokens) {
    const key = tokens.join("\u0000");
    if (regexCache && regexCacheKey === key) return regexCache;
    const sorted = [...tokens].sort((a, b) => b.length - a.length);
    regexCache = new RegExp(`(${sorted.map(escapeRegExp).join("|")})`, "ig");
    regexCacheKey = key;
    return regexCache;
  }

  function renderTextWithHighlights(rawText, options) {
    const scope = (options && options.scope) || "value";
    const overrideTokens = options && options.tokens;
    const source = String(rawText || "");
    if (!highlightingActive || !currentExpression) return esc(source);
    const terms = overrideTokens || collectTermsForScope(currentExpression, scope);
    if (!terms || !terms.length || !source) return esc(source);
    const isCurrent = Boolean(currentCapsuleKey) && currentCapsuleKey === currentHitKey;
    const markClass = isCurrent ? "search-hit current" : "search-hit";
    const pattern = getRegex(terms);
    const lowerSet = new Set(terms);
    return source.split(pattern)
      .map((part) =>
        lowerSet.has(part.toLowerCase())
          ? `<mark class="${markClass}">${esc(part)}</mark>`
          : esc(part))
      .join("");
  }

  window.TextUtils = {
    esc,
    escAttr,
    escapeRegExp,
    normalizeForSearch,
    levenshtein,
    fuzzyMatchHaystack,
    setExpression,
    setHighlightingActive,
    setCurrentHitKey,
    beginCapsule,
    endCapsule,
    collectTermsForScope,
    renderTextWithHighlights,
  };
})();
