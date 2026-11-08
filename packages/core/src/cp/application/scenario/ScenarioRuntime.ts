import { cancellablePromise, type CancellableWait } from "./cancellable";
import { csmsActionMatches } from "../../domain/types/csmsActionNames";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import type { IdTokenTypeName } from "../../domain/connector/Transaction";
import { OCPPStatus, ReservationStatus } from "../../domain/types/OcppTypes";
import { LogType } from "../../shared/Logger";
import { deepPartialMatch } from "../../../scenario/deepPartialMatch";
import type {
  CallResponseSpec,
  ScenarioCallExchange,
  ScenarioExecutionContext,
  ScenarioExecutorCallbacks,
  ScenarioReplaceRequest,
  ScenarioWaitIntervention,
} from "./ScenarioTypes";
import type { HeldExchange, RuleOwner } from "../behavior/BehaviorRegistry";
import { responseProblems } from "../engine/responseValidation";
import { clockOf } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { rngOf } from "../../shared/rng";

export interface ScenarioRuntimeHooks {
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void;
  onError?: (error: Error) => void;
  /** #240: an operator extended, retried or continued a parked wait. */
  onWaitIntervention?: (intervention: ScenarioWaitIntervention) => void;
  /**
   * Fired the moment this run has *actually* applied its EV settings to the
   * connector — after `applyEvSettingsOverride` returns, never before, and
   * never at all if it throws (#314).
   *
   * A run's owner of the connector's EV settings override is written here and
   * nowhere else, because this is the only point at which a claim exists. A
   * definition that merely *declares* `evSettings` has claimed nothing: it may
   * be installed under an id whose run never starts. See
   * `shouldReleaseEvSettingsOverride` in the CLI service, which is the only
   * consumer today.
   */
  onEvSettingsApplied?: () => void;
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
}

interface ScenarioRuntimeParams {
  chargePoint: ChargePoint;
  connector: Connector;
  hooks?: ScenarioRuntimeHooks;
}

/**
 * Scenario log lines are prefixed with the bound connector so a CP running the
 * same scenario on every connector stays readable. The executor's own prefix is
 * the scenario NAME, and a template instantiated per connector shares it, so a
 * disconnect used to emit N byte-identical "Scenario execution failed:
 * Disconnected while waiting for remote start" lines with nothing to say which
 * connector each came from.
 *
 * The prefix goes on before `hooks.log` too, so the CLI event stream and the
 * web console see the same disambiguated text as the CP log.
 */
const buildLogger = (
  chargePoint: ChargePoint,
  connector: Connector,
  hooks?: ScenarioRuntimeHooks,
): NonNullable<ScenarioExecutorCallbacks["log"]> => {
  return (rawMessage, level = "info") => {
    const message = `[connector ${connector.id}] ${rawMessage}`;
    switch (level) {
      case "debug":
        chargePoint.logger.debug(message, LogType.SCENARIO);
        break;
      case "info":
        chargePoint.logger.info(message, LogType.SCENARIO);
        break;
      case "warn":
        chargePoint.logger.warn(message, LogType.SCENARIO);
        break;
      case "error":
        chargePoint.logger.error(message, LogType.SCENARIO);
        break;
    }
    hooks?.log?.(message, level);
  };
};

const waitForStatus = (
  connector: Connector,
  targetStatus: OCPPStatus,
): CancellableWait<void> => {
  if (connector.status === targetStatus) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<void>((resolve) => {
    const cleanup = () => {
      connector.events.off("statusChange", statusChangeHandler);
    };
    cleanupFn = cleanup;

    const statusChangeHandler = (data: {
      status: OCPPStatus;
      previousStatus: OCPPStatus;
    }) => {
      if (data.status === targetStatus) {
        cleanup();
        resolve();
      }
    };

    connector.events.on("statusChange", statusChangeHandler);
  });

  return { promise, cancel: () => cleanupFn?.() };
};

