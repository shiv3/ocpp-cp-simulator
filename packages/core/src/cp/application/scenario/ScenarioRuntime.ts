import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import { cancellablePromise } from "./cancellable";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import { OCPPStatus, ReservationStatus } from "../../domain/types/OcppTypes";
import { LogType } from "../../shared/Logger";
import type {
  ScenarioExecutionContext,
  ScenarioExecutorCallbacks,
  ScenarioWaitIntervention,
} from "./ScenarioTypes";
import type { RuleOwner } from "../behavior/BehaviorRegistry";
import { clockOf } from "../../shared/clock";
import { rngOf } from "../../shared/rng";
import { waitForRemoteStart, waitForRemoteStop } from "./remoteTriggerWaits";
import { waitForCsmsCall, waitForCsmsCallReplacing } from "./csmsCallWaits";
import {
  waitForStatus,
  waitForConnection,
  waitForReservation,
  waitForMeterValue,
} from "./stateWaits";

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
    onStatusChange: async (status, options) => {
      if (options) {
        chargePoint.updateConnectorStatus(connector.id, status, options);
      } else {
        chargePoint.updateConnectorStatus(connector.id, status);
      }
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
    // #453: the node drives the connector's EV and cable model, the same
    // operations as the control plane. A plug-in moves an idle Available
    // connector to Preparing; a plug-out is an EV-side disconnect, which
    // StopTransactionOnEVSideDisconnect turns into a stop or a suspension
    // when a transaction runs (#488) and otherwise returns a Preparing or
    // Finishing connector to Available.
    onConnectorPlug: async (action) => {
      if (action === "plugin") {
        chargePoint.evPlugIn(connector.id);
      } else {
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
    onUseBehavior: (behaviorId, nodeId, options) => {
      const disable = options?.mode === "disable";
      const owner: RuleOwner = {
        kind: "scenario",
        scenarioId: `${disable ? "disable" : "use"}:${behaviorId}`,
        connectorId: connector.id,
        nodeId,
      };
      if (disable) {
        chargePoint.engine.disableBehavior(behaviorId, owner);
      } else {
        chargePoint.engine.activateBehavior(
          behaviorId,
          owner,
          options?.params as JsonObject | undefined,
        );
      }
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
      chargePoint.configuration.applyChange(key, value, { operator: true });
    },
    onSendOcppCall: (request) => chargePoint.sendOcppCall(request),
    onNotify: (kind, status, requestId) => {
      const engineKind =
        kind === "firmwareStatus"
          ? "firmware"
          : kind === "signedFirmwareStatus"
            ? "signedFirmware"
            : kind === "logStatus"
              ? "log"
              : "diagnostics";
      chargePoint.engine.notifyStatus(engineKind, status, requestId);
    },
    onReadStation: (root) =>
      root === "charger"
        ? chargePoint.engine.snapshotCharger()
        : chargePoint.engine.snapshotConnector(connector.id),
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
