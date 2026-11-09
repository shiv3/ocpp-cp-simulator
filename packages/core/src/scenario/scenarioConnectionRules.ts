/**
 * Which nodes a scenario graph may connect. The edge type itself (`id` /
 * `source` / `target`) says nothing: the rules below are what
 * `ScenarioExecutor` actually honours, one entry per node type in
 * {@link CONNECTION_RULES}. The table is typed so that a new
 * `ScenarioNodeType` does not compile until it declares its rule.
 *
 * Two kinds of rule are real:
 *
 * - **How a node is left** (`out`). Only the node a run starts from, and a
 *   `parallel` (schema 1.9), run several outgoing edges in parallel
 *   (`executeFlow` → `executeParallelBranches`; `runParallel`). From any
 *   other node `executeSequentialFlow` follows the first edge that points at
 *   an existing node and ignores the rest (a switch / choice: of its picked
 *   handle). A node of type `end` (or, legacy, any node labelled "End") stops
 *   its branch: nothing after it runs.
 * - **The CALL a branch holds** (`call`, schema 1.5). A `csmsCallTrigger`
 *   with `behavior: "replace"` hands its branch a CALL; a `callResponse`
 *   answers it and throws when its branch holds none or already answered
 *   it; a `$from: "call.…"` throws when its branch holds no CALL, wherever
 *   the executor resolves one (`ocppCall.payload`, `switch.value`,
 *   `setState.value`, `notify.requestId`; a `callResponse` payload needs
 *   the CALL anyway). A CALL still open when its branch ends is answered `InternalError`
 *   only when the run ends. These depend on what came earlier on the path,
 *   so they are the one place where node type A must precede node type B.
 *
 * Nothing else is constrained: any step may follow any step (including a
 * wait right after Start or another wait), loops and joins are allowed on
 * purpose, and an edge back into Start is followed like any other.
 *
 * Schema 1.8: an edge with `kind: "timeout"` is not an ordinary edge. Only a
 * node whose rule `waits` follows one, and only when its timeout expires
 * (`timeoutStep` in `scenarioGraph.ts`); every other walk ignores it.
 *
 * The graph itself (origin, branch ends, the edge taken next) is read
 * through `scenarioGraph.ts`, which the executor uses too; the checks live in
 * `scenarioGraphValidator.ts`. Advisory like the JSON schema: callers report
 * the issues and keep loading the scenario.
 */
import {
  ScenarioFlowNodeType,
  ScenarioNodeType,
  type AnyScenarioNodeType,
  type CallResponseNodeData,
  type CsmsCallTriggerNodeData,
  type NotifyNodeData,
  type OcppCallNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
} from "../cp/application/scenario/ScenarioTypes";
import {
  containsCallReference,
  containsRootReference,
} from "../cp/application/scenario/resolveFrom";
import type { Diagnostic } from "./diagnostic";

/**
 * How the executor leaves a node once it ran:
 * - `parallel`: every outgoing edge, each as its own branch (Start only);
 * - `fork`: every outgoing ordinary edge, each as its own branch with a
 *   fresh CALL slot, whose arrivals at a `join` the node's branch awaits
 *   (`parallel`, schema 1.9);
 * - `next`: the first edge to an existing node, the rest are ignored;
 * - `select`: the node picked one `sourceHandle` (`switch`: `case-N` /
 *   `default`; `choice`: `option-N`) and the branch goes on along the edges
 *   with that handle only, so several outgoing edges are the point;
 * - `none`: the branch ends here.
 */
export type OutEdges = "parallel" | "fork" | "next" | "select" | "none";

/**
 * What a node does to the CALL its branch holds (schema 1.5, #566):
 * - `takesOver`: the branch now holds a new, unanswered CALL;
 * - `answers`: needs an unanswered CALL and answers it;
 * - `reads`: needs a CALL, answered or not (a `$from` reference);
 * - `none`: does not touch it.
 */
export type CallEffect = "takesOver" | "answers" | "reads" | "none";

/**
 * What a node does to the answer its branch holds (`response`, schema 1.7):
 * `reads` is a `$from: "response.…"` that fails without an answer from an
 * earlier `ocppCall` in the branch; `produces` is an `ocppCall` that leaves
 * its answer (latest wins). A node can do both: its payload is resolved
 * before the call is sent.
 */
export interface ResponseEffect {
  reads: boolean;
  produces: boolean;
}

