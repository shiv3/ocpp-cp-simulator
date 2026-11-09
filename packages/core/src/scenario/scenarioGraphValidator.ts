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
  isJoin,
  isTerminal,
  loopBody,
  loopBounds,
  loopStep,
  lowerScenario,
  successors,
  timeoutStep,
  waitTimeoutSeconds,
  type GraphEdgeLike,
  type GraphNodeLike,
  type ScenarioProgram,
} from "./scenarioGraph";
import {
  ScenarioFlowNodeType,
  ScenarioNodeType,
} from "../cp/application/scenario/ScenarioTypes";
import {
  containsCallReference,
  containsRootReference,
  isFromReference,
} from "../cp/application/scenario/resolveFrom";
import {
  jsonEquals,
  matcherProblem,
  matchesEveryPresentValue,
} from "./valueMatch";

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

/** The edge a wait leaves by when it times out (schema 1.8), when its timeout
 *  can expire at all; else none. */
function timeoutEdgeThatMayRun(
  program: Program,
  node: GraphNodeLike,
): GraphEdgeLike | null {
  if (!waitTimeoutSeconds(node)) return null;
  return timeoutStep(program, node)?.edge ?? null;
}

/** The loop edge a branch may follow after `node` (schema 1.10), and whether
 *  its bounds can ever fire (an unbounded or malformed loop never exits: the
 *  node's ordinary next edge then never runs). `null` for no loop. */
function loopThatMayRun(
  program: Program,
  node: GraphNodeLike,
): { edge: GraphEdgeLike; exits: boolean; until?: unknown } | null {
  if (node === program.origin) return null;
  const step = loopStep(program, node);
  if (!step) return null;
  const read = loopBounds(step.edge);
  if ("problem" in read) return { edge: step.edge, exits: false };
  const { times, forSeconds, until } = read.bounds;
  return {
    edge: step.edge,
    exits: times !== undefined || forSeconds !== undefined || !!until,
    until: until?.value,
  };
}

