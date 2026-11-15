import type { ScenarioNode } from "./ScenarioTypes";
import { ScenarioNodeType } from "./ScenarioTypes";
import type { ScenarioEvents } from "./ScenarioTypes";
import type { BranchScope } from "./branchScope";
import { ParallelRegion } from "./branchScope";
import type { Flow, FlowRunContext, ScenarioEdge } from "./nodes/context";
import { pickCase } from "./nodes/branching";
import { executeNode } from "./nodes/dispatch";
import { waitForStep, waitIfPaused } from "./waits";
import {
  isTerminal,
  loopBounds,
  loopStep,
  isJoin,
  joinMode,
  nextStep,
  resolveOrigin,
  successors,
} from "../../../scenario/scenarioGraph";
import { connectionRule } from "../../../scenario/scenarioConnectionRules";

/** The part of the executor's start options the walk reads. */
export interface FlowStartOptions {
  resumeFromNodeId?: string;
  executedNodes?: string[];
}

export const newFlow = (scope: BranchScope): Flow => ({
  exchange: null,
  answered: false,
  response: null,
  handle: null,
  timeoutTarget: null,
  scope,
  loops: new Map(),
});

/**
 * Execute the flow from start to end
 * Supports scenarios with internal loops - use Stop button to exit infinite loops
 * Supports parallel branches from Start node
 *
 * If `opts.resumeFromNodeId` is supplied AND the node exists, the executor
 * resumes from the outgoing edge of that node — the START node and every
 * node up to `resumeFromNodeId` are treated as already executed and are
 * NOT re-fired. Used by the daemon restart path so side-effecting nodes
 * (Plug In, Start Transaction, …) don't double-emit OCPP traffic.
 */
export async function executeFlow(
  ctx: FlowRunContext,
  opts?: FlowStartOptions,
): Promise<void> {
  const resumeFromNodeId = opts?.resumeFromNodeId;
  let originNode: ScenarioNode | undefined;
  let resumed = false;

  const program = ctx.program();
  if (resumeFromNodeId) {
    originNode = program.nodesById.get(resumeFromNodeId);
    if (originNode) {
      // Seed executedNodes from the resume snapshot so any node-history
      // check inside an executor down the flow has the right shape.
      // Fall back to `[resumeFromNodeId]` when the caller didn't provide
      // the full list (it's only used for diagnostics in most nodes).
      const seededNodes =
        opts?.executedNodes && opts.executedNodes.length > 0
          ? [...opts.executedNodes]
          : [resumeFromNodeId];
      ctx.executedNodes = seededNodes;
      ctx.currentNodeId = originNode.id;
      ctx.currentNodeStartedAt = ctx.clock.now();
      resumed = true;
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] Resuming scenario from node "${
          originNode.data?.label || originNode.id
        }"`,
        "info",
      );
    } else {
      // Scenario tree changed between persistence and resume; fall
      // through to a fresh run. Logged at warn so an operator sees it.
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] Cannot resume: node "${resumeFromNodeId}" no ` +
          "longer exists in scenario; falling back to fresh start",
        "warn",
      );
    }
  }

  if (!originNode) {
    // Normal path: find and execute the Start node.
    originNode = resolveOrigin(program);
    if (!originNode) {
      throw new Error("No start node found in scenario");
    }
    const originFlow = newFlow(ctx.rootScope);
    await executeSingleNode(ctx, originNode, originFlow);
    if (originFlow.timeoutTarget) {
      // Schema 1.8: an origin that is a timed-out wait (a legacy wait
      // labelled "Start") leaves by its timeout edge alone.
      const target = originFlow.timeoutTarget;
      originFlow.timeoutTarget = null;
      await executeSequentialFlow(ctx, target, originFlow);
      ctx.currentNodeId = null;
      ctx.currentNodeStartedAt = null;
      return;
    }
  }

  // Walk outgoing edges from the origin node (whether Start or resume).
  const nextNodes = successors(program, originNode, { asOrigin: true }).map(
    (edge) => program.nodesById.get(edge.target)!,
  );

  const originOut = connectionRule(originNode.type).out;
  if (resumed && (originOut === "select" || originOut === "fork")) {
    // The chosen handle is not persisted: decide again (a choice from its
    // seeded stream), then go on along that one edge. A parallel (schema
    // 1.9) runs again: it has no effect of its own, and its branches then
    // meet at their join as in a fresh run.
    await executeSequentialFlow(ctx, originNode, newFlow(ctx.rootScope));
    ctx.currentNodeId = null;
    ctx.currentNodeStartedAt = null;
    return;
  }

  if (nextNodes.length === 0) {
    const tag = resumed ? "Resume point" : "Start";
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] No nodes after ${tag}, scenario ends`,
      resumed ? "info" : "warn",
    );
    return;
  }

  if (nextNodes.length === 1) {
    // Single branch - execute sequentially
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] Executing single branch`,
      "debug",
    );
    await executeSequentialFlow(ctx, nextNodes[0]!, newFlow(ctx.rootScope));
  } else {
    // Multiple branches - execute in parallel
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] Executing ${nextNodes.length} parallel branches`,
      "info",
    );
    await executeParallelBranches(ctx, nextNodes);
  }

  // Clear current node
  ctx.currentNodeId = null;
  ctx.currentNodeStartedAt = null;
}

