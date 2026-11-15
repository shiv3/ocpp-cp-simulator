import type {
  ConnectorPlugNodeData,
  DelayNodeData,
  NotificationNodeData,
  StartTransactionOptions,
  StatusChangeNodeData,
  TransactionNodeData,
} from "../ScenarioTypes";
import { DEFAULT_ID_TAG } from "../../../domain/auth/IdTagPool";
import type { BranchScope } from "../branchScope";
import type { NodeRunContext } from "./context";

/**
 * Execute status change node
 */
export async function executeStatusChange(
  ctx: NodeRunContext,
  data: StatusChangeNodeData,
): Promise<void> {
  if (ctx.callbacks.onStatusChange) {
    // Schema 1.11 (#618): the explicit override is passed only when set,
    // so a plain status change calls back exactly as before.
    if (data.allowInvalidTransition === true) {
      await ctx.callbacks.onStatusChange(data.status, {
        allowInvalidTransition: true,
      });
    } else {
      await ctx.callbacks.onStatusChange(data.status);
    }
  }
}
/**
 * Execute transaction node
 */
export async function executeTransaction(
  ctx: NodeRunContext,
  data: TransactionNodeData,
): Promise<void> {
  if (data.action === "start") {
    if (ctx.callbacks.onStartTransaction) {
      // Use the tagId captured from a preceding RemoteStartTrigger node if available
      // Precedence: a tag captured from a preceding RemoteStartTrigger, then
      // the node's own literal, then the charge point's pool (#299), then
      // the historical default so a charge point without a pool is
      // unchanged.
      const tagId =
        ctx.remoteStartTagId ||
        data.tagId ||
        ctx.callbacks.onResolveIdTag?.() ||
        DEFAULT_ID_TAG;
      // #599: the node's own idTokenType rides in the options; without
      // one the callback is called exactly as before.
      const options: StartTransactionOptions | null = data.idTokenType
        ? { ...ctx.remoteStartOptions, idTokenType: data.idTokenType }
        : ctx.remoteStartOptions;
      ctx.remoteStartTagId = null;
      ctx.remoteStartOptions = null;
      const outcome = options
        ? await ctx.callbacks.onStartTransaction(
            tagId,
            data.batteryCapacityKwh,
            data.initialSoc,
            options,
          )
        : await ctx.callbacks.onStartTransaction(
            tagId,
            data.batteryCapacityKwh,
            data.initialSoc,
          );
      // Issue #181: a denied local-authorize gate is a LOGGED SKIP, not
      // an error — the scenario continues to its next node (e.g. plugout
      // / end) exactly like TC_023's Authorize-Invalid/Expired/Blocked
      // graphs expect. `outcome` is `void` for callback implementations
      // that don't report one, so only act on it when present.
      if (outcome && outcome.started === false) {
        ctx.callbacks.log?.(
          `Transaction start denied (${outcome.denialStatus ?? "refused"}); continuing scenario`,
          "warn",
        );
      }
    }
  } else if (data.action === "stop") {
    if (ctx.callbacks.onStopTransaction) {
      const reason = ctx.remoteStopReason ?? data.stopReason ?? undefined;
      const options = ctx.remoteStopOptions;
      ctx.remoteStopReason = null;
      ctx.remoteStopOptions = null;
      if (options) {
        await ctx.callbacks.onStopTransaction(reason, options);
      } else {
        await ctx.callbacks.onStopTransaction(reason);
      }
    }
  }
}
/**
 * Execute delay node with progress updates
 */
export async function executeDelay(
  ctx: NodeRunContext,
  nodeId: string,
  data: DelayNodeData,
  scope: BranchScope,
): Promise<void> {
  let seconds = data.delaySeconds;
  if (data.until !== undefined) {
    // Schema 1.6 (#654): not before an instant on the station's clock.
    const at =
      typeof data.until === "string"
        ? new Date(data.until).getTime()
        : Number.NaN;
    if (Number.isNaN(at)) {
      throw new Error(
        `delay: until must be an ISO-8601 date-time, got ${JSON.stringify(data.until)}`,
      );
    }
    seconds = Math.max(seconds, (at - ctx.clock.now()) / 1000);
  }
  if (data.jitterSeconds !== undefined) {
    const jitter = data.jitterSeconds;
    if (typeof jitter !== "number" || !Number.isFinite(jitter) || jitter < 0) {
      throw new Error(
        `delay: jitterSeconds must be a number of at least 0, got ${JSON.stringify(jitter)}`,
      );
    }
    // Whole milliseconds from the scenario's seeded stream, so one seed
    // gives one wait. A jitter of 0 draws nothing.
    if (jitter > 0) {
      seconds += ctx.rng.int(0, Math.round(jitter * 1000) + 1) / 1000;
    }
  }
  await ctx.waitWithProgress(nodeId, seconds, scope);
}
/**
 * Execute notification node
 */
export async function executeNotification(
  ctx: NodeRunContext,
  data: NotificationNodeData,
): Promise<void> {
  if (ctx.callbacks.onSendNotification) {
    await ctx.callbacks.onSendNotification(data.messageType, data.payload);
  }
}
/**
 * Execute connector plug node
 */
export async function executeConnectorPlug(
  ctx: NodeRunContext,
  data: ConnectorPlugNodeData,
): Promise<void> {
  if (ctx.callbacks.onConnectorPlug) {
    await ctx.callbacks.onConnectorPlug(data.action);
  }
}
