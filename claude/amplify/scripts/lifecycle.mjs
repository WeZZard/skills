// Amplify lifecycle producer helper + reduce/gather fns.
//
// This module is a PRODUCER-SIDE helper for the generalized DAG engine
// (scripts/task.mjs). It stamps the implement-and-audit lifecycle as a 5-node
// COMPOSITION of the generalized node kinds (agent / expand / fn / switch) and
// ships the two pure reducer functions that composition needs:
//
//   - verifiedTaskNodes(spec) -> [work, resolve, audit, fold, terminal]
//       PURE / DECLARATIVE: it RETURNS folded-graph node objects wired together;
//       it NEVER runs the engine. A producer (execute-plan / divide-and-conquer)
//       splices the returned nodes into a graph; the engine then drives them with
//       its verbs (complete --output / expand / exec-node / loop).
//
//   - foldVerdicts(inputs)     the lifecycle FOLD: folds the recorded auditor
//                              verdict envelopes into a continue/stop routing signal.
//   - gatherSuccesses(inputs)  the reduce/GATHER: gathers the done children, drops
//                              the failed ones, and unions a threaded accumulator of
//                              prior successes (so a retry never drops earlier wins).
//
// foldVerdicts / gatherSuccesses obey the engine's exec-node contract: each is a
// PURE function of the per-dep input envelope map { depId: { status, output? } }
// that resolve-context --inputs / exec-node build from the value store. No engine
// import, no I/O, no hidden state — same inputs => same output.
//
// No external dependencies (Node built-ins only), matching task.mjs.

import { fileURLToPath } from "node:url";

// Absolute path to THIS module, so a produced `fn` node carries a self-contained,
// cwd-independent `module` handle that exec-node can import from anywhere. The fold
// node points its module here and its export at "foldVerdicts".
const HERE = fileURLToPath(import.meta.url);

const DEFAULT_EXECUTOR = "subagent(general-purpose)";

// The fold's routing domain. The terminal switch's cases MUST exactly cover this
// (validateGraph enforces switch exhaustiveness against the selector's output_schema),
// so the fold's output_schema enum and the switch's case keys are kept in lock-step.
const ROUTE_CONTINUE = "continue"; // some auditor failed -> retry (subject to budget)
const ROUTE_STOP = "stop";         // every auditor passed -> exit (done)

// verifiedTaskNodes(spec) -> [work, resolve, audit, fold, terminal]
//
// Stamps the implement-and-audit lifecycle as a 5-node composition:
//
//   work(agent) -> resolve(agent, emits the auditor panel list)
//       -> audit(expand over the panel) -> fold(fn, folds the auditor verdicts)
//       -> terminal(switch on the fold's continue/stop signal)
//
// The terminal switch is the tail of a BUDGETED FORWARD-UNROLL loop, driven by the
// engine's `loop` verb (no back-edge, no cycle):
//   - stop                         -> instantiate the exit (the task reaches "done").
//   - continue & budget > 0        -> spawn the next work iteration (a fresh forward
//                                     node), decrement the budget, thread the state.
//   - continue & budget exhausted  -> the loop's budget>0 guard FORCES stop, so it
//                                     instantiates the exit anyway: a TERMINAL FAILURE
//                                     that is NON-HALTING (successors still proceed).
//
// `spec` fields (all but `id` optional, with lifecycle-faithful defaults):
//   id              base id; node ids are `${id}-work` etc. (dot-free, ID_RE-safe —
//                   dots are reserved for subnode separators in task.mjs).
//   deps            upstream task ids the work node depends on (default []).
//   prompt          the work agent prompt.
//   output_schema   the work output schema (the implementation result; default string).
//   executor        the work / retry executor (default subagent(general-purpose)).
//   max_attempts    the work / retry max_attempts (default 2).
//   resolve_prompt, resolve_executor   the resolver agent (emits the panel list).
//   audit_prompt,   audit_executor     the per-auditor agent template.
//   exit_prompt,    exit_executor      the exit/terminal node.
export function verifiedTaskNodes(spec = {}) {
  const id = spec.id;
  if (typeof id !== "string" || !id) {
    throw new Error("verifiedTaskNodes: spec.id is required (a non-empty string)");
  }

  const workId = `${id}-work`;
  const resolveId = `${id}-resolve`;
  const auditId = `${id}-audit`;
  const foldId = `${id}-fold`;
  const terminalId = `${id}-terminal`;

  const executor = spec.executor || DEFAULT_EXECUTOR;
  const workSchema = spec.output_schema || { type: "string" };
  const maxAttempts = Number.isInteger(spec.max_attempts) ? spec.max_attempts : 2;
  const workPrompt = spec.prompt || `Implement task ${id}.`;

  // 1) work — produce the implementation. Its upstream deps are the task's deps.
  const work = {
    id: workId,
    type: "agent",
    deps: Array.isArray(spec.deps) ? [...spec.deps] : [],
    executor,
    prompt: workPrompt,
    output_schema: workSchema,
    max_attempts: maxAttempts,
  };

  // 2) resolve — design the blind auditor panel. Its output is the panel LIST (one
  //    entry per auditor); the audit expand fans out over it.
  const resolve = {
    id: resolveId,
    type: "agent",
    deps: [workId],
    executor: spec.resolve_executor || DEFAULT_EXECUTOR,
    prompt: spec.resolve_prompt
      || `Design the blind auditor panel for task ${id}; emit a JSON array of auditor focuses.`,
    output_schema: { type: "array" },
    max_attempts: 1,
  };

  // 3) audit — fan out the panel: one auditor agent per element, each bound to its
  //    focus BY REFERENCE, all gathering into fold. Each auditor emits a boolean
  //    verdict (true = pass, false = fail).
  const audit = {
    id: auditId,
    type: "expand",
    deps: [resolveId],
    over: resolveId,
    template: {
      type: "agent",
      executor: spec.audit_executor || DEFAULT_EXECUTOR,
      prompt: spec.audit_prompt
        || `Audit the implementation against your assigned focus; emit true to pass, false to fail.`,
      output_schema: { type: "boolean" },
      max_attempts: 1,
    },
    gather: foldId,
  };

  // 4) fold — a reducer fn (require all-resolved, so a FAILED auditor is read as a
  //    fail verdict from its {status:"failed"} envelope, never a missing input). It
  //    folds the recorded auditor verdicts into one routing signal: every auditor
  //    passed -> "stop"; any auditor failed -> "continue".
  const fold = {
    id: foldId,
    type: "fn",
    deps: [auditId],
    module: HERE,
    export: "foldVerdicts",
    output_schema: { type: "string", enum: [ROUTE_CONTINUE, ROUTE_STOP] },
    require: "all-resolved",
  };

  // 5) terminal — the loop's tail switch over the fold signal. The case keys exactly
  //    cover the fold's enum domain (validateGraph exhaustiveness). Driven by `loop`:
  //    continue spawns the next work iteration; stop (or budget exhaustion) the exit.
  const terminal = {
    id: terminalId,
    type: "switch",
    deps: [foldId],
    over: foldId,
    cases: {
      // continue: the next work attempt — a fresh forward iteration the loop spawns.
      [ROUTE_CONTINUE]: {
        type: "agent",
        executor,
        prompt: workPrompt,
        output_schema: workSchema,
        max_attempts: maxAttempts,
      },
      // stop: the exit / terminal node. Reached on a PASS and on a budget-exhausted
      // failure alike, so a terminal failure is non-halting.
      [ROUTE_STOP]: {
        type: "agent",
        executor: spec.exit_executor || DEFAULT_EXECUTOR,
        prompt: spec.exit_prompt || `Finalize task ${id}.`,
        output_schema: { type: "string" },
        max_attempts: 1,
      },
    },
  };

  return [work, resolve, audit, fold, terminal];
}

