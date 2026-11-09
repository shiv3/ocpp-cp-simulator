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
 * The graph itself (origin, branch ends, the edge taken next) is read
 * through `scenarioGraph.ts`, which the executor uses too; the checks live in
 * `scenarioGraphValidator.ts`. Advisory like the JSON schema: callers report
 * the issues and keep loading the scenario.
 */
import {
  ScenarioNodeType,
  type CallResponseNodeData,
  type CsmsCallTriggerNodeData,
  type NotifyNodeData,
  type OcppCallNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
} from "../cp/application/scenario/ScenarioTypes";
import { containsCallReference } from "../cp/application/scenario/resolveFrom";
import type { Diagnostic } from "./diagnostic";

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
  [ScenarioNodeType.SWITCH]: SwitchNodeData;
  [ScenarioNodeType.SET_STATE]: SetStateNodeData;
  [ScenarioNodeType.NOTIFY]: NotifyNodeData;
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
  // state. Neither changes the branch's CALL, but executeNotify resolves
  // `requestId` and executeSetState `value` through fromScope(flow): a
  // `$from: "call.…"` there throws without a CALL.
  [ScenarioNodeType.NOTIFY]: {
    out: "next",
    call: (data) => (containsCallReference(data?.requestId) ? "reads" : "none"),
  },
  [ScenarioNodeType.SET_STATE]: {
    out: "next",
    call: (data) => (containsCallReference(data?.value) ? "reads" : "none"),
  },
  // executeSequentialFlow: flow.handle set by executeSwitch / executeChoice
  // filters the outgoing edges by sourceHandle. executeSwitch resolves
  // `value` through fromScope(flow), like setState.
  [ScenarioNodeType.SWITCH]: {
    out: "select",
    call: (data) => (containsCallReference(data?.value) ? "reads" : "none"),
  },
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
  | "callLeftOpen";

/** A finding of `validateScenarioGraph` (`scenarioGraphValidator.ts`): a
 *  {@link Diagnostic} narrowed to the graph codes, never `info`. */
export interface GraphIssue extends Diagnostic<GraphIssueCode> {
  /** The node the issue is about (all codes but `missingStart` / `danglingEdge`). */
  nodeId?: string;
  edgeId?: string;
  /** `error`: the scenario cannot run as drawn; `warning`: part of it is ignored. */
  severity: "error" | "warning";
}
