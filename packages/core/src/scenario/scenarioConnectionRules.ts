/**
 * Which nodes a scenario graph may connect. The edge type itself (`id` /
 * `source` / `target`) says nothing: the rules below are what
 * `ScenarioExecutor` actually honours, one entry per node type in
 * {@link CONNECTION_RULES}. The table is typed so that a new
 * `ScenarioNodeType` does not compile until it declares its rule.
 *
 * Two kinds of rule are real:
 *
 * - **How a node is left** (`out`). Only the node a run starts from runs
 *   several outgoing edges in parallel (`executeFlow` →
 *   `executeParallelBranches`). From any other node `executeSequentialFlow`
 *   follows the first edge that points at an existing node and ignores the
 *   rest. A node of type `end` (or, legacy, any node labelled "End") stops
 *   its branch: nothing after it runs.
 * - **The CALL a branch holds** (`call`, schema 1.5). A `csmsCallTrigger`
 *   with `behavior: "replace"` hands its branch a CALL; a `callResponse`
 *   answers it and throws when its branch holds none or already answered
 *   it; a `$from` in an `ocppCall` payload throws when its branch holds no
 *   CALL. A CALL still open when its branch ends is answered `InternalError`
 *   only when the run ends. These depend on what came earlier on the path,
 *   so they are the one place where node type A must precede node type B.
 *
 * Nothing else is constrained: any step may follow any step (including a
 * wait right after Start or another wait), loops and joins are allowed on
 * purpose, and an edge back into Start is followed like any other.
 *
 * Advisory like the JSON schema: callers report the issues and keep loading
 * the scenario.
 */
import {
  ScenarioNodeType,
  type CallResponseNodeData,
  type CsmsCallTriggerNodeData,
  type OcppCallNodeData,
} from "../cp/application/scenario/ScenarioTypes";
import { containsCallReference } from "../cp/application/scenario/resolveFrom";

/**
 * How the executor leaves a node once it ran:
 * - `parallel`: every outgoing edge, each as its own branch (Start only);
 * - `next`: the first edge to an existing node, the rest are ignored;
 * - `select`: the node picked one `sourceHandle` (`switch`: `case-N` /
 *   `default`; `choice`: `option-N`) and the branch goes on along the edges
 *   with that handle only, so several outgoing edges are the point;
 * - `none`: the branch ends here.
 */
export type OutEdges = "parallel" | "next" | "select" | "none";

/**
 * What a node does to the CALL its branch holds (schema 1.5, #566):
 * - `takesOver`: the branch now holds a new, unanswered CALL;
 * - `answers`: needs an unanswered CALL and answers it;
 * - `reads`: needs a CALL, answered or not (a `$from` reference);
 * - `none`: does not touch it.
 */
export type CallEffect = "takesOver" | "answers" | "reads" | "none";

export interface ConnectionRule<D = unknown> {
  out: OutEdges;
  /** What the node does to its branch's CALL, from its data (which is
   *  unvalidated when the rule is consulted, so possibly partial). */
  call: (data: Partial<D> | undefined) => CallEffect;
}

/** Node data the rules read, per node type; the rest read none. */
interface RuleData {
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: CsmsCallTriggerNodeData;
  [ScenarioNodeType.CALL_RESPONSE]: CallResponseNodeData;
  [ScenarioNodeType.OCPP_CALL]: OcppCallNodeData;
}

/** One rule for every node type: leaving a type out does not compile. */
export type ConnectionRuleTable = {
  readonly [K in ScenarioNodeType]: ConnectionRule<
    K extends keyof RuleData ? RuleData[K] : unknown
  >;
};

const noCall = (): CallEffect => "none";
/** An ordinary step: runs, then the first edge to an existing node. */
const step: ConnectionRule = { out: "next", call: noCall };

