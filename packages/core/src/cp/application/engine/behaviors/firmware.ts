import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

/** Time between two statuses of the simulated update. */
const STEP_MS = 2000;

interface UpdateFirmwareRequest {
  location?: string;
  retrieveDate?: string;
  retries?: number | null;
  retryInterval?: number | null;
  requestId?: number;
}

/**
 * The default behavior of UpdateFirmware.
 *
 * OCPP 1.6 (§4.5, §6.19): the response is empty and goes out at once; once it
 * settled, the station walks Downloading → Downloaded → Installing → Installed
 * with FirmwareStatusNotification, two seconds apart, starting at
 * `retrieveDate`. The simulator has no binary to fetch, so the happy path is
 * the default; the failure paths are armed with the one-shot
 * `SimulatedFirmwareUpdateFailure` configuration key (cert 1.6 Firmware
 * TC_044_2 / TC_044_3): `DownloadFailed` diverts at the Downloaded step,
 * `InstallationFailed` at the Installed step. A second UpdateFirmware while a
 * train is running is ignored.
 *
 * OCPP 2.x (L01): the request is accepted and its `requestId` remembered for
 * the FirmwareStatusNotification reports the control plane drives; the station
 * reports nothing on its own. A user behavior can opt in to a train.
 */
export function firmwareBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.firmware",
    onCall: {
      UpdateFirmware: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = (request ?? {}) as UpdateFirmwareRequest;
          if (isOcpp2Version(cp.ocppVersion)) {
            if (typeof req.requestId === "number") {
              cp.noteFirmwareRequest(req.requestId);
            }
            return { response: { status: "Accepted" } };
          }

          const retrieveDate = new Date(req.retrieveDate ?? Number.NaN);
          if (Number.isNaN(retrieveDate.getTime())) {
            cp.logger.warn(
              `UpdateFirmware: invalid retrieveDate '${String(req.retrieveDate)}', starting immediately`,
              LogType.OCPP,
            );
          }
          cp.logger.info(
            `UpdateFirmware received: location=${String(req.location)}, retrieveDate=${String(req.retrieveDate)}` +
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
            response: {},
            after: async () => {
              if (ctx.state.inFlight === true) {
                cp.logger.warn(
                  "UpdateFirmware: a previous simulated update is still in flight; ignoring",
                  LogType.OCPP,
                );
                return;
              }
              ctx.state.inFlight = true;
              try {
                const failureMode = cp.configuration.getString(
                  "SimulatedFirmwareUpdateFailure",
                );
                // One-shot: the next UpdateFirmware runs the happy path
                // unless the key is armed again.
                if (failureMode) {
                  cp.configuration.applyChange(
                    "SimulatedFirmwareUpdateFailure",
                    "",
                  );
                }
                await ctx.sleep(Math.max(0, startsAt - ctx.now()));
                for (const step of [
                  "Downloading",
                  "Downloaded",
                  "Installing",
                  "Installed",
                ]) {
                  if (
                    step === "Downloaded" &&
                    failureMode === "DownloadFailed"
                  ) {
                    ctx.notify.firmwareStatus("DownloadFailed");
                    return;
                  }
                  if (
                    step === "Installed" &&
                    failureMode === "InstallationFailed"
                  ) {
                    ctx.notify.firmwareStatus("InstallationFailed");
                    return;
                  }
                  ctx.notify.firmwareStatus(step);
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
