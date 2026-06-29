// Mode B example (divide-and-conquer "wide-research") — the GATHER reducer.
//
// Re-exports `gatherSuccesses` from the amplify lifecycle helper so the example
// reduces with the SAME tested gather logic instead of re-implementing it: as an
// `fn` node with `require: "all-resolved"`, it reads every child's
// {status, output?} envelope, KEEPS the done ones, DROPS the failed ones, and unions
// a threaded accumulator of prior successes — so a partial fan-out still yields a
// result and a retry never drops earlier wins.
//
// Two relative paths resolve here, from two different bases — and that is the point
// of Mode B:
//   - the engine resolves THIS module's path (`./fns/gather.mjs` in graph.json)
//     against the SKILL DIR (state.graphDir), and
//   - Node resolves the import below against THIS file's own location,
// so the example needs no absolute paths and travels with the skill folder.
export { gatherSuccesses as gather } from "../../../../../scripts/lifecycle.mjs";
