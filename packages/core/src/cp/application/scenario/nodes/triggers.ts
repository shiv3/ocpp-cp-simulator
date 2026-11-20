import type {
  CancelReservationNodeData,
  ConnectionTriggerNodeData,
  CsmsCallTriggerNodeData,
  RemoteStartTriggerNodeData,
  RemoteStopTriggerNodeData,
  ReservationTriggerNodeData,
  ReserveNowNodeData,
  StatusTriggerNodeData,
} from "../ScenarioTypes";
import type { IdTokenTypeName } from "../../../domain/connector/Transaction";
import { runTriggerWait } from "../waits";
import type { Flow, NodeRunContext } from "./context";

/**
 * Execute remote start trigger node with progress updates
 * Waits for RemoteStartTransaction request from central system
 * Captures the tagId for use by subsequent Transaction nodes
 */
export async function executeRemoteStartTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: RemoteStartTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForRemoteStart = ctx.callbacks.onWaitForRemoteStart;
  if (!waitForRemoteStart) return;

  const answer = (
    await runTriggerWait(
      ctx,
      nodeId,
      flow,
      data.timeout,
      (seconds) => `Timeout waiting for remote start (${seconds}s)`,
      () => waitForRemoteStart(),
    )
  )?.value;
  // A cancelled branch (schema 1.9) leaves the run's capture alone.
  if (flow.scope.cancelled) return;
  // A wait continued past (#240) captures nothing, so the next Transaction
  // node falls back to its own tag.
  if (answer === undefined) {
    ctx.remoteStartTagId = null;
    ctx.remoteStartOptions = null;
  } else if (typeof answer === "string") {
    ctx.remoteStartTagId = answer;
    ctx.remoteStartOptions = { triggerReason: "RemoteStart" };
  } else {
    ctx.remoteStartTagId = answer.tagId;
    ctx.remoteStartOptions = {
      triggerReason: "RemoteStart",
      ...(answer.remoteStartId !== undefined
        ? { remoteStartId: answer.remoteStartId }
        : {}),
      // The type the CSMS sent; a Transaction node's own idTokenType wins
      // (executeTransaction spreads the node's value last).
      ...(answer.idTokenType !== undefined
        ? { idTokenType: answer.idTokenType }
        : {}),
    };
  }
}
/**
 * Execute remote stop trigger node. Mirror of executeRemoteStartTrigger
 * but for the CSMS-initiated stop side. Parks the scenario until the
 * runtime callback resolves (the runtime installs a scenario-stop
 * handler on the CP so the default RemoteStopTransactionHandler defers
 * to us).
 */
export async function executeRemoteStopTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: RemoteStopTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForRemoteStop = ctx.callbacks.onWaitForRemoteStop;
  if (!waitForRemoteStop) return;

  // Capture {reason, triggerReason} so the next Transaction Stop node can
  // pass `reason` through to StopTransaction.req. The runtime hard-codes
  // "Remote" for the CSMS path (§6.21). A continued wait (#240) captures
  // nothing, so that node falls back to its own stopReason.
  const result = await runTriggerWait(
    ctx,
    nodeId,
    flow,
    data.timeout,
    (seconds) => `Timeout waiting for remote stop (${seconds}s)`,
    () => waitForRemoteStop(),
  );
  if (flow.scope.cancelled) return;
  ctx.remoteStopReason = result?.value?.reason ?? null;
  ctx.remoteStopOptions = result
    ? { triggerReason: result.value?.triggerReason ?? "RemoteStop" }
    : null;
}
/**
 * Execute status trigger node with progress updates
 * Waits for connector status to change to target status
 */
export async function executeStatusTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: StatusTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForStatus = ctx.callbacks.onWaitForStatus;
  if (!waitForStatus) return;

  await runTriggerWait(
    ctx,
    nodeId,
    flow,
    data.timeout,
    (seconds) =>
      `Timeout waiting for status: ${data.targetStatus} (${seconds}s)`,
    () => waitForStatus(data.targetStatus),
  );
}
/**
 * Execute reserve now node
 */
export async function executeReserveNow(
  ctx: NodeRunContext,
  data: ReserveNowNodeData,
): Promise<void> {
  if (!ctx.callbacks.onReserveNow) return;

  // Generate reservation ID if not provided
  const reservationId = data.reservationId || ctx.rng.int(0, 1000000);

  await ctx.callbacks.onReserveNow(
    data.expiryMinutes,
    data.idTag,
    data.parentIdTag,
    reservationId,
  );
}
/**
 * Execute cancel reservation node
 */