export interface ConnectionRule<D = unknown> {
  out: OutEdges;
  /** What the node does to its branch's `response`, when it does anything. */
  response?: (data: Partial<D> | undefined) => ResponseEffect;
  /** What the node does to its branch's CALL, from its data (which is
   *  unvalidated when the rule is consulted, so possibly partial). */
  call: (data: Partial<D> | undefined) => CallEffect;
  /**
   * The node parks on a trigger wait (`runTriggerWait`) bounded by
   * `data.timeout` seconds, so an edge with `kind: "timeout"` out of it can
   * run when that timeout expires (schema 1.8). Absent on every other node.
   */
  waits?: true;
}

/** Node data the rules read, per node type; the rest read none. */
interface RuleData {
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: CsmsCallTriggerNodeData;
  [ScenarioNodeType.CALL_RESPONSE]: CallResponseNodeData;
  [ScenarioNodeType.OCPP_CALL]: OcppCallNodeData;
  [ScenarioNodeType.SWITCH]: SwitchNodeData;
  [ScenarioNodeType.SET_STATE]: SetStateNodeData;
  [ScenarioNodeType.NOTIFY]: NotifyNodeData;
}

/** One rule for every node type, flow-control ones included: leaving a type
 *  out does not compile. */
export type ConnectionRuleTable = {
  readonly [K in AnyScenarioNodeType]: ConnectionRule<
    K extends keyof RuleData ? RuleData[K] : unknown
  >;
};

const noCall = (): CallEffect => "none";
const readsResponse = (value: unknown): ResponseEffect => ({
  reads: containsRootReference(value, "response"),
  produces: false,
});
/** An ordinary step: runs, then the first edge to an existing node. */
const step: ConnectionRule = { out: "next", call: noCall };
/** A trigger wait: a step that parks in `runTriggerWait` until its event or
 *  its `timeout` (schema 1.8: a timeout edge then runs instead of failing). */