export const CONNECTION_RULES: ConnectionRuleTable = {
  // executeFlow: the run starts here and every outgoing edge becomes a
  // branch with its own CALL slot (newFlow()).
  [ScenarioNodeType.START]: { out: "parallel", call: noCall },
  // executeSequentialFlow breaks after an END node.
  [ScenarioNodeType.END]: { out: "none", call: noCall },
  [ScenarioNodeType.STATUS_CHANGE]: step,
  [ScenarioNodeType.TRANSACTION]: step,
  [ScenarioNodeType.METER_VALUE]: step,
  [ScenarioNodeType.DELAY]: step,
  [ScenarioNodeType.NOTIFICATION]: step,
  [ScenarioNodeType.CONNECTOR_PLUG]: step,
  // Waits park until their event (runTriggerWait) and then go on like a step;
  // the executor needs nothing before or after them.
  [ScenarioNodeType.REMOTE_START_TRIGGER]: step,
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: step,
  [ScenarioNodeType.STATUS_TRIGGER]: step,
  [ScenarioNodeType.RESERVATION_TRIGGER]: step,
  [ScenarioNodeType.CONNECTION_TRIGGER]: step,
  [ScenarioNodeType.RESERVE_NOW]: step,
  [ScenarioNodeType.CANCEL_RESERVATION]: step,
  [ScenarioNodeType.STATUS_NOTIFICATION]: step,
  [ScenarioNodeType.UNLOCK_OUTCOME]: step,
  [ScenarioNodeType.CONFIG_SET]: step,
  [ScenarioNodeType.DATA_TRANSFER]: step,
  [ScenarioNodeType.RESPONSE_OVERRIDE]: step,
  [ScenarioNodeType.INBOUND_POLICY]: step,
  [ScenarioNodeType.CERT_QUIRKS]: step,
  [ScenarioNodeType.USE_BEHAVIOR]: step,
  // Schema 1.6 (#654): fire-and-forget notification, a store into the run's
  // state; neither touches the branch's CALL.
  [ScenarioNodeType.NOTIFY]: step,
  [ScenarioNodeType.SET_STATE]: step,
  // executeSequentialFlow: flow.handle set by executeSwitch / executeChoice
  // filters the outgoing edges by sourceHandle.
  [ScenarioNodeType.SWITCH]: { out: "select", call: noCall },
  [ScenarioNodeType.CHOICE]: { out: "select", call: noCall },
  // executeCsmsCallTrigger: with behavior "replace" sets flow.exchange.
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: {
    out: "next",
    call: (data) => (data?.behavior === "replace" ? "takesOver" : "none"),
  },
  // executeCallResponse: throws without flow.exchange or once flow.answered.
  [ScenarioNodeType.CALL_RESPONSE]: { out: "next", call: () => "answers" },
  // executeOcppCall → resolveFromExchange: a $from without a CALL throws.
  [ScenarioNodeType.OCPP_CALL]: {
    out: "next",
    call: (data) => (containsCallReference(data?.payload) ? "reads" : "none"),
  },
};

/** The rule of a node type; an unknown type is an ordinary step (the executor
 *  warns "Unknown node type" and follows its first edge). */
export function connectionRule(type: string | undefined): ConnectionRule {
  return type !== undefined && Object.hasOwn(CONNECTION_RULES, type)
    ? (CONNECTION_RULES as Record<string, ConnectionRule>)[type]!
    : step;
}

export type GraphIssueCode =
  /** No START node: the executor throws "No start node found". */
  | "missingStart"
  /** More than one START: only the first is run. */
  | "multipleStart"
  /** An edge leads back into a START that fans out: it is followed, but the
   *  branch goes on along START's first edge only, not every branch. */
  | "edgeIntoStart"
  /** An edge leaves END: it is never followed. */
  | "edgeOutOfEnd"
  /** A node other than START has several outgoing edges: only the first runs. */
  | "extraOutgoing"
  /** An edge's source or target is not a node of the scenario. */
  | "danglingEdge"
  /** No path from START reaches the node: it never runs. */
  | "unreachable"
  /** A `callResponse`, or an `ocppCall` with `$from`, is reached on a path
   *  whose branch holds no CALL taken over by a replace `csmsCallTrigger`:
   *  the run fails there. */
  | "noCallHeld"
  /** A `callResponse` is reached on a path where the branch's CALL is already
   *  answered: the run fails there. */
  | "callAlreadyAnswered"
  /** A replace `csmsCallTrigger` whose CALL can still be open when its branch
   *  ends or takes over another CALL: the station answers it `InternalError`
   *  only when the run ends. Reported on the trigger. */
  | "callLeftOpen";

export interface GraphIssue {
  code: GraphIssueCode;
  /** The node the issue is about (all codes but `missingStart` / `danglingEdge`). */
  nodeId?: string;
  edgeId?: string;
  /** `error`: the scenario cannot run as drawn; `warning`: part of it is ignored. */
  severity: "error" | "warning";
}

interface GraphNodeLike {
  id: string;
  type?: string;
  data?: unknown;
}
interface GraphEdgeLike {
  id: string;
  source: string;
  target: string;
}

const labelOf = (node: GraphNodeLike): unknown =>
  (node.data as { label?: unknown } | undefined)?.label;

/** The executor's own test for where a run starts (`executeFlow`): the first
 *  node of type `start` or labelled "Start". */
function isStartCandidate(node: GraphNodeLike): boolean {
  return node.type === ScenarioNodeType.START || labelOf(node) === "Start";
}

/** The executor's own test for a branch end (`executeSequentialFlow`): type
 *  `end` or labelled "End". */
function endsBranch(node: GraphNodeLike): boolean {
  return connectionRule(node.type).out === "none" || labelOf(node) === "End";
}

/** A branch's CALL: none yet, answered, or open (held since `open:<trigger id>`). */
type CallState = "none" | "answered" | `open:${string}`;

