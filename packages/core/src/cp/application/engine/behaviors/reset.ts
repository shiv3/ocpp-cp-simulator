import type { Behavior, BehaviorParams } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

/** The knob of Reset; the default adds no wait. */
const PARAMS: BehaviorParams = {
  schema: {
    type: "object",
    properties: {
      delayMs: {
        type: "integer",
        minimum: 0,
        maximum: 3_600_000,
        title: "Delay (ms)",
        description:
          "Wait this long after the answer settled before the reset takes effect (transactions stopped, then the boot)",
      },
    },
  },
  defaults: { delayMs: 0 },
};

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
 * targeted EVSEs are stopped (unless `ImmediateAndResume`, which keeps them),
 * queued OnIdle resets are dropped and the station boots again.
 */
export function resetBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.reset",
    params: PARAMS,
    onCall: {
      Reset: {
        mode: "replace",
        handle: (request, ctx) => {
          // A wait of 0 adds no turn (not even an `await`): the work runs in
          // the turn it always did.
          const delayMs = ctx.params.delayMs as number;
          if (!isOcpp2Version(cp.ocppVersion)) {
            const { type } = request as Reset16Request;
            cp.logger.info(`Reset request received: ${type}`, LogType.OCPP);
            return {
              response: { status: "Accepted" },
              after: async () => {
                if (delayMs > 0) await ctx.sleep(delayMs);
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
              if (delayMs > 0) await ctx.sleep(delayMs);
              if (type !== "ImmediateAndResume") {
                cp.cancelPendingResetsOnIdle(evseId);
                for (const connector of targets) {
                  if (connector.hasRunningTransaction) {
                    cp.stopTransaction(connector.id, "HardReset", {
                      triggerReason: "ResetCommand",
                    });
                  }
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
