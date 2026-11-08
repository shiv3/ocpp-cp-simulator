import type {
  Behavior,
  BehaviorParams,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

/**
 * The knob of UnlockConnector. `configured` is what the behavior always did:
 * answer the connector's `unlockResponse`, which the `unlockOutcome` scenario
 * node sets. Any other value answers that status for every connector,
 * whatever the connector holds.
 */
const PARAMS: BehaviorParams = {
  schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["configured", "Unlocked", "UnlockFailed", "NotSupported"],
        title: "Outcome",
        description:
          "The status to answer when the CALL gets that far; configured keeps the connector's own (set by the unlockOutcome node). OCPP 2.x has no NotSupported: it answers UnlockFailed",
      },
    },
  },
  defaults: { outcome: "configured" },
};

/**
 * The default behavior of UnlockConnector.
 *
 * OCPP 1.6 (§5.17, §7.46): an unknown connector answers `NotSupported`
 * (errata 3.87); a transaction in flight is stopped first with reason
 * `UnlockCommand`; then the connector's configured `unlockResponse` is
 * returned (`Unlocked` by default, which a scenario can flip to
 * `UnlockFailed` or `NotSupported`).
 *
 * OCPP 2.x (F05): an unknown connector answers `UnknownConnector`, an ongoing
 * authorized transaction `OngoingAuthorizedTransaction` (it is neither
 * unlocked nor stopped), otherwise `Unlocked` or `UnlockFailed` after the
 * connector's configured response.
 */
export function unlockBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.unlock",
    params: PARAMS,
    onCall: {
      UnlockConnector: {
        mode: "replace",
        handle: (request, ctx) => {
          const outcome = ctx.params.outcome as string;
          if (isOcpp2Version(cp.ocppVersion)) {
            const connector = cp.getConnector(
              (request as { evseId: number }).evseId,
            );
            if (!connector) return { response: { status: "UnknownConnector" } };
            if (connector.transaction) {
              return {
                response: { status: "OngoingAuthorizedTransaction" },
              };
            }
            const wanted =
              outcome === "configured" ? connector.unlockResponse : outcome;
            return {
              response: {
                status: wanted === "Unlocked" ? "Unlocked" : "UnlockFailed",
              },
            };
          }

          const { connectorId } = request as { connectorId: number };
          const connector = cp.getConnector(connectorId);
          if (!connector) {
            cp.logger.warn(
              `UnlockConnector: unknown connectorId=${connectorId}`,
              LogType.OCPP,
            );
            return { response: { status: "NotSupported" } };
          }
          if (connector.transaction) {
            cp.logger.info(
              `UnlockConnector: stopping in-flight transaction on connector ${connectorId}`,
              LogType.OCPP,
            );
            cp.stopTransaction(connector, "UnlockCommand");
          }
          const status =
            outcome === "configured" ? connector.unlockResponse : outcome;
          cp.logger.info(
            `UnlockConnector connector=${connectorId} → ${status}`,
            LogType.OCPP,
          );
          return { response: { status } };
        },
      },
    },
  };
}