const waitForRemoteStart = (
  chargePoint: ChargePoint,
  connector: Connector,
  log: NonNullable<ScenarioExecutorCallbacks["log"]>,
  runStartedAt: number,
): CancellableWait<{
  tagId: string;
  remoteStartId?: number;
  idTokenType?: IdTokenTypeName;
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
const waitForRemoteStop = (
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

/** Issue #110: generic wait for any incoming CSMS CALL by action name.
 *  Subscribes to the `incomingCallReceived` event emitted by the message
 *  dispatch layer. Unlike waitForRemoteStop this does NOT register any
 *  scenario handler — the CP core handler for the action still runs. */
const waitForCsmsCall = (
  chargePoint: ChargePoint,
  action: string,
  payload?: Record<string, unknown>,
): CancellableWait<{ action: string; payload: unknown }> => {
  // Fail-fast if this transport can never receive CSMS-initiated calls.
  if (!chargePoint.canReceiveCsmsCall(action)) {
    const errorMsg =
      `csmsCallTrigger(${action}) requires a transport that can receive ` +
      `CSMS-initiated calls; this charge point cannot — the scenario ` +
      `would wait forever`;
    return {
      promise: Promise.reject(new Error(errorMsg)),
      cancel: () => {},
    };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<{ action: string; payload: unknown }>(
    (resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        chargePoint.events.off("incomingCallReceived", handler);
        chargePoint.events.off("disconnected", disconnectHandler);
      };

      cleanupFn = cleanup;

      const handler = (data: { action: string; payload: unknown }) => {
        // #349: the node may spell the action in either version's vocabulary.
        if (!csmsActionMatches(action, data.action, chargePoint.ocppVersion)) {
          return;
        }
        // #240: a right-action frame whose payload doesn't match the
        // condition is NOT consumed — keep listening.
        if (payload && !deepPartialMatch(payload, data.payload)) return;
        cleanup();
        resolve(data);
      };

      const disconnectHandler = () => {
        cleanup();
        reject(new Error(`Disconnected while waiting for CSMS call ${action}`));
      };

      chargePoint.events.on("incomingCallReceived", handler);
      chargePoint.events.on("disconnected", disconnectHandler);
    },
  );

  return {
    promise,
    cancel: () => cleanupFn?.(),
  };
};

/** The registry's `onBusy` answer for a scenario's `onBusy` spec. */
const busyAnswerOf = (
  spec: CallResponseSpec | undefined,
): import("@ocpp-cp-sim/contracts/behavior").CallAnswer | undefined => {
  if (!spec) return undefined;
  if (spec.kind === "none") return { noResponse: true };
  if (spec.kind === "error") {
    return {
      error: {
        code: spec.errorCode ?? "GenericError",
        description: spec.errorDescription ?? "",
      },
    };
  }
  return { response: spec.payload ?? {} };
};

/** The CALL a scenario run owns, as the executor sees it (schema 1.5). */
const scenarioExchangeOf = (
  chargePoint: ChargePoint,
  exchange: HeldExchange,
  payload: unknown,
): ScenarioCallExchange => ({
  action: exchange.action,
  messageId: exchange.messageId,
  payload,
  answer: async (spec) => {
    if (spec.kind === "none") {
      if (exchange.state === "abandoned") {
        return { delivered: false, reason: "stale" };
      }
      void exchange.suppress();
      return { delivered: true };
    }
    if (spec.kind === "error") {
      return exchange.respondError(
        spec.errorCode ?? "GenericError",
        spec.errorDescription ?? "",
      );
    }
    const response = spec.payload ?? {};
    if (!spec.skipValidation) {
      const problems = responseProblems(
        exchange.action,
        chargePoint.ocppVersion,
        response,
      );
      if (problems.length > 0) {
        throw new Error(
          `callResponse: the ${exchange.action} response breaks its schema: ${problems.join("; ")} (set skipValidation to send it anyway)`,
        );
      }
    }
    return exchange.respond(response);
  },
});

/**
 * Schema 1.5 (#566): a `csmsCallTrigger` with `behavior: "replace"` arms a
 * rule with the station's behavior registry and waits for the CALL it takes
 * over. The rule stays until the CALL it served is answered (or the wait is
 * withdrawn, or the run ends); a second matching CALL meanwhile gets
 * `onBusy`. SOAP stations have no registry in front of their handlers, so the
 * wait fails here instead of falling back to the default behavior.
 */
const waitForCsmsCallReplacing = (
  chargePoint: ChargePoint,
  connector: Connector,
  action: string,
  payload: Record<string, unknown> | undefined,
  replace: ScenarioReplaceRequest,
  armedOwners: Map<string, RuleOwner>,
): CancellableWait<{
  action: string;
  payload: unknown;
  exchange: ScenarioCallExchange;
}> => {
  const fail = (message: string) => ({
    promise: Promise.reject(new Error(message)),
    cancel: () => {},
  });
  if (chargePoint.isSoapChargePoint()) {
    return fail(
      `csmsCallTrigger(${action}): behavior "replace" needs an OCPP-J station; ${chargePoint.ocppVersion} is SOAP`,
    );
  }
  if (!chargePoint.canReceiveCsmsCall(action)) {
    return fail(
      `csmsCallTrigger(${action}) requires a transport that can receive CSMS-initiated calls; this charge point cannot — the scenario would wait forever`,
    );
  }

  const owner: RuleOwner = {
    kind: "scenario",
    scenarioId: replace.scenarioId,
    connectorId: connector.id,
    nodeId: replace.nodeId,
  };
  const ownerKey = `${owner.scenarioId}:${owner.connectorId}:${owner.nodeId}`;
  // A loop reaches the node again: what the last pass armed ends first.
  if (armedOwners.has(ownerKey)) {
    for (const stale of chargePoint.behaviors.release(
      (o) =>
        o.kind === "scenario" &&
        `${o.scenarioId}:${o.connectorId}:${o.nodeId}` === ownerKey,
    )) {
      chargePoint.logger.warn(
        `${stale.action}: the scenario armed this node again before answering the previous call; answering InternalError`,
        LogType.OCPP,
      );
      stale.replyError(
        "InternalError",
        "The scenario moved on without answering this call",
      );
    }
  }
  armedOwners.set(ownerKey, owner);

  let unregister: (() => void) | null = null;
  let disconnectOff: (() => void) | null = null;
  let taken = false;
  const stop = () => {
    unregister?.();
    unregister = null;
    disconnectOff?.();
    disconnectOff = null;
  };
  const busy = busyAnswerOf(replace.onBusy);

  const promise = new Promise<{
    action: string;
    payload: unknown;
    exchange: ScenarioCallExchange;
  }>((resolve, reject) => {
    unregister = chargePoint.behaviors.register({
      owner,
      action,
      connectorId: connector.id,
      ...(payload ? { match: payload } : {}),
      mode: "replace",
      ...(busy ? { onBusy: busy } : {}),
      take: (call, exchange) => {
        // Served: the rule ends with this CALL's exchange, so the next CALL of
        // the action is the default behavior's again.
        taken = true;
        exchange.onClosed(stop);
        disconnectOff?.();
        disconnectOff = null;
        resolve({
          action: call.action,
          payload: call.payload,
          exchange: scenarioExchangeOf(chargePoint, exchange, call.payload),
        });
      },
    });
    disconnectOff = chargePoint.events.on("disconnected", () => {
      stop();
      reject(new Error(`Disconnected while waiting for CSMS call ${action}`));
    });
  });
  // Withdrawing a wait that was answered must not drop the rule: the CALL it
  // took is still the run's to answer, and a second one still gets `onBusy`.
  return {
    promise,
    cancel: () => {
      if (!taken) stop();
    },
  };
};

/** Issue #240: park until the WebSocket reaches `event`. Level-triggered —
 *  if the charge point is already in the target state, resolve immediately
 *  (same convention as waitForStatus / waitForReservation). Deliberately
 *  does NOT subscribe the reject-on-disconnect handler the other waits use:
 *  surviving the disconnected span is this wait's entire purpose. */
const waitForConnection = (
  chargePoint: ChargePoint,
  event: "connected" | "disconnected",
): CancellableWait<void> => {
  const inTargetState = () =>
    event === "connected"
      ? chargePoint.isWebSocketConnected
      : !chargePoint.isWebSocketConnected;

  if (inTargetState()) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<void>((resolve) => {
    let settled = false;

    const handler = () => {
      cleanup();
      resolve();
    };
    const off = chargePoint.events.on(event, handler);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      off();
    };
    cleanupFn = cleanup;
  });

  return { promise, cancel: () => cleanupFn?.() };
};

const waitForReservation = (
  chargePoint: ChargePoint,
  connector: Connector,
): CancellableWait<number> => {
  // §4.9 S3: fail-fast if the charge point cannot receive ReserveNow
  if (!chargePoint.canReceiveCsmsCall("ReserveNow")) {
    const version = chargePoint.ocppVersion;
    const versionDesc = chargePoint.isSoapChargePoint()
      ? version === "OCPP-1.5"
        ? "OCPP-1.5 SOAP"
        : "send-only SOAP"
      : version;
    const errorMsg =
      `Reservation trigger requires ReserveNow capability; ` +
      `this charge point (${versionDesc}) does not support it — the scenario would wait forever`;
    return { promise: Promise.reject(new Error(errorMsg)), cancel: () => {} };
  }

  const getReservationId = (): number | null => {
    const reservation =
      chargePoint.reservationManager.getReservationForConnector(connector.id);
    return reservation?.reservationId ?? null;
  };

  const existing = getReservationId();
  if (existing !== null) {
    return { promise: Promise.resolve(existing), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<number>((resolve) => {
    const cleanup = () => {
      connector.events.off("statusChange", statusChangeHandler);
      clockOf(chargePoint).clearInterval(pollingId);
    };
    cleanupFn = cleanup;

    const tryResolve = () => {
      const reservationId = getReservationId();
      if (reservationId !== null) {
        cleanup();
        resolve(reservationId);
      }
    };

    const statusChangeHandler = () => {
      tryResolve();
    };

    connector.events.on("statusChange", statusChangeHandler);

    const pollingId = clockOf(chargePoint).setInterval(tryResolve, 250);
  });

  return { promise, cancel: () => cleanupFn?.() };
};

const waitForMeterValue = (
  connector: Connector,
  targetValue: number,
  timeout: number | undefined,
  clock: SimClock,
): Promise<void> => {
  if (connector.meterValue >= targetValue || connector.transaction === null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId: TimerHandle | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      if (timeoutId) clock.clearTimeout(timeoutId);
      connector.events.off("meterValueChange", meterHandler);
      connector.events.off("transactionChange", transactionHandler);
      return true;
    };

    const meterHandler = (data: { meterValue: number }) => {
      if (data.meterValue >= targetValue) {
        if (cleanup()) resolve();
      }
    };

    const transactionHandler = (data: { transaction: unknown | null }) => {
      if (data.transaction === null || connector.transaction === null) {
        if (cleanup()) resolve();
      }
    };

    connector.events.on("meterValueChange", meterHandler);
    connector.events.on("transactionChange", transactionHandler);

    if (timeout && timeout > 0) {
      timeoutId = clock.setTimeout(() => {
        if (!cleanup()) return;
        reject(
          new Error(
            `Timeout waiting for meter value: ${targetValue} (${timeout}s)`,
          ),
        );
      }, timeout * 1000);
    }
  });
};

export const createScenarioExecutorCallbacks = (
  params: ScenarioRuntimeParams,
): ScenarioExecutorCallbacks => {
  const { chargePoint, connector, hooks } = params;
  const log = buildLogger(chargePoint, connector, hooks);
  // Anchors the "did a CSMS call bypass this scenario before it could arm?"
  // check in waitForRemoteStart/waitForRemoteStop: only a bypass that
  // happened during THIS run is worth warning about, not a stale one from
  // an earlier, unrelated run on the same connector.
  const runStartedAt = clockOf(chargePoint).now();
  // Schema 1.5 (#566): the rules this run armed, released when it ends.
  const armedOwners = new Map<string, RuleOwner>();

  const callbacks: ScenarioExecutorCallbacks & {
    onGetTransactionMeterStart: () => number | null;
  } = {
    onStatusChange: async (status) => {
      chargePoint.updateConnectorStatus(connector.id, status);
    },
    // #299: the executor has no connector of its own, so the connector it is
    // bound to is closed over here.
    onResolveIdTag: () => chargePoint.nextIdTag(connector.id),
    onStartTransaction: async (
      tagId,
      batteryCapacityKwh,
      initialSoc,
      options,
    ) => {
      // Issue #181: surface the domain outcome (denied vs started) instead
      // of discarding it — ScenarioExecutor.executeTransaction uses this to
      // log-and-continue on a denied local-authorize gate rather than
      // erroring the scenario.
      return chargePoint.startTransaction(
        tagId,
        connector.id,
        batteryCapacityKwh,
        initialSoc,
        options,
      );
    },
    onStopTransaction: async (reason, options) => {
      // The cast keeps stopTransaction's StopTransactionReason union
      // happy without dragging the enum import into the callbacks
      // declaration. ChargePoint.stopTransaction safely no-ops if there
      // is no active transaction, so we don't guard here either.
      chargePoint.stopTransaction(
        connector.id,
        reason as Parameters<typeof chargePoint.stopTransaction>[1],
        options,
      );
    },
    onSetMeterValue: (value) => {
      chargePoint.setMeterValue(connector.id, value);
    },
    onGetMeterValue: () => connector.meterValue,
    onGetTransactionMeterStart: () => connector.transaction?.meterStart ?? null,
    onSendMeterValue: async () => {
      chargePoint.sendMeterValue(connector.id);
    },
    onStartAutoMeterValue: (config) => {
      const extendedConfig = config as typeof config & {
        sendMessage?: boolean;
      };
      connector.startManualMeterStrategy({
        kind: "increment",
        intervalSeconds: config.intervalSeconds,
        incrementValue: config.incrementValue,
        maxTimeSeconds: config.maxTimeSeconds,
        maxValue: config.maxValue,
        sendMeterValues: extendedConfig.sendMessage !== false,
      });
    },
    onStopAutoMeterValue: () => {
      connector.stopAutoMeterValue();
    },
    onSetEVSettings: (settings) => {
      // Merge — only specified fields land on the connector. Routes through
      // the override path (#105) so this scenario's evSettings win over any
      // later Default EV Settings propagation until the scenario
      // stops/completes (see ScenarioManager/CLIChargePointService scenario
      // stop paths, which clear the override). Still emits
      // `evSettingsChange`, which surfaces to subscribers and (in remote
      // mode) the browser via the `connector_ev_settings` event.
      connector.applyEvSettingsOverride(settings);
      // Only now — the claim is the write, not the declaration, and a throw
      // above means this run never took the override (#314).
      hooks?.onEvSettingsApplied?.();
    },
    onGetEVSettings: () => connector.evSettings,
    onSendNotification: async (messageType, payload) => {
      switch (messageType) {
        case "Heartbeat":
          chargePoint.sendHeartbeat();
          break;
        case "StatusNotification":
          if (payload?.status) {
            chargePoint.updateConnectorStatus(
              connector.id,
              payload.status as OCPPStatus,
            );
          }
          break;
        default:
          console.warn(
            `Unhandled scenario notification type: ${messageType}`,
            payload,
          );
      }
    },
    // #488: a plug-out during a transaction is an EV-side disconnect, which
    // StopTransactionOnEVSideDisconnect turns into a stop or a suspension.
    // Without a transaction, and for a plug-in, the node stays a no-op: the
    // templates follow it with their own status nodes.
    onConnectorPlug: async (action) => {
      if (action === "plugout" && connector.hasRunningTransaction) {
        chargePoint.evDisconnected(connector.id);
      }
    },
    onDelay: async (seconds) => {
      await new Promise((resolve) =>
        clockOf(chargePoint).setTimeout(
          () => resolve(undefined),
          seconds * 1000,
        ),
      );
    },
    onWaitForRemoteStart: () => {
      return cancellablePromise(
        waitForRemoteStart(chargePoint, connector, log, runStartedAt),
      );
    },
    onWaitForRemoteStop: () => {
      return cancellablePromise(
        waitForRemoteStop(chargePoint, connector, log, runStartedAt),
      );
    },
    onWaitForCsmsCall: (action, payload, replace) => {
      if (replace) {
        return cancellablePromise(
          waitForCsmsCallReplacing(
            chargePoint,
            connector,
            action,
            payload,
            replace,
            armedOwners,
          ),
        );
      }
      return cancellablePromise(waitForCsmsCall(chargePoint, action, payload));
    },
    onUseBehavior: (behaviorId, nodeId) => {
      const owner: RuleOwner = {
        kind: "scenario",
        scenarioId: `use:${behaviorId}`,
        connectorId: connector.id,
        nodeId,
      };
      chargePoint.engine.activateBehavior(behaviorId, owner);
      armedOwners.set(`${behaviorId}:${connector.id}:${nodeId}`, owner);
    },
    onRunEnded: () => {
      if (armedOwners.size === 0) return;
      const mine = new Set(armedOwners.values());
      armedOwners.clear();
      const open = chargePoint.behaviors.release((owner) => mine.has(owner));
      chargePoint.engine.deactivateBehaviors((owner) => mine.has(owner));
      for (const exchange of open) {
        chargePoint.logger.warn(
          `${exchange.action}: the scenario ended before it answered this call; answering InternalError (use callResponse kind "none" to stay silent)`,
          LogType.OCPP,
        );
        exchange.replyError(
          "InternalError",
          "The scenario ended before it answered this call",
        );
      }
    },
    onWaitForConnection: (event) => {
      return cancellablePromise(waitForConnection(chargePoint, event));
    },
    onWaitForStatus: (targetStatus) =>
      cancellablePromise(waitForStatus(connector, targetStatus)),
    onWaitForMeterValue: async (targetValue, timeout) =>
      waitForMeterValue(connector, targetValue, timeout, clockOf(chargePoint)),
    onReserveNow: async (expiryMinutes, idTag, parentIdTag, reservationId) => {
      const expiryDate = new Date(
        clockOf(chargePoint).now() + expiryMinutes * 60 * 1000,
      );
      const resolvedId =
        reservationId ||
        rngOf(chargePoint, "scenario-reservation").int(0, 1000000);
      const status = chargePoint.reservationManager.createReservation(
        connector.id,
        expiryDate,
        idTag,
        parentIdTag,
        resolvedId,
      );
      if (status === ReservationStatus.Accepted) {
        chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Reserved);
      }
      return resolvedId;
    },
    onCancelReservation: async (reservationId) => {
      const reservation =
        chargePoint.reservationManager.getReservation(reservationId);
      const cancelled =
        chargePoint.reservationManager.cancelReservation(reservationId);
      if (cancelled && reservation) {
        // Free the connector the reservation was actually for — NOT the
        // scenario-bound connector — so cancelling a reservation on another
        // connector of a multi-connector CP doesn't clear the wrong one.
        const reserved = chargePoint.getConnector(reservation.connectorId);
        if (reserved && reserved.status === OCPPStatus.Reserved) {
          chargePoint.updateConnectorStatus(
            reservation.connectorId,
            OCPPStatus.Available,
          );
        }
      }
    },
    onWaitForReservation: () =>
      cancellablePromise(waitForReservation(chargePoint, connector)),
    onStateChange: hooks?.onStateChange,
    onNodeExecute: hooks?.onNodeExecute,
    onNodeProgress: hooks?.onNodeProgress,
    onError: hooks?.onError,
    onWaitIntervention: hooks?.onWaitIntervention,
    log,
    // §4.9: connectorId === -1 sentinel means "use the scenario's bound
    // connector"; otherwise the node specified an explicit target (0 for
    // CP main controller, >0 for another connector).
    onSendStatusNotification: (connectorId, status, opts) => {
      const targetId = connectorId === -1 ? connector.id : connectorId;
      chargePoint.sendStatusNotificationRaw(targetId, status, opts);
    },
    onSetUnlockOutcome: (outcome) => {
      connector.unlockResponse = outcome;
    },
    onArmResponseOverride: (action, status) => {
      chargePoint.armResponseOverride(action, status);
    },
    onClearResponseOverride: (action) => {
      chargePoint.clearResponseOverride(action);
    },
    onSetInboundPolicy: (action, policy, errorCode, errorDescription) => {
      if (policy === "callerror") {
        chargePoint.setInboundCallPolicy(action, {
          kind: "callerror",
          errorCode: errorCode ?? "NotImplemented",
          errorDescription: errorDescription ?? "",
        });
      } else if (policy === "ignore") {
        chargePoint.setInboundCallPolicy(action, { kind: "ignore" });
      }
    },
    onClearInboundPolicy: (action) => {
      chargePoint.clearInboundCallPolicy(action);
    },
    onSetCertificateQuirks: (quirks) => {
      chargePoint.setCertificateQuirks(quirks);
    },
    onClearCertificateQuirks: () => {
      chargePoint.clearCertificateQuirks();
    },
    onConfigSet: (key, value) => {
      chargePoint.configuration.applyChange(key, value);
    },
    onSendOcppCall: (request) => chargePoint.sendOcppCall(request),
    onSendDataTransfer: (vendorId, messageId, data) => {
      // The node is fire-and-forget by design: the transport logs the answer
      // (or the failure), and a scenario that needs to react to it would be
      // a different node. Swallow the rejection so it cannot surface as an
      // unhandled promise from inside a scenario step (#348).
      // `Promise.resolve` so a test double that returns nothing is fine too.
      void Promise.resolve(
        chargePoint.sendDataTransfer(vendorId, messageId, data),
      ).catch(() => undefined);
    },
  };

  return callbacks;
};