/** `major.minor` of a declared schema version, or null when it is not one. */
function parseVersion(v: unknown): [number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)(?:\..*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** `newerConstruct` (info) when the file declares a schema version below
 *  `since` and uses a construct of it. A file that declares none, or one
 *  that does not parse, is not reported. Compared per part as numbers
 *  (1.10 is above 1.9). */
function newerConstruct(
  declared: unknown,
  since: string,
  at: { nodeId?: string; edgeId?: string },
): GraphIssue[] {
  const have = parseVersion(declared);
  const need = parseVersion(since)!;
  if (!have) return [];
  const older = have[0] < need[0] || (have[0] === need[0] && have[1] < need[1]);
  return older
    ? [
        {
          code: "newerConstruct",
          severity: "info",
          ...at,
          data: { since, declared },
        },
      ]
    : [];
}

/** Schema 1.8: what is wrong with the timeout edges of the graph. */
function checkTimeoutEdges(
  program: Program,
  schemaVersion: unknown,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  let first: string | undefined;
  for (const [nodeId, edges] of program.timeoutEdges) {
    const node = program.nodesById.get(nodeId)!;
    first ??= edges[0]!.id;
    const seconds = waitTimeoutSeconds(node);
    if (seconds === null || isTerminal(node)) {
      for (const edge of edges) {
        issues.push({
          code: "timeoutEdgeOnNonWait",
          nodeId,
          edgeId: edge.id,
          severity: "warning",
        });
      }
      continue;
    }
    if (seconds === 0) {
      for (const edge of edges) {
        issues.push({
          code: "timeoutEdgeNeverFires",
          nodeId,
          edgeId: edge.id,
          severity: "info",
        });
      }
    }
    for (const edge of edges.slice(1)) {
      issues.push({
        code: "extraTimeoutEdge",
        nodeId,
        edgeId: edge.id,
        severity: "warning",
      });
    }
  }
  if (first !== undefined) {
    issues.push(...newerConstruct(schemaVersion, "1.8", { edgeId: first }));
  }
  return issues;
}

/** Schema 1.10: what is wrong with the loop edges of the graph. */
function checkLoopEdges(
  program: Program,
  schemaVersion: unknown,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  let first: string | undefined;
  for (const [nodeId, edges] of program.loopEdges) {
    const node = program.nodesById.get(nodeId)!;
    first ??= edges[0]!.id;
    if (node === program.origin || !loopStep(program, node)) {
      for (const edge of edges) {
        issues.push({
          code: "loopEdgeIgnored",
          nodeId,
          edgeId: edge.id,
          severity: "warning",
        });
      }
      continue;
    }
    for (const edge of edges.slice(1)) {
      issues.push({
        code: "extraLoopEdge",
        nodeId,
        edgeId: edge.id,
        severity: "warning",
      });
    }
    const edge = edges[0]!;
    const read = loopBounds(edge);
    let problem = "problem" in read ? read.problem : null;
    if (!problem && "bounds" in read && read.bounds.until) {
      for (const [index, spec] of read.bounds.until.cases.entries()) {
        const bad = isFromReference(spec)
          ? 'a "$from" is not allowed'
          : matcherProblem(spec)?.message;
        if (bad) {
          problem = `loop.until.cases[${index}]: ${bad}`;
          break;
        }
      }
    }
    if (problem) {
      issues.push({
        code: "invalidLoop",
        nodeId,
        edgeId: edge.id,
        severity: "warning",
        data: { problem },
      });
      continue;
    }
    const bounds = "bounds" in read ? read.bounds : {};
    const bounded =
      bounds.times !== undefined ||
      bounds.forSeconds !== undefined ||
      bounds.until !== undefined;
    if (bounds.times === undefined) {
      const body = loopBody(program, edge);
      const waits = [...body].some(
        (id) => connectionRule(program.nodesById.get(id)?.type).pauses,
      );
      if (!waits) {
        issues.push({
          code: "busyLoop",
          nodeId,
          edgeId: edge.id,
          severity: "warning",
        });
      }
    }
    if (bounded && (program.outgoing.get(nodeId) ?? []).length === 0) {
      issues.push({
        code: "loopWithoutExit",
        nodeId,
        edgeId: edge.id,
        severity: "info",
      });
    }
  }
  if (first !== undefined) {
    issues.push(...newerConstruct(schemaVersion, "1.10", { edgeId: first }));
  }
  return issues;
}

export function validateScenarioGraph(def: {
  nodes: readonly GraphNodeLike[];
  edges: readonly GraphEdgeLike[];
  /** The file's declared version: only for `newerConstruct`. Never changes
   *  what any other check reports. */
  schemaVersion?: unknown;
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
    // A parallel (schema 1.9) runs every edge as its own branch.
    if (connectionRule(node.type).out === "fork") continue;
    if (edgesThatMayRun(program, nodeId).length > 1) {
      issues.push({ code: "extraOutgoing", nodeId, severity: "warning" });
    }
  }

  issues.push(...checkTimeoutEdges(program, def.schemaVersion));
  issues.push(...checkLoopEdges(program, def.schemaVersion));

  // Reachability from the origin only: a second START starts nothing (every
  // edge that may run counts: an ignored branch is reported by
  // `extraOutgoing`, not twice here; a switch / choice's duplicate-handle
  // edge never runs, so what only it leads to is unreachable too).
  if (origin) {
    const seen = new Set<string>([origin.id]);
    const queue = [origin.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const node = nodesById.get(id)!;
      const timeoutEdge = timeoutEdgeThatMayRun(program, node);
      // Schema 1.10: a loop edge may run; the node's ordinary edges only if
      // the loop can ever exit.
      const loop = loopThatMayRun(program, node);
      const edges = [
        ...(loop && !loop.exits ? [] : edgesThatMayRun(program, id)),
        ...(loop ? [loop.edge] : []),
        ...(timeoutEdge ? [timeoutEdge] : []),
      ];
      for (const edge of edges) {
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
    issues.push(...checkJoins(program, seen));
    issues.push(...checkCalls(origin, program));
  }
  issues.push(...checkSwitchCases(def.nodes));

  const flowNode = def.nodes.find(
    (n) =>
      n.type === ScenarioFlowNodeType.PARALLEL ||
      n.type === ScenarioFlowNodeType.JOIN,
  );
  if (flowNode) {
    issues.push(
      ...newerConstruct(def.schemaVersion, "1.9", { nodeId: flowNode.id }),
    );
  }

  return issues;
}

/** Every edge out of `node` a branch may take, its timeout edge included. */
function stepsOut(program: Program, node: GraphNodeLike): GraphEdgeLike[] {
  const timeoutEdge = timeoutEdgeThatMayRun(program, node);
  return [
    ...edgesThatMayRun(program, node.id),
    ...(timeoutEdge ? [timeoutEdge] : []),
  ];
}

/**
 * Schema 1.9: which `join` the branches of each `parallel` can meet at.
 * From each reachable parallel, walk its branches: a nested parallel opens a
 * level and the join that closes it goes on in the outer branch; a join at
 * the parallel's own level is where its branches meet. A parallel whose
 * branches meet at no join is `parallelWithoutJoin` (info); a reachable join
 * no parallel's branches meet at is `joinWithoutParallel` (warning).
 */
function checkJoins(program: Program, reachable: Set<string>): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const met = new Set<string>();
  const maxDepth = program.nodes.length;
  for (const parallel of program.nodes) {
    if (
      parallel.type !== ScenarioFlowNodeType.PARALLEL ||
      !reachable.has(parallel.id) ||
      program.nodesById.get(parallel.id) !== parallel
    ) {
      continue;
    }
    let meets = false;
    const seen = new Set<string>();
    const queue: Array<[string, number]> = [];
    const visit = (id: string, depth: number) => {
      const key = `${depth} ${id}`;
      if (depth > maxDepth || seen.has(key)) return;
      seen.add(key);
      queue.push([id, depth]);
    };
    for (const edge of successors(program, parallel)) visit(edge.target, 0);
    while (queue.length > 0) {
      const [id, depth] = queue.pop()!;
      const node = program.nodesById.get(id)!;
      if (isJoin(node)) {
        if (depth === 0) {
          meets = true;
          met.add(id);
          continue;
        }
        for (const edge of stepsOut(program, node))
          visit(edge.target, depth - 1);
        continue;
      }
      const inner = connectionRule(node.type).out === "fork" ? 1 : 0;
      for (const edge of stepsOut(program, node)) {
        visit(edge.target, depth + inner);
      }
    }
    if (!meets) {
      issues.push({
        code: "parallelWithoutJoin",
        nodeId: parallel.id,
        severity: "info",
      });
    }
  }
  for (const node of program.nodes) {
    if (isJoin(node) && reachable.has(node.id) && !met.has(node.id)) {
      issues.push({
        code: "joinWithoutParallel",
        nodeId: node.id,
        severity: "warning",
      });
    }
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
 * accepted false negative of an advisory check. A wait whose timeout can
 * expire also goes on along its timeout edge (schema 1.8) with the state it
 * was entered with: a timed-out replace trigger took nothing over.
 */
function checkCalls(origin: GraphNodeLike, program: Program): GraphIssue[] {
  const found = new Map<string, GraphIssue>();
  const report = (code: GraphIssueCode, nodeId: string, edgeId?: string) => {
    const severity = code === "callLeftOpen" ? "warning" : "error";
    found.set(`${code} ${nodeId} ${edgeId ?? ""}`, {
      code,
      nodeId,
      ...(edgeId === undefined ? {} : { edgeId }),
      severity,
    });
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
    // Schema 1.9: a branch ends at a join, its open CALL answered there; the
    // flow after the join is fresh (no CALL, no answer held).
    if (isJoin(node)) leftOpen(state);
    let after: CallState | null = isJoin(node) ? "none" : state;
    let answerAfter = isJoin(node) ? false : answer;
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
    // Schema 1.8: on a timeout the wait took nothing over and the branch
    // goes on along its timeout edge with the CALL it held before.
    const timeoutEdge = timeoutEdgeThatMayRun(program, node);
    if (timeoutEdge) enter(timeoutEdge.target, state, answer);
    if (after === null) continue;
    if (connectionRule(node.type).out === "fork") {
      // Schema 1.9: the parallel's branch drops its flow (an open CALL is
      // answered there); each new branch starts with a fresh one.
      leftOpen(after);
      for (const edge of successors(program, node)) {
        enter(edge.target, "none", false);
      }
      continue;
    }
    // Re-entering the origin runs it as a step (executeSequentialFlow).
    // A switch or choice may pick any of its handles: follow each.
    let followed = successors(program, node);
    // Schema 1.10: after the round the loop edge may run (its `until` reads
    // the state the node left), and the ordinary edges only if it can exit.
    const loop = loopThatMayRun(program, node);
    if (loop) {
      if (!loop.exits) followed = [];
      if (
        loop.until !== undefined &&
        ((containsCallReference(loop.until) && after === "none") ||
          (containsRootReference(loop.until, "response") && !answerAfter))
      ) {
        if (containsCallReference(loop.until) && after === "none") {
          report("noCallHeld", node.id, loop.edge.id);
        }
        if (containsRootReference(loop.until, "response") && !answerAfter) {
          report("noResponseHeld", node.id, loop.edge.id);
        }
        continue;
      }
      enter(loop.edge.target, after, answerAfter);
    }
    for (const edge of followed) enter(edge.target, after, answerAfter);
    if (followed.length === 0 && (!loop || loop.exits)) leftOpen(after);
  }

  return [...found.values()];
}

/**
 * The `$match` cases of every switch (schema 1.7): an operator the executor
 * does not know, an argument of the wrong type, and a case that an earlier one
 * makes unreachable (an identical one, or one that matches every present
 * value). Per case, not per path; conservative on purpose. A missing value is
 * picked up by a `{ "exists": false }` case only, so that one is never
 * reported as shadowed by an always-true matcher.
 */
function checkSwitchCases(nodes: readonly GraphNodeLike[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  for (const node of nodes) {
    if (node.type !== ScenarioNodeType.SWITCH) continue;
    const cases = (node.data as { cases?: unknown } | undefined)?.cases;
    if (!Array.isArray(cases)) continue;
    let allPresent: number | null = null;
    cases.forEach((spec: unknown, index: number) => {
      const handle = `case-${index}`;
      const problem = matcherProblem(spec);
      if (problem) {
        issues.push({
          code: problem.kind,
          nodeId: node.id,
          severity: "warning",
          data: { handle, operator: problem.operator },
        });
        return;
      }
      const same = cases.findIndex((c, i) => i < index && jsonEquals(c, spec));
      const shadow =
        same >= 0
          ? same
          : allPresent !== null && !isMissingOnly(spec)
            ? allPresent
            : null;
      if (shadow !== null) {
        issues.push({
          code: "unreachableCase",
          nodeId: node.id,
          severity: "warning",
          data: { handle, shadowedBy: `case-${shadow}` },
        });
      }
      if (allPresent === null && matchesEveryPresentValue(spec)) {
        allPresent = index;
      }
    });
  }
  return issues;
}

const isMissingOnly = (spec: unknown): boolean =>
  jsonEquals(spec, { $match: { exists: false } });
