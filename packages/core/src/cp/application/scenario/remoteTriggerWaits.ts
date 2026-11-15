// Scenario waits for a CSMS remote start / stop, split out of
// ScenarioRuntime.ts (#877).
import type { CancellableWait } from "./cancellable";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import type { IdTokenTypeName } from "../../domain/connector/Transaction";
import type { ScenarioExecutorCallbacks } from "./ScenarioTypes";
import { clockOf } from "../../shared/clock";

export const waitForRemoteStart = (
  chargePoint: ChargePoint,
  connector: Connector,
  log: NonNullable<ScenarioExecutorCallbacks["log"]>,
  runStartedAt: number,
): CancellableWait<{
  tagId: string;
  remoteStartId?: number;
  idTokenType?: IdTokenTypeName;
  groupIdToken?: string;
}> => {
  // §4.9 S3: fail-fast if the charge point cannot receive RemoteStartTransaction
  if (!chargePoint.canReceiveCsmsCall("RemoteStartTransaction")) {
    const version = chargePoint.ocppVersion;
    const versionDesc = chargePoint.isSoapChargePoint()
      ? version === "OCPP-1.5"
        ? "OCPP-1.5 SOAP"
        : "send-only SOAP"
      : version;
    const errorMsg =
      `RemoteStartTransaction trigger requires a transport that can receive CSMS-initiated calls; ` +
      `this charge point (${versionDesc}) cannot — the scenario would wait forever`;
    return {
      promise: Promise.reject(new Error(errorMsg)),
      cancel: () => {},
    };
  }

  // Register so the handler emits remoteStartReceived instead of starting a transaction
  chargePoint.registerScenarioHandler(connector.id);

  // Make the run_scenario / RemoteStartTransaction race visible: if this
  // exact call already arrived (during this run) and was handled OUTSIDE
  // the scenario before this trigger node could arm — see
  // RemoteStartTransactionHandler / handleRequestStartTransactionV201's
  // isScenarioHandled branches — it already started a real transaction
  // directly and will not be redelivered. Without this warning the node
  // just parks silently until its timeout (or forever), which is exactly
  // what made the original bypass take hours to trace.
  const missedAt = chargePoint.takeDefaultHandledRemoteStart(
    connector.id,
    runStartedAt,
  );
  if (missedAt !== null) {
    log(
      `RemoteStartTransaction arrived ${Math.max(0, clockOf(chargePoint).now() - missedAt)}ms ` +
        "before this node armed and was handled OUTSIDE this scenario (a " +
        "transaction was started directly). This node is now waiting for a " +
        "RemoteStartTransaction that will likely never come — probably a " +
        "race between run_scenario and the command that triggered this run.",
      "warn",
    );
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<{
    tagId: string;
    remoteStartId?: number;
    idTokenType?: IdTokenTypeName;
    groupIdToken?: string;
  }>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      chargePoint.events.off("remoteStartReceived", handler);
      chargePoint.events.off("disconnected", disconnectHandler);
      chargePoint.unregisterScenarioHandler(connector.id);
    };

    cleanupFn = cleanup;

    const handler = (data: {
      connectorId: number;
      tagId: string;
      remoteStartId?: number;
      idTokenType?: IdTokenTypeName;
      groupIdToken?: string;
    }) => {
      if (data.connectorId !== connector.id) return;
      cleanup();
      resolve({
        tagId: data.tagId,
        ...(data.remoteStartId !== undefined
          ? { remoteStartId: data.remoteStartId }
          : {}),
        ...(data.idTokenType !== undefined
          ? { idTokenType: data.idTokenType }
          : {}),
        ...(data.groupIdToken !== undefined
          ? { groupIdToken: data.groupIdToken }
          : {}),
      });
    };

    const disconnectHandler = () => {
      cleanup();
      reject(new Error("Disconnected while waiting for remote start"));
    };

    chargePoint.events.on("remoteStartReceived", handler);
    chargePoint.events.on("disconnected", disconnectHandler);
  });

  return {
    promise,
    cancel: () => cleanupFn?.(),
  };
};

/** Mirror of waitForRemoteStart, but for the CSMS-initiated stop side.
 *  Registers a scenario-stop handler on the CP so the default
 *  RemoteStopTransactionHandler defers, then waits for the emitted
 *  `remoteStopReceived` event. Resolves with the transactionId AND the
 *  OCPP §6.21 stop reason ("Remote" for the CSMS-initiated path) so the
 *  subsequent Transaction Stop node can pass it through to
 *  StopTransaction.req. Rejects on disconnect; the executor owns the
 *  timeout (#240). */
export const waitForRemoteStop = (
  chargePoint: ChargePoint,
  connector: Connector,
  log: NonNullable<ScenarioExecutorCallbacks["log"]>,
  runStartedAt: number,
): CancellableWait<{
  transactionId: number;
  reason: string;
  triggerReason: "RemoteStop";
}> => {
  // §4.9 S3: fail-fast if the charge point cannot receive RemoteStopTransaction
  if (!chargePoint.canReceiveCsmsCall("RemoteStopTransaction")) {
    const version = chargePoint.ocppVersion;
    const versionDesc = chargePoint.isSoapChargePoint()
      ? version === "OCPP-1.5"
        ? "OCPP-1.5 SOAP"
        : "send-only SOAP"
      : version;
    const errorMsg =
      `RemoteStopTransaction trigger requires a transport that can receive CSMS-initiated calls; ` +
      `this charge point (${versionDesc}) cannot — the scenario would wait forever`;
    return {
      promise: Promise.reject(new Error(errorMsg)),
      cancel: () => {},
    };
  }

  chargePoint.registerScenarioStopHandler(connector.id);

  // Mirror of waitForRemoteStart's bypass check, for the stop side.
  const missedAt = chargePoint.takeDefaultHandledRemoteStop(
    connector.id,
    runStartedAt,
  );
  if (missedAt !== null) {
    log(
      `RemoteStopTransaction arrived ${Math.max(0, clockOf(chargePoint).now() - missedAt)}ms ` +
        "before this node armed and was handled OUTSIDE this scenario (the " +
        "transaction was stopped directly). This node is now waiting for a " +
        "RemoteStopTransaction that will likely never come — probably a " +
        "race between run_scenario and the command that triggered this run.",
      "warn",
    );
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<{
    transactionId: number;
    reason: string;
    triggerReason: "RemoteStop";
  }>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      chargePoint.events.off("remoteStopReceived", handler);
      chargePoint.events.off("disconnected", disconnectHandler);
      chargePoint.unregisterScenarioStopHandler(connector.id);
    };

    cleanupFn = cleanup;

    const handler = (data: { connectorId: number; transactionId: number }) => {
      if (data.connectorId !== connector.id) return;
      cleanup();
      // §6.21: CSMS-initiated stop → reason="Remote". Hard-code here
      // since the request payload itself doesn't carry a reason field;
      // the handler is what knows the provenance.
      resolve({
        transactionId: data.transactionId,
        reason: "Remote",
        triggerReason: "RemoteStop",
      });
    };

    const disconnectHandler = () => {
      cleanup();
      reject(new Error("Disconnected while waiting for remote stop"));
    };

    chargePoint.events.on("remoteStopReceived", handler);
    chargePoint.events.on("disconnected", disconnectHandler);
  });

  return {
    promise,
    cancel: () => cleanupFn?.(),
  };
};
