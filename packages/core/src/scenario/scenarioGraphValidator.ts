/**
 * What a scenario's wiring would do wrong at run time, read off the program
 * the executor walks (`scenarioGraph.ts`) and the per-node-type rules
 * (`scenarioConnectionRules.ts`). Advisory: callers report the issues and
 * keep loading the scenario.
 */
import {
  connectionRule,
  type GraphIssue,
  type GraphIssueCode,
} from "./scenarioConnectionRules";
import {
  edgesByHandle,
  isTerminal,
  lowerScenario,
  successors,
  type GraphEdgeLike,
  type GraphNodeLike,
  type ScenarioProgram,
} from "./scenarioGraph";
import { ScenarioNodeType } from "../cp/application/scenario/ScenarioTypes";

/** A branch's CALL: none yet, answered, or open (held since `open:<trigger id>`). */
type CallState = "none" | "answered" | `open:${string}`;

type Program = ScenarioProgram<GraphNodeLike, GraphEdgeLike>;

/**
 * Every edge out of `id` that may run: all of the origin's, none of a
 * terminal node's, of a switch / choice the first edge of every handle it
 * can pick (as {@link successors}: a later edge on the same handle never
 * runs and is reported as `duplicateHandle`), all of anyone else's (an
 * ignored second edge is reported as `extraOutgoing`, and still counts for
 * reachability).
 */
function edgesThatMayRun(
  program: Program,
  id: string,
): readonly GraphEdgeLike[] {
  const node = program.nodesById.get(id);
  if (!node || node === program.origin) return program.outgoing.get(id) ?? [];
  if (isTerminal(node)) return [];
  if (connectionRule(node.type).out === "select") {
    return [...edgesByHandle(program, node).pickable.values()].map(
      (edges) => edges[0],
    );
  }
  return program.outgoing.get(id) ?? [];
}

export function validateScenarioGraph(def: {
  nodes: readonly GraphNodeLike[];
  edges: readonly GraphEdgeLike[];
}): GraphIssue[] {
  const program: Program = lowerScenario(def);
  const { origin, starts, nodesById } = program;
  // missingStart, multipleStart, then danglingEdge / edgeOutOfEnd in edge order.
  const issues: GraphIssue[] = [...program.diagnostics];

  // Re-entering the origin runs it as a step: on along its first edge only.
  if (origin && edgesThatMayRun(program, origin.id).length > 1) {
    for (const edge of def.edges) {
      if (nodesById.has(edge.source) && nodesById.get(edge.target) === origin) {
        issues.push({
          code: "edgeIntoStart",
          nodeId: origin.id,
          edgeId: edge.id,
          severity: "warning",
        });
      }
    }
  }

  for (const nodeId of program.outgoing.keys()) {
    const node = nodesById.get(nodeId)!;
    // The origin fans out. Any other START runs as a step: first edge only.
    if (node === origin || isTerminal(node)) continue;
    if (connectionRule(node.type).out === "select") {
      // Several edges are the point (one per handle); an edge with a handle
      // the node never picks never runs, nor does any edge after the first
      // one of a handle.
      const { pickable, unpickable } = edgesByHandle(program, node);
      for (const [handle, edges] of pickable) {
        for (const edge of edges.slice(1)) {
          issues.push({
            code: "duplicateHandle",
            nodeId,
            edgeId: edge.id,
            severity: "warning",
            data: { handle },
          });
        }
      }
      for (const edge of unpickable) {
        issues.push({
          code: "unpickableHandle",
          nodeId,
          edgeId: edge.id,
          severity: "warning",
        });
      }
      continue;
    }
    if (edgesThatMayRun(program, nodeId).length > 1) {
      issues.push({ code: "extraOutgoing", nodeId, severity: "warning" });
    }
  }

  // Reachability from the origin only: a second START starts nothing (every
  // edge that may run counts: an ignored branch is reported by
  // `extraOutgoing`, not twice here; a switch / choice's duplicate-handle
  // edge never runs, so what only it leads to is unreachable too).
  if (origin) {
    const seen = new Set<string>([origin.id]);
    const queue = [origin.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const edge of edgesThatMayRun(program, id)) {
        if (!seen.has(edge.target)) {
          seen.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of def.nodes) {
      if (
        !seen.has(node.id) &&
        node.type !== ScenarioNodeType.END &&
        // A START nothing reaches is reported as multipleStart.
        !starts.includes(node)
      ) {
        issues.push({
          code: "unreachable",
          nodeId: node.id,
          severity: "warning",
        });
      }
    }
    issues.push(...checkCalls(origin, program));
  }

  return issues;
}

/**
 * Follow the CALL each branch holds along the edges the executor really takes
 * ({@link successors}: all of the origin's, then the first one of every other
 * node, of a switch / choice the first one of every handle it can pick) until
 * no state changes, and report the paths on which a node needs a CALL its
 * branch does not hold. It assumes a replace trigger always takes a CALL
 * over; one that ends without (continued, skipped or stopped) takes
 * nothing over at run time, so a later callResponse can still fail: an
 * accepted false negative of an advisory check.
 */
function checkCalls(origin: GraphNodeLike, program: Program): GraphIssue[] {
  const found = new Map<string, GraphIssue>();
  const report = (code: GraphIssueCode, nodeId: string) => {
    const severity = code === "callLeftOpen" ? "warning" : "error";
    found.set(`${code} ${nodeId}`, { code, nodeId, severity });
  };

  // The branch's state at a node: its CALL, and whether it holds an answer
  // to an ocppCall (`response`, schema 1.7). Both reset at each branch from
  // the origin (newFlow()).
  const statesAt = new Map<string, Set<string>>();
  const queue: Array<[string, CallState, boolean]> = [];
  const enter = (nodeId: string, state: CallState, answer: boolean) => {
    const key = `${answer ? "r" : "-"}${state}`;
    const seen = statesAt.get(nodeId) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    statesAt.set(nodeId, seen);
    queue.push([nodeId, state, answer]);
  };
  const leftOpen = (state: CallState) => {
    if (state.startsWith("open:")) report("callLeftOpen", state.slice(5));
  };

  // Each branch from the origin starts with a fresh CALL slot (newFlow()).
  for (const edge of successors(program, origin, { asOrigin: true })) {
    enter(edge.target, "none", false);
  }

  while (queue.length > 0) {
    const [nodeId, state, answer] = queue.pop()!;
    const node = program.nodesById.get(nodeId)!;
    const rule = connectionRule(node.type);
    let after: CallState | null = state;
    let answerAfter = answer;
    const effect = rule.response?.(node.data as never);
    switch (rule.call(node.data as never)) {
      case "takesOver":
        leftOpen(state);
        after = `open:${node.id}`;
        break;
      case "answers":
        if (state === "none") report("noCallHeld", node.id);
        else if (state === "answered") report("callAlreadyAnswered", node.id);
        // The run fails on those paths: nothing after the node runs.
        after = state.startsWith("open:") ? "answered" : null;
        break;
      case "reads":
        if (state === "none") {
          report("noCallHeld", node.id);
          after = null;
        }
        break;
      case "none":
        break;
    }
    if (effect?.reads && !answer) {
      report("noResponseHeld", node.id);
      after = null;
    }
    if (effect?.produces) answerAfter = true;
    if (after === null) continue;
    // Re-entering the origin runs it as a step (executeSequentialFlow).
    // A switch or choice may pick any of its handles: follow each.
    const followed = successors(program, node);
    for (const edge of followed) enter(edge.target, after, answerAfter);
    if (followed.length === 0) leftOpen(after);
  }

  return [...found.values()];
}
