import { deriveExpectation } from "./ScenarioExpectations";
import { timeoutStep } from "../../../scenario/scenarioGraph";
import { cancelIfCancellable } from "./cancellable";
import { WaitControl, type WaitSignal } from "./WaitControl";
import type { Flow, NodeRunContext } from "./nodes/context";

/**
 * Park on a trigger wait (#240). The executor owns the node's timeout
 * through a {@link WaitControl} instead of the runtime, so an operator can
 * extend it, retry the wait (withdraw it and arm it again with the full
 * timeout) or continue past it without the awaited event. Resolves with
 * the awaited answer, or null when there is none (continued, force-skipped
 * or stopped). Timeout-bearing waits also surface 100ms remaining-time
 * progress events.
 *
 * When the timeout expires the run fails with the timeout error, unless
 * the node has a timeout edge (schema 1.8, `timeoutStep`): then the wait
 * resolves with null like a continued one (nothing is captured) and
 * `flow.timeoutTarget` sends the branch along that edge.
 */
export async function runTriggerWait<T>(
  ctx: NodeRunContext,
  nodeId: string,
  flow: Flow,
  timeoutSeconds: number | undefined,
  timeoutMessage: (seconds: number) => string,
  startWait: () => Promise<T>,
): Promise<{ value: T } | null> {
  const timeoutMs = Math.max(0, timeoutSeconds || 0) * 1000;
  const node = ctx.scenario.nodes.find((n) => n.id === nodeId);
  const expectation = node
    ? deriveExpectation(node, ctx.scenario.targetId)
    : null;
  const program = ctx.program();
  const programNode = program.nodesById.get(nodeId);
  const onTimeout = programNode ? timeoutStep(program, programNode) : null;

  for (;;) {
    const startedAt = ctx.clock.now();
    const control = new WaitControl(
      timeoutMs,
      (seconds) => new Error(timeoutMessage(seconds)),
      ctx.clock,
    );
    ctx.parkedWaits.push({ nodeId, control, expectation, startedAt });
    ctx.notifyStateChange();
    const stopProgress = reportWaitProgress(ctx, nodeId, control);
    let waitPromise: Promise<T> | undefined;
    // Only this attempt's own answer is returned: a withdrawn attempt that
    // answers late (e.g. with a stale RemoteStart tag) never reaches the run.
    let answer = null as { value: T } | null;
    let timeoutError: unknown = null;
    let outcome: WaitSignal | "settled" | "timedOut";
    try {
      waitPromise = startWait();
      outcome = await Promise.race([
        ctx
          .waitWithOptionalForceSkip(
            waitPromise.then((value) => {
              answer = { value };
            }),
            flow.scope,
          )
          .then(() => "settled" as const),
        // Without a timeout edge the expiry rejects and fails the run.
        onTimeout
          ? control.expired.catch((error: unknown) => {
              timeoutError = error;
              return "timedOut" as const;
            })
          : control.expired,
        control.signal,
      ]);
    } finally {
      if (waitPromise) cancelIfCancellable(waitPromise);
      control.dispose();
      stopProgress();
      ctx.unpark(control);
      ctx.notifyStateChange();
    }

    // A cancelled branch (schema 1.9) captures nothing.
    if (flow.scope.cancelled) return null;
    if (outcome === "settled") return answer;
    if (outcome === "timedOut" && onTimeout && !ctx.aborted) {
      const reason =
        timeoutError instanceof Error
          ? timeoutError.message
          : String(timeoutError);
      ctx.callbacks.log?.(
        `[${ctx.scenario.name}] ${reason}; "${
          node?.data?.label || nodeId
        }" goes on along its timeout edge to "${
          onTimeout.target.data?.label || onTimeout.target.id
        }"`,
        "info",
      );
      flow.timeoutTarget = onTimeout.target;
      return null;
    }
    if (outcome === "continue" || ctx.aborted) return null;
  }
}

/** Emit the 100ms remaining-time progress of a timeout-bearing wait;
 *  returns the function that stops it. */
function reportWaitProgress(
  ctx: NodeRunContext,
  nodeId: string,
  control: WaitControl,
): () => void {
  if (control.deadlineAt === null) return () => {};

  const progressInterval = ctx.clock.setInterval(() => {
    const remaining = (control.remainingMs() ?? 0) / 1000;
    const total = control.totalSeconds;
    ctx.callbacks.onNodeProgress?.(nodeId, remaining, total);
    const progressData = {
      scenarioId: ctx.scenario.id,
      nodeId,
      remaining,
      total,
    };
    ctx.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
    ctx.eventEmitter?.emit("node.progress", progressData); // Hierarchical event
    if (remaining <= 0) ctx.clock.clearInterval(progressInterval);
  }, 100);

  return () => {
    ctx.clock.clearInterval(progressInterval);
    const total = control.totalSeconds;
    ctx.callbacks.onNodeProgress?.(nodeId, 0, total);
    ctx.eventEmitter?.emit("nodeProgress", {
      scenarioId: ctx.scenario.id,
      nodeId,
      remaining: 0,
      total,
    });
  };
}