export async function executeCancelReservation(
  ctx: NodeRunContext,
  data: CancelReservationNodeData,
): Promise<void> {
  if (!ctx.callbacks.onCancelReservation) return;

  await ctx.callbacks.onCancelReservation(data.reservationId);
}
/**
 * Execute reservation trigger node (wait for ReserveNow request)
 */
export async function executeReservationTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: ReservationTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForReservation = ctx.callbacks.onWaitForReservation;
  if (!waitForReservation) return;

  await runTriggerWait(
    ctx,
    nodeId,
    flow,
    data.timeout,
    (seconds) => `Timeout waiting for reservation (${seconds}s)`,
    () => waitForReservation(),
  );
}
/**
 * Issue #110: park the scenario until the CSMS sends `data.action`.
 * Mirror of executeRemoteStopTrigger; the CP core handler still runs,
 * we only synchronize on arrival and log the payload.
 */
export async function executeCsmsCallTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: CsmsCallTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForCsmsCall = ctx.callbacks.onWaitForCsmsCall;
  if (!waitForCsmsCall) return;
  if (
    data.payload !== undefined &&
    (typeof data.payload !== "object" ||
      data.payload === null ||
      Array.isArray(data.payload))
  ) {
    throw new Error(
      `csmsCallTrigger(${data.action}): payload condition must be a JSON object`,
    );
  }
  const replace = data.behavior === "replace";
  const result = await runTriggerWait(
    ctx,
    nodeId,
    flow,
    data.timeout,
    (seconds) =>
      `Timeout waiting for CSMS call ${data.action}${
        data.payload ? " matching payload" : ""
      } (${seconds}s)`,
    () =>
      waitForCsmsCall(
        data.action,
        data.payload,
        replace
          ? {
              scenarioId: ctx.scenario.id,
              nodeId,
              ...(data.onBusy ? { onBusy: data.onBusy } : {}),
            }
          : undefined,
      ),
  );
  if (result) {
    ctx.callbacks.log?.(`CSMS call received: ${result.value.action}`, "info");
    if (replace) {
      if (!result.value.exchange) {
        throw new Error(
          `csmsCallTrigger(${data.action}): behavior "replace" is not available on this station`,
        );
      }
      // The branch owns the CALL from here on.
      flow.exchange = result.value.exchange;
      flow.answered = false;
      // A remote start the scenario owns is still a remote start: the next
      // Start Transaction carries the tag the CSMS sent, as after a
      // `remoteStartTrigger`, not the station's own default.
      captureOwnedRemoteStart(ctx, result.value.action, result.value.payload);
    }
  }
}
/** Remembers the tag (and 2.x remote start id / token type) of an owned
 *  RemoteStartTransaction (1.6) or RequestStartTransaction (2.x) for the next
 *  Start Transaction node. Other actions, or a payload without a tag, leave the
 *  capture alone. */
function captureOwnedRemoteStart(
  ctx: NodeRunContext,
  action: string,
  payload: unknown,
): void {
  if (typeof payload !== "object" || payload === null) return;
  const body = payload as Record<string, unknown>;
  if (action === "RemoteStartTransaction") {
    if (typeof body.idTag !== "string" || body.idTag === "") return;
    ctx.remoteStartTagId = body.idTag;
    ctx.remoteStartOptions = { triggerReason: "RemoteStart" };
  } else if (action === "RequestStartTransaction") {
    const token = body.idToken;
    if (typeof token !== "object" || token === null) return;
    const { idToken, type } = token as Record<string, unknown>;
    if (typeof idToken !== "string" || idToken === "") return;
    ctx.remoteStartTagId = idToken;
    ctx.remoteStartOptions = {
      triggerReason: "RemoteStart",
      ...(typeof body.remoteStartId === "number"
        ? { remoteStartId: body.remoteStartId }
        : {}),
      ...(typeof type === "string"
        ? { idTokenType: type as IdTokenTypeName }
        : {}),
    };
  }
}
/** Issue #240: park until the WebSocket reaches data.event. */
export async function executeConnectionTrigger(
  ctx: NodeRunContext,
  nodeId: string,
  data: ConnectionTriggerNodeData,
  flow: Flow,
): Promise<void> {
  const waitForConnection = ctx.callbacks.onWaitForConnection;
  if (!waitForConnection) return;
  const result = await runTriggerWait(
    ctx,
    nodeId,
    flow,
    data.timeout,
    (seconds) => `Timeout waiting for ${data.event} (${seconds}s)`,
    () => waitForConnection(data.event),
  );
  if (result) ctx.callbacks.log?.(`Connection event: ${data.event}`, "info");
}