// foldVerdicts(inputs) — PURE fold over the auditor verdict envelopes.
//
// `inputs` is the { depId: { status, output? } } envelope map exec-node builds from
// the fold node's deps (the settled `expand` node plus every auditor child). Each
// AUDITOR reports a boolean verdict (true = pass, false = fail); a failed auditor RUN
// ({status:"failed"}, no output) counts as a fail verdict. NON-verdict deps — e.g. the
// settled expand node, which is done with no boolean output — are skipped.
//
// Returns "stop" iff at least one verdict exists and EVERY verdict passed; otherwise
// "continue" (some auditor failed -> retry, subject to the loop's budget). With no
// verdicts at all (a degenerate empty panel) it returns "stop": there is nothing left
// to fail, so the task exits rather than looping forever.
export function foldVerdicts(inputs = {}) {
  const verdicts = [];
  for (const env of Object.values(inputs)) {
    if (!env) continue;
    if (env.status === "done" && typeof env.output === "boolean") {
      verdicts.push(env.output);
    } else if (env.status === "failed") {
      verdicts.push(false); // a failed auditor run is a fail verdict, never ignored
    }
    // done-without-a-boolean-output (the expand node, a falsy non-boolean) is not a
    // verdict; skip it so it cannot accidentally route the loop.
  }
  const anyFail = verdicts.some((v) => v !== true);
  return anyFail ? ROUTE_CONTINUE : ROUTE_STOP;
}

// gatherSuccesses(inputs) — PURE reduce/GATHER over per-child envelopes.
//
// Gathers the outputs of the DONE children and DROPS the failed ones (read from their
// {status:"failed"} envelopes, never a missing value — so failure is distinguished
// from a valid empty/falsy output). A done child's output may be a LEAF value (one
// result) or an ARRAY (a threaded ACCUMULATOR of prior successes carried into a retry
// round); an array is UNIONED IN element-wise, so earlier successes are never dropped.
//
// The result is the de-duplicated union of all gathered successes in first-seen order
// — order-stable and idempotent (re-gathering the same envelopes yields the same set),
// so it is safe to thread forward through the loop across retry rounds.
export function gatherSuccesses(inputs = {}) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const key = v !== null && typeof v === "object" ? `json:${JSON.stringify(v)}` : `${typeof v}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const env of Object.values(inputs)) {
    // Drop a failed child (status !== "done") and a done child that recorded no output
    // (output key absent). A done child with a falsy-but-present output is KEPT.
    if (!env || env.status !== "done" || !("output" in env)) continue;
    if (Array.isArray(env.output)) {
      for (const el of env.output) add(el); // union a threaded accumulator element-wise
    } else {
      add(env.output); // a leaf success
    }
  }
  return out;
}
