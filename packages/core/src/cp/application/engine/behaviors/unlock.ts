import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

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
    onCall: {
      UnlockConnector: {
        mode: "replace",
        handle: (request) => {
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
            return {
              response: {
                status:
                  connector.unlockResponse === "Unlocked"
                    ? "Unlocked"
                    : "UnlockFailed",
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
          cp.logger.info(
            `UnlockConnector connector=${connectorId} → ${connector.unlockResponse}`,
            LogType.OCPP,
          );
          return { response: { status: connector.unlockResponse } };
        },
      },
    },
  };
}