/**
 * Execute multiple branches in parallel
 * Each branch runs independently until it reaches an End node or terminates
 */
async function executeParallelBranches(
  ctx: FlowRunContext,
  startNodes: ScenarioNode[],
): Promise<void> {
  const branches = startNodes.map((node, index) => {
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] Starting branch ${index + 1} from node: ${node.data?.label || node.id}`,
      "debug",
    );
    return executeSequentialFlow(ctx, node, newFlow(ctx.rootScope));
  });

  // Wait for all branches to complete
  await Promise.all(branches);
  ctx.callbacks.log?.(
    `[${ctx.scenario.name}] All ${branches.length} parallel branches completed`,
    "info",
  );
}

/**
 * Execute a sequential flow starting from a given node
 */
async function executeSequentialFlow(
  ctx: FlowRunContext,
  startNode: ScenarioNode,
  branchFlow: Flow,
): Promise<void> {
  let currentNode = startNode;
  let flow = branchFlow;
  // Schema 1.9: the join this branch goes on from after its parallel's
  // branches met there; it runs as a step, not as an arrival.
  let continuingJoin: ScenarioNode | null = null;
  // When this branch's walk began: the clock of a loop the branch is already
  // inside (it started or resumed in the body) counts from here.
  const walkStartedAt = ctx.clock.now();
  enterNode(ctx, currentNode, flow);

  while (currentNode && !ctx.aborted && ctx.stateName() !== "idle") {
    if (flow.scope.cancelled) break;
    if (isJoin(currentNode) && currentNode !== continuingJoin) {
      const region = flow.scope.region;
      if (region) {
        // Schema 1.9: a branch a parallel started ends at a join.
        arriveAtJoin(ctx, currentNode, flow, region);
        return;
      }
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] Join "${currentNode.data?.label || currentNode.id}" reached by a branch no parallel started; it runs as a plain step`,
        "info",
      );
    }
    continuingJoin = null;

    // Execute the current node
    await executeSingleNode(ctx, currentNode, flow);

    // If the node finished while paused, do not make the next node visible
    // until the run has been resumed. Stop/abort can also land while parked.
    await waitIfPaused(ctx, flow.scope);
    if (ctx.aborted || ctx.stateName() === "idle") {
      break;
    }
    if (flow.scope.cancelled) break;

    // Schema 1.8: a wait that timed out goes on along its timeout edge.
    const timedOutTo = flow.timeoutTarget;
    flow.timeoutTarget = null;
    if (timedOutTo) {
      flow.handle = null;
      currentNode = timedOutTo;
      enterNode(ctx, currentNode, flow);
      continue;
    }

    // Check if this is the end node
    if (isTerminal(currentNode)) {
      break;
    }

    // Schema 1.9: a parallel forks; this branch waits for its branches to
    // meet at a join and goes on from there with a fresh flow.
    if (connectionRule(currentNode.type).out === "fork") {
      const join = await runParallel(ctx, currentNode, flow);
      if (!join) break;
      flow = newFlow(flow.scope);
      currentNode = join;
      continuingJoin = join;
      continue;
    }

    // Find next node. A switch or choice picked one edge by its handle
    // (schema 1.6).
    const handle = flow.handle;
    flow.handle = null;

    // Schema 1.10: a loop edge out of this node, after its round. Going
    // round again keeps the loop's state; exiting drops it and the branch
    // goes on along the node's ordinary edge, if any.
    const loop = handle === null ? loopStep(ctx.program(), currentNode) : null;
    if (loop && !loopExits(ctx, loop.edge, currentNode, flow, walkStartedAt)) {
      currentNode = loop.target;
      continue;
    }

    const step = nextStep(ctx.program(), currentNode, handle);
    if (step.kind === "noEdgeForHandle") {
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] "${currentNode.data?.label || currentNode.id}" chose "${handle}", which has no edge; the branch ends`,
        "info",
      );
      break;
    }
    if (step.kind === "missingTargets") {
      console.warn(
        `[ScenarioExecutor] All outgoing edges from node ${currentNode!.id} point to non-existent nodes. Branch will end here.`,
      );
      break;
    }
    if (step.kind !== "edge") {
      break; // No more nodes to execute
    }

    currentNode = step.target;
    enterNode(ctx, currentNode, flow);
  }

  if (flow.scope.cancelled && !ctx.aborted) {
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] Branch at "${currentNode.data?.label || currentNode.id}" cancelled: another branch reached an "any" join first, or a sibling failed`,
      "info",
    );
    dropOpenCall(ctx, flow, "cancelled the branch");
  }
}

