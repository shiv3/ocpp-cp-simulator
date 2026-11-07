import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { LogType } from "../../../shared/Logger";

/** Time between two statuses of the simulated update. */
const STEP_MS = 2000;

interface SignedUpdateFirmwareRequest {
  requestId: number;
  retries?: number | null;
  retryInterval?: number | null;
  firmware: { location?: string; retrieveDateTime: string };
}

/**
 * The default behavior of SignedUpdateFirmware.req (OCPP 1.6 Security
 * Whitepaper): the response is `Accepted` and goes out at once; once it
 * settled, the station walks Downloading → Downloaded → SignatureVerified →
 * Installing → Installed with SignedFirmwareStatusNotification, two seconds
 * apart from `retrieveDateTime`, carrying the request's `requestId` on every
 * notification. No signature is verified (there is no binary to fetch), so
 * `SignatureVerified` always fires. `retries` / `retryInterval` are logged,
 * not exercised. A train is separate from the plain UpdateFirmware train.
 */
export function signedFirmwareBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.signedFirmware",
    onCall: {
      SignedUpdateFirmware: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = request as SignedUpdateFirmwareRequest;
          const retrieveDate = new Date(req.firmware.retrieveDateTime);
          if (Number.isNaN(retrieveDate.getTime())) {
            cp.logger.warn(
              `SignedUpdateFirmware: invalid retrieveDateTime '${req.firmware.retrieveDateTime}', starting immediately`,
              LogType.OCPP,
            );
          }
          cp.logger.info(
            `SignedUpdateFirmware received: requestId=${req.requestId}, location=${String(req.firmware.location)}, retrieveDateTime=${req.firmware.retrieveDateTime}` +
              (req.retries != null ? `, retries=${req.retries}` : "") +
              (req.retryInterval != null
                ? `, retryInterval=${req.retryInterval}s`
                : ""),
            LogType.OCPP,
          );

          const startsAt = Number.isNaN(retrieveDate.getTime())
            ? ctx.now()
            : retrieveDate.getTime();
          return {
            response: { status: "Accepted" },
            after: async () => {
              if (ctx.state.inFlight === true) {
                cp.logger.warn(
                  "SignedUpdateFirmware: a previous simulated update is still in flight; ignoring",
                  LogType.OCPP,
                );
                return;
              }
              ctx.state.inFlight = true;
              try {
                await ctx.sleep(Math.max(0, startsAt - ctx.now()));
                for (const step of [
                  "Downloading",
                  "Downloaded",
                  "SignatureVerified",
                  "Installing",
                  "Installed",
                ]) {
                  ctx.notify.signedFirmwareStatus(step, req.requestId);
                  await ctx.sleep(STEP_MS);
                }
              } finally {
                ctx.state.inFlight = false;
              }
            },
          };
        },
      },
    },
  };
}
