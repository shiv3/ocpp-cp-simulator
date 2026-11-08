import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

interface Reset16Request {
  type: "Hard" | "Soft";
}

interface Reset2Request {
  type: string;
  evseId?: number;
}

/**
 * The default behavior of Reset.
 *
 * OCPP 1.6 (§5.14): the response is `Accepted`, and once it settled the
 * station stops every transaction in flight and resets: a Soft reset
 * boots again, a Hard reset reconnects. The work waits for the settlement so
 * Reset.conf is written before any StopTransaction.req.
 *
 * OCPP 2.x (B11, B12): `Rejected` for an unknown EVSE, `Scheduled` for an
 * `OnIdle` reset while a targeted EVSE has a running transaction (#597: once
 * settled, the reset is queued and the station boots when the last targeted
 * transaction ends), otherwise `Accepted`; once settled, transactions of the
 * targeted EVSEs are stopped, queued OnIdle resets are dropped and the
 * station boots again. 2.1 `ImmediateAndResume` (B13) is `Rejected` while a
 * targeted EVSE has a transaction: the station does not support transaction
 * resumption (B13.FR.01); with none it is an Immediate reset (B13.FR.02).
 */
export function resetBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.reset",
    onCall: {
      Reset: {
        mode: "replace",
        handle: (request) => {
          if (!isOcpp2Version(cp.ocppVersion)) {
            const { type } = request as Reset16Request;
            cp.logger.info(`Reset request received: ${type}`, LogType.OCPP);
            return {
              response: { status: "Accepted" },
              after: async () => {
                cp.applyRemoteReset(type);
              },
            };
          }

          const { type, evseId } = request as Reset2Request;
          const all = [...cp.connectors.values()];
          const targets =
            evseId === undefined
              ? all
              : all.filter((connector) => connector.id === evseId);
          if (evseId !== undefined && targets.length === 0) {
            return { response: { status: "Rejected" } };
          }
          // 2.1 B13.FR.01: without transaction resumption support (no
          // TxCtrlr.TxResumptionTimeout, so "0 or non-existent") an
          // ImmediateAndResume reset with ongoing transactions is Rejected;
          // B13.FR.02 keeps Accepted when none is ongoing.
          if (
            type === "ImmediateAndResume" &&
            targets.some((connector) => connector.hasRunningTransaction)
          ) {
            return { response: { status: "Rejected" } };
          }
          if (
            type === "OnIdle" &&
            targets.some((connector) => connector.hasRunningTransaction)
          ) {
            return {
              response: { status: "Scheduled" },
              after: async () => {
                cp.scheduleResetOnIdle(evseId);
              },
            };
          }
          return {
            response: { status: "Accepted" },
            after: async () => {
              cp.cancelPendingResetsOnIdle(evseId);
              for (const connector of targets) {
                if (connector.hasRunningTransaction) {
                  cp.stopTransaction(connector.id, "HardReset", {
                    triggerReason: "ResetCommand",
                  });
                }
              }
              cp.boot();
            },
          };
        },
      },
    },
  };
}