/**
 * Schema 1.9: answer the CALL a branch still holds unanswered with
 * `InternalError` now, because its flow is dropped (the branch was
 * cancelled, reached a join, or forked at a parallel). Does not wait for
 * the answer to settle.
 */
function dropOpenCall(ctx: FlowRunContext, flow: Flow, why: string): void {
  const exchange = flow.exchange;
  if (!exchange || flow.answered) return;
  flow.answered = true;
  ctx.callbacks.log?.(
    `${exchange.action}: the scenario ${why} before it answered this call; answering InternalError`,
    "warn",
  );
  try {
    void exchange
      .answer({
        kind: "error",
        errorCode: "InternalError",
        errorDescription: `The scenario ${why} before it answered this call`,
      })
      .catch(() => undefined);
  } catch {
    // An answer that cannot be sent is the runtime's to report.
  }
}

/** Schema 1.9: a branch of `region` reached `join`; the branch ends here. */
function arriveAtJoin(
  ctx: FlowRunContext,
  join: ScenarioNode,
  flow: Flow,
  region: ParallelRegion,
): void {
  const mode = joinMode(join);
  ctx.callbacks.log?.(
    `[${ctx.scenario.name}] A branch of "${region.parallelNodeId}" reached join "${join.data?.label || join.id}" (${mode})`,
    "debug",
  );
  dropOpenCall(ctx, flow, "reached a join");
  region.arrive(join, mode);
}

/**
 * Schema 1.9: run every outgoing ordinary edge of `node` (a `parallel`) as
 * its own branch, each with a fresh flow and a child scope, and wait until
 * they meet. Resolves with the join to go on from, or null when no branch
 * reached one (or this branch was cancelled, or the run stopped). A branch
 * that fails cancels its siblings and fails the run.
 */
