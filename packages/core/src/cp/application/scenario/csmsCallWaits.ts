// Scenario waits for an incoming CSMS CALL, split out of ScenarioRuntime.ts
// (#877).
import type { CancellableWait } from "./cancellable";
import { csmsActionMatches } from "../../domain/types/csmsActionNames";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import { LogType } from "../../shared/Logger";
import { deepPartialMatch } from "../../../scenario/deepPartialMatch";
import type {
  CallResponseSpec,
  ScenarioCallExchange,
  ScenarioReplaceRequest,
} from "./ScenarioTypes";
import type { HeldExchange, RuleOwner } from "../behavior/BehaviorRegistry";
import { cannedResponse, responseProblems } from "../engine/responseValidation";

/** Issue #110: generic wait for any incoming CSMS CALL by action name.
 *  Subscribes to the `incomingCallReceived` event emitted by the message
 *  dispatch layer. Unlike waitForRemoteStop this does NOT register any
 *  scenario handler — the CP core handler for the action still runs. */
export const waitForCsmsCall = (
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
  chargePoint: ChargePoint,
  action: string,
): import("@ocpp-cp-simulator/contracts/behavior").CallAnswer | undefined => {
  if (!spec) return undefined;
  if (spec.kind === "accepted" || spec.kind === "rejected") {
    // Schema 1.6: the version-neutral answer of the CALL's own action.
    return {
      response: cannedResponse(action, chargePoint.ocppVersion, spec.kind),
    };
  }
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
    // Schema 1.6: the answer is the action's own, for this station's version.
    const canned =
      spec.kind === "accepted" || spec.kind === "rejected"
        ? cannedResponse(exchange.action, chargePoint.ocppVersion, spec.kind)
        : undefined;
    const response = canned ?? spec.payload ?? {};
    if (!spec.skipValidation && canned === undefined) {
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
export const waitForCsmsCallReplacing = (
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
  const busy = busyAnswerOf(replace.onBusy, chargePoint, action);

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
