// Mode B example (divide-and-conquer "wide-research") — the fan-out SOURCE.
//
// A pure `fn` node with no deps: it emits the LIST the `expand` fans out over, one
// research subtopic per element. Being pure (same output every run — exec-node also
// stubs Date.now/Math.random), it makes the graph SHAPE deterministic: the same list
// always produces the same fan-out width.
//
// The engine resolves this module's RELATIVE path (`./fns/seed.mjs` in graph.json)
// against the SKILL DIR, so the skill is self-contained wherever it is installed.
// `inputs` is the {depId: {status, output?}} envelope map (empty here — no deps).
export function seed(_inputs) {
  return [
    "battery chemistry advances",
    "charging infrastructure rollout",
    "grid-scale storage economics",
    "battery recycling and second life",
    "critical-materials supply chain",
    "policy and purchase incentives",
  ];
}