async function runParallel(
  ctx: FlowRunContext,
  node: ScenarioNode,
  flow: Flow,
): Promise<ScenarioNode | null> {
  const program = ctx.program();
  const targets = successors(program, node).map((edge) =>
    program.nodesById.get(edge.target)!,
  );
  const label = node.data?.label || node.id;
  // The flow after the join is fresh: the CALL held here is dropped.
  dropOpenCall(ctx, flow, "forked the branch at a parallel");
  const region = new ParallelRegion(node.id);
  ctx.callbacks.log?.(
    `[${ctx.scenario.name}] "${label}" starts ${targets.length} parallel branches`,
    "info",
  );
  for (const target of targets) {
    const scope = flow.scope.child(region);
    region.addBranch(scope);
    executeSequentialFlow(ctx, target, newFlow(scope)).then(
      () => {
        scope.release();
        region.branchEnded();
      },
      (error: unknown) => {
        scope.release();
        if (region.isSettled) {
          ctx.callbacks.log?.(
            `[${ctx.scenario.name}] A cancelled branch of "${label}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warn",
          );
        }
        region.fail(error);
      },
    );
  }
  region.empty();

  const outcome = await Promise.race([
    region.settled,
    flow.scope.ended.then(() => null),
  ]);
  // Whatever settled it, nothing of this execution runs on: an `any` join
  // cancels the other branches, a failure its siblings, a stop everything.
  for (const branch of region.branches) branch.cancel();
  if (outcome === null || ctx.aborted) return null;
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "noJoin") {
    ctx.callbacks.log?.(
      `[${ctx.scenario.name}] No branch of "${label}" reached a join; the branch ends`,
      "info",
    );
    return null;
  }
  ctx.callbacks.log?.(
    `[${ctx.scenario.name}] The branches of "${label}" met at "${
      (outcome.join as ScenarioNode).data?.label || outcome.join.id
    }" (${joinMode(outcome.join)})`,
    "info",
  );
  return outcome.join as ScenarioNode;
}

/**
 * The branch arrives at `node` by anything but a loop edge (an ordinary
 * edge, or the walk starting there): every loop edge back to `node` begins
 * afresh, so a nested loop restarts when the outer body enters it again.
 */
function enterNode(ctx: FlowRunContext, node: ScenarioNode, flow: Flow): void {
  const loops = ctx.program().loopEdgesInto.get(node.id);
  if (!loops) return;
  const since = ctx.clock.now();
  for (const edge of loops) flow.loops.set(edge.id, { rounds: 0, since });
}

/**
 * Schema 1.10: the end-of-round check of a loop edge, right after its
 * source ran (do-while): count the round, then exit when `times` rounds are
 * done, `forSeconds` have passed on the station clock since the loop was
 * entered, or `until` matches one of its cases, as a switch does. Without a
 * bound the loop never exits. A malformed `loop` fails the run here.
 */
function loopExits(
  ctx: FlowRunContext,
  edge: ScenarioEdge,
  source: ScenarioNode,
  flow: Flow,
  walkStartedAt: number,
): boolean {
  const read = loopBounds(edge);
  if ("problem" in read) {
    throw new Error(`loop edge "${edge.id}": ${read.problem}`);
  }
  const { times, forSeconds, until } = read.bounds;
  let state = flow.loops.get(edge.id);
  if (!state) {
    state = { rounds: 0, since: walkStartedAt };
    flow.loops.set(edge.id, state);
  }
  state.rounds += 1;
  let fired: string | null = null;
  if (times !== undefined && state.rounds >= times) {
    fired = `times ${times}`;
  } else if (
    forSeconds !== undefined &&
    ctx.clock.now() - state.since >= forSeconds * 1000
  ) {
    fired = `forSeconds ${forSeconds}`;
  } else if (until) {
    const picked = pickCase(
      ctx,
      `loop edge "${edge.id}" until`,
      until.value,
      until.cases,
      flow,
    );
    if (picked.index >= 0) fired = `until case ${picked.index}`;
  }
  if (fired === null) return false;
  flow.loops.delete(edge.id);
  ctx.callbacks.log?.(
    `Loop "${edge.id}" out of "${source.data?.label || source.id}" exits (${fired}) after ${state.rounds} round${state.rounds === 1 ? "" : "s"}`,
    "info",
  );
  return true;
}

/**
 * Execute a single node
 */
async function executeSingleNode(
  ctx: FlowRunContext,
  node: ScenarioNode,
  flow: Flow,
): Promise<void> {
  // A stop() may have landed while the previous node was awaiting; never
  // start another node once aborted (or once the branch was cancelled).
  if (ctx.aborted || flow.scope.cancelled) {
    return;
  }

  // Do not make the node visible while paused. This protects the boundary
  // after an in-flight wait resolves under pause.
  await waitIfPaused(ctx, flow.scope);
  if (ctx.aborted || flow.scope.cancelled || ctx.stateName() === "idle") {
    return;
  }

  // Wait for step before marking/emitting the node so each step exposes
  // exactly one more node.
  const stateName = ctx.stateName();
  if (stateName === "stepping") {
    await waitForStep(ctx, flow.scope);
    if (ctx.aborted || flow.scope.cancelled || ctx.stateName() === "idle") {
      return;
    }
  }

  // Update context with current node
  ctx.currentNodeId = node.id;
  ctx.currentNodeStartedAt = ctx.clock.now();
  ctx.executedNodes.push(node.id);

  ctx.notifyStateChange();
  ctx.callbacks.onNodeExecute?.(node.id);

  // Emit node execute events
  const nodeExecuteData = {
    scenarioId: ctx.scenario.id,
    nodeId: node.id,
    nodeType: node.type as ScenarioNodeType,
  };
  ctx.eventEmitter?.emit("nodeExecute", nodeExecuteData); // Backward compatibility
  ctx.eventEmitter?.emit("node.execute", nodeExecuteData); // Hierarchical event
  // Emit specific node type event: node.{nodeType}.execute
  ctx.eventEmitter?.emit(
    `node.${node.type}.execute` as keyof ScenarioEvents,
    nodeExecuteData,
  );

  // Execute node
  if (
    node.type !== ScenarioNodeType.START &&
    node.type !== ScenarioNodeType.END
  ) {
    await executeNode(ctx, node, flow);
  }

  // Dispatch NODE_COMPLETE event
  ctx.sendNodeComplete(node.id);

  // Emit node complete events
  const nodeCompleteData = {
    scenarioId: ctx.scenario.id,
    nodeId: node.id,
  };
  ctx.eventEmitter?.emit("nodeComplete", nodeCompleteData); // Backward compatibility
  ctx.eventEmitter?.emit("node.complete", nodeCompleteData); // Hierarchical event
  // Emit specific node type event: node.{nodeType}.complete
  ctx.eventEmitter?.emit(
    `node.${node.type}.complete` as keyof ScenarioEvents,
    nodeCompleteData,
  );
}