export function validateScenarioGraph(def: {
  nodes: readonly GraphNodeLike[];
  edges: readonly GraphEdgeLike[];
}): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const origin = def.nodes.find(isStartCandidate);
  const starts = def.nodes.filter(
    (n) => n === origin || n.type === ScenarioNodeType.START,
  );

  if (!origin) {
    issues.push({ code: "missingStart", severity: "error" });
  }
  for (const extra of starts.slice(1)) {
    issues.push({
      code: "multipleStart",
      nodeId: extra.id,
      severity: "warning",
    });
  }

  // Edges grouped by source, in file order (the executor takes the first).
  const outgoing = new Map<string, GraphEdgeLike[]>();
  const intoStart: GraphEdgeLike[] = [];
  for (const edge of def.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      issues.push({
        code: "danglingEdge",
        edgeId: edge.id,
        severity: "warning",
      });
      continue;
    }
    if (target === origin) intoStart.push(edge);
    if (source !== origin && endsBranch(source)) {
      issues.push({
        code: "edgeOutOfEnd",
        nodeId: source.id,
        edgeId: edge.id,
        severity: "warning",
      });
      continue; // never followed: not part of the graph that runs
    }
    const list = outgoing.get(source.id);
    if (list) list.push(edge);
    else outgoing.set(source.id, [edge]);
  }

  // Re-entering the origin runs it as a step: on along its first edge only.
  if (origin && (outgoing.get(origin.id)?.length ?? 0) > 1) {
    for (const edge of intoStart) {
      issues.push({
        code: "edgeIntoStart",
        nodeId: origin.id,
        edgeId: edge.id,
        severity: "warning",
      });
    }
  }

  for (const [nodeId, edges] of outgoing) {
    const node = nodesById.get(nodeId)!;
    if (starts.includes(node)) continue; // fans out, or reported as multipleStart
    if (connectionRule(node.type).out === "select") continue; // one per handle
    if (edges.length > 1) {
      issues.push({ code: "extraOutgoing", nodeId, severity: "warning" });
    }
  }

  // Reachability from START (every outgoing edge counts: an ignored branch
  // is reported by `extraOutgoing`, not twice here).
  if (origin) {
    const seen = new Set<string>(starts.map((s) => s.id));
    const queue = [...seen];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const edge of outgoing.get(id) ?? []) {
        if (!seen.has(edge.target)) {
          seen.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of def.nodes) {
      if (!seen.has(node.id) && node.type !== ScenarioNodeType.END) {
        issues.push({
          code: "unreachable",
          nodeId: node.id,
          severity: "warning",
        });
      }
    }
    issues.push(...checkCalls(origin, outgoing, nodesById));
  }

  return issues;
}

/**
 * Follow the CALL each branch holds along the edges the executor really takes
 * (all of the origin's, then the first one of every other node) until no
 * state changes, and report the paths on which a node needs a CALL its branch
 * does not hold. An operator's "continue" on a parked replace trigger leaves
 * the branch's CALL as it was; that manual escape is not modelled.
 */
function checkCalls(
  origin: GraphNodeLike,
  outgoing: ReadonlyMap<string, readonly GraphEdgeLike[]>,
  nodesById: ReadonlyMap<string, GraphNodeLike>,
): GraphIssue[] {
  const found = new Map<string, GraphIssue>();
  const report = (code: GraphIssueCode, nodeId: string) => {
    const severity = code === "callLeftOpen" ? "warning" : "error";
    found.set(`${code} ${nodeId}`, { code, nodeId, severity });
  };

  const statesAt = new Map<string, Set<CallState>>();
  const queue: Array<[string, CallState]> = [];
  const enter = (nodeId: string, state: CallState) => {
    const seen = statesAt.get(nodeId) ?? new Set<CallState>();
    if (seen.has(state)) return;
    seen.add(state);
    statesAt.set(nodeId, seen);
    queue.push([nodeId, state]);
  };
  const leftOpen = (state: CallState) => {
    if (state.startsWith("open:")) report("callLeftOpen", state.slice(5));
  };

  // Each branch from the origin starts with a fresh CALL slot (newFlow()).
  for (const edge of outgoing.get(origin.id) ?? []) enter(edge.target, "none");

  while (queue.length > 0) {
    const [nodeId, state] = queue.pop()!;
    const node = nodesById.get(nodeId)!;
    let after: CallState | null = state;
    switch (connectionRule(node.type).call(node.data as never)) {
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
    if (after === null) continue;
    // Re-entering the origin runs it as a step (executeSequentialFlow).
    // A switch or choice may take any of its edges: follow them all.
    const edges = endsBranch(node) ? [] : (outgoing.get(node.id) ?? []);
    const followed =
      connectionRule(node.type).out === "select" ? edges : edges.slice(0, 1);
    for (const edge of followed) enter(edge.target, after);
    if (followed.length === 0) leftOpen(after);
  }

  return [...found.values()];
}
