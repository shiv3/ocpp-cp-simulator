import type {
  ScenarioCallExchange,
  ScenarioDefinition,
  ScenarioEvents,
  ScenarioExecutorCallbacks,
  ScenarioExpectation,
  ScenarioNode,
} from "../ScenarioTypes";
import type { FromScope, ScenarioOcppResponse } from "../resolveFrom";
import type { BranchScope } from "../branchScope";
import type { WaitControl } from "../WaitControl";
import type { EventEmitter } from "../../../shared/EventEmitter";
import type { SimClock } from "../../../shared/clock";
import type { Rng } from "../../../shared/rng";
import type { ScenarioProgram } from "../../../../scenario/scenarioGraph";

/** #240: a parked trigger wait — what it awaits and the controls of its
 *  armed attempt. */
export interface ParkedWait {
  nodeId: string;
  control: WaitControl;
  expectation: ScenarioExpectation | null;
  /** Epoch ms the node started parking; restarts on a retry. */
  startedAt: number;
}

/**
 * What one branch of the run owns (schema 1.5, #566): the CALL its
 * `csmsCallTrigger` took over. Branches from Start get one each, so parallel
 * branches can own different CALLs; the run ends with it unanswered only after
 * the runtime answered `InternalError` (see `onRunEnded`).
 */
export interface Flow {
  exchange: ScenarioCallExchange | null;
  answered: boolean;
  /**
   * The answer to the latest `ocppCall` of this branch (schema 1.7), for the
   * root `response`. Latest wins; a branch from Start begins without one.
   */
  response: ScenarioOcppResponse | null;
  /**
   * Set by a `switch` or `choice` node (schema 1.6): the `sourceHandle` of the
   * one edge the branch goes on along. Read and cleared by the walk.
   */
  handle: string | null;
  /**
   * Set by a trigger wait whose timeout expired and that has a timeout edge
   * (schema 1.8): the node the branch goes on to instead of failing. Read
   * and cleared by the walk.
   */
  timeoutTarget: ScenarioNode | null;
  /**
   * The branch's cancellation scope (schema 1.9): the run's root scope, or
   * the scope of a branch a `parallel` started. Every wait of the branch
   * races `scope.ended`.
   */
  scope: BranchScope;
  /**
   * The state of the loop edges (schema 1.10) this branch is in, by edge id:
   * rounds done and when the loop was entered (station clock, epoch ms). Fresh
   * whenever the branch arrives at a loop's header other than along the loop
   * edge itself; dropped when the loop exits.
   */
  loops: Map<string, { rounds: number; since: number }>;
}

export type ScenarioEdge = ScenarioDefinition["edges"][number];

/**
 * What the node and wait functions read of a run. `ScenarioExecutor` builds
 * it; reassigned fields are read through getters so a function always sees the
 * live value, and the wait helpers that touch the pause / step / abort
 * plumbing stay methods of the executor.
 */
export interface NodeRunContext {
  readonly scenario: ScenarioDefinition;
  readonly callbacks: ScenarioExecutorCallbacks;
  readonly eventEmitter: EventEmitter<ScenarioEvents> | undefined;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly runState: Record<string, unknown>;
  readonly armedOverrideActions: string[];
  readonly armedInboundPolicyActions: string[];
  readonly parkedWaits: ParkedWait[];
  readonly aborted: boolean;
  markCertificateQuirksArmed(): void;
  unpark(control: WaitControl): void;
  notifyStateChange(): void;
  program(): ScenarioProgram<ScenarioNode, ScenarioEdge>;
  fromScope(flow: Flow): FromScope;
  waitWithOptionalForceSkip(
    waitPromise: Promise<unknown>,
    scope: BranchScope,
  ): Promise<void>;
  sleep(ms: number, scope: BranchScope): Promise<void>;
  waitWithProgress(
    nodeId: string,
    totalSeconds: number,
    scope: BranchScope,
  ): Promise<void>;
}