const wait: ConnectionRule = { out: "next", call: noCall, waits: true };

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
  // the executor needs nothing before or after them. When their timeout
  // expires they leave by their first timeout edge, if any (schema 1.8).
  [ScenarioNodeType.REMOTE_START_TRIGGER]: wait,
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: wait,
  [ScenarioNodeType.STATUS_TRIGGER]: wait,
  [ScenarioNodeType.RESERVATION_TRIGGER]: wait,
  [ScenarioNodeType.CONNECTION_TRIGGER]: wait,
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
  // state. Neither changes the branch's CALL, but executeNotify resolves
  // `requestId` and executeSetState `value` through fromScope(flow): a
  // `$from: "call.…"` there throws without a CALL.
  [ScenarioNodeType.NOTIFY]: {
    out: "next",
    call: (data) => (containsCallReference(data?.requestId) ? "reads" : "none"),
    response: (data) => readsResponse(data?.requestId),
  },
  [ScenarioNodeType.SET_STATE]: {
    out: "next",
    call: (data) => (containsCallReference(data?.value) ? "reads" : "none"),
    response: (data) => readsResponse(data?.value),
  },
  // executeSequentialFlow: flow.handle set by executeSwitch / executeChoice
  // filters the outgoing edges by sourceHandle. executeSwitch resolves
  // `value` through fromScope(flow), like setState.
  [ScenarioNodeType.SWITCH]: {
    out: "select",
    call: (data) => (containsCallReference(data?.value) ? "reads" : "none"),
    response: (data) => readsResponse(data?.value),
  },
  [ScenarioNodeType.CHOICE]: { out: "select", call: noCall },
  // executeCsmsCallTrigger: with behavior "replace" sets flow.exchange. A
  // wait too: on a timeout nothing is taken over.
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: {
    out: "next",
    call: (data) => (data?.behavior === "replace" ? "takesOver" : "none"),
    waits: true,
  },
  // executeCallResponse: throws without flow.exchange or once flow.answered.
  // (its payload is resolved through fromScope(flow) too.)
  [ScenarioNodeType.CALL_RESPONSE]: {
    out: "next",
    call: () => "answers",
    response: (data) => readsResponse(data?.payload),
  },
  // executeOcppCall → resolveFrom: a $from without a CALL (or, schema 1.7,
  // without an earlier answer) throws. The answer it gets replaces the
  // branch's `response`.
  [ScenarioNodeType.OCPP_CALL]: {
    out: "next",
    call: (data) => (containsCallReference(data?.payload) ? "reads" : "none"),
    response: (data) => ({
      reads: containsRootReference(data?.payload, "response"),
      produces: true,
    }),
  },
  // Schema 1.9: executeSequentialFlow forks every outgoing ordinary edge into
  // a branch with a fresh flow, waits for them at a join, and goes on after
  // the join with a fresh flow.
  [ScenarioFlowNodeType.PARALLEL]: { out: "fork", call: noCall },
  // A branch started by a parallel ends at a join (registering its arrival);
  // the join then runs once and leaves by its first edge. Reached by any
  // other branch it is a plain step.
  [ScenarioFlowNodeType.JOIN]: { out: "next", call: noCall },
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
  /** A START other than the origin (the first node of type `start` or
   *  labelled "Start"): it never starts a run, and runs as an ordinary step
   *  (first edge only) only if an edge reaches it. */
  | "multipleStart"
  /** An edge leads back into a START that fans out: it is followed, but the
   *  branch goes on along START's first edge only, not every branch. */
  | "edgeIntoStart"
  /** An edge leaves END: it is never followed. */
  | "edgeOutOfEnd"
  /** A node other than the origin and a switch / choice has several outgoing
   *  edges: only the first runs. */
  | "extraOutgoing"
  /** An edge out of a switch / choice whose `sourceHandle` the node never
   *  picks (none, `case-N` beyond its cases, `option-N` beyond its options):
   *  it is never followed. */
  | "unpickableHandle"
  /** A switch / choice has several edges with one `sourceHandle` it picks:
   *  only the first (file order) runs, so each later one is never followed.
   *  Reported per later edge, with `data.handle`. */
  | "duplicateHandle"
  /** An edge's source or target is not a node of the scenario. */
  | "danglingEdge"
  /** No path from START reaches the node: it never runs. */
  | "unreachable"
  /** A `callResponse`, or a node with a `$from: "call.…"` (`ocppCall.payload`,
   *  `switch.value`, `setState.value`, `notify.requestId`), is reached on a path
   *  whose branch holds no CALL taken over by a replace `csmsCallTrigger`:
   *  the run fails there. */
  | "noCallHeld"
  /** A `callResponse` is reached on a path where the branch's CALL is already
   *  answered: the run fails there. */
  | "callAlreadyAnswered"
  /** A replace `csmsCallTrigger` whose CALL can still be open when its branch
   *  ends or takes over another CALL: the station answers it `InternalError`
   *  only when the run ends. Reported on the trigger. */
  | "callLeftOpen"
  /** A node with a `$from: "response.…"` is reached on a path whose branch
   *  holds no answer from an earlier `ocppCall` (schema 1.7): the run fails there. */
  | "noResponseHeld"
  /** A `$match` case of a switch uses an operator the executor does not know
   *  (schema 1.7): the switch fails the run when its node runs. `data.handle`
   *  is the case's handle, `data.operator` the operator. */
  | "unknownMatcher"
  /** A `$match` case of a switch has an argument of the wrong type, no
   *  operator, or a nested `not` (schema 1.7): the switch fails the run when
   *  its node runs. `data.handle`, `data.operator`. */
  | "badMatcherArgument"
  /** A case of a switch can never be picked because an earlier one is
   *  identical or matches every present value (schema 1.7). `data.handle` is
   *  the unreachable case, `data.shadowedBy` the earlier one's handle. */
  | "unreachableCase"
  /** An edge with `kind: "timeout"` (schema 1.8) out of a node that is not
   *  a trigger wait (or that ends its branch): it is never followed. */
  | "timeoutEdgeOnNonWait"
  /** A timeout edge out of a wait whose `timeout` is 0 or absent: the wait
   *  never expires, so the edge never runs (info). */
  | "timeoutEdgeNeverFires"
  /** A wait has several timeout edges: only the first one to an existing
   *  node runs; reported on each other one. */
  | "extraTimeoutEdge"
  /** The file uses a construct newer than its declared `schemaVersion`
   *  (`data.since`): it runs, but an older simulator would ignore it (info). */
  | "newerConstruct"
  /** A `join` that no branch of a `parallel` reaches: it only ever runs as
   *  a plain step (schema 1.9). */
  | "joinWithoutParallel"
  /** A `parallel` none of whose branches reaches a `join`: the branches just
   *  end, and nothing runs after the parallel (info, schema 1.9). */
  | "parallelWithoutJoin";

/** A finding of `validateScenarioGraph` (`scenarioGraphValidator.ts`): a
 *  {@link Diagnostic} narrowed to the graph codes. */
export interface GraphIssue extends Diagnostic<GraphIssueCode> {
  /** The node the issue is about (all codes but `missingStart` /
   *  `danglingEdge` / `newerConstruct`). */
  nodeId?: string;
  edgeId?: string;
  /** `error`: the scenario cannot run as drawn; `warning`: part of it is
   *  ignored; `info`: advisory only (`timeoutEdgeNeverFires`,
   *  `newerConstruct`). */
  severity: "error" | "warning" | "info";
}
