import type {
  Behavior,
  BehaviorParams,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { checkFirmwareSigningCertificate } from "../../../domain/security/signingCertificate";
import { LogType } from "../../../shared/Logger";

/** The knobs of the simulated update; the defaults are the former constants. */
const PARAMS: BehaviorParams = {
  schema: {
    type: "object",
    properties: {
      stepMs: {
        type: "integer",
        minimum: 0,
        maximum: 3_600_000,
        title: "Step (ms)",
        description: "Time between two statuses of the update",
      },
    },
  },
  defaults: { stepMs: 2000 },
};

interface SignedUpdateFirmwareRequest {
  requestId: number;
  retries?: number | null;
  retryInterval?: number | null;
  firmware: {
    location?: string;
    retrieveDateTime: string;
    installDateTime?: string;
    signingCertificate?: unknown;
  };
}

/**
 * The default behavior of SignedUpdateFirmware.req (OCPP 1.6 Security
 * Whitepaper): the response is `Accepted` and goes out at once; once it
 * settled, the station walks Downloading → Downloaded → SignatureVerified →
 * Installing → Installed with SignedFirmwareStatusNotification, two seconds
 * apart from `retrieveDateTime`, carrying the request's `requestId` on every
 * notification, and ends with a `FirmwareUpdated` SecurityEventNotification
 * (L01.FR.33). The `signingCertificate` is validated before the request is
 * accepted (L01.FR.23): one that does not parse, is outside its validity
 * period or is not issued by an installed ManufacturerRootCertificate is
 * answered `InvalidCertificate` (L01.FR.24), no train runs, and an
 * `InvalidFirmwareSigningCertificate` SecurityEventNotification follows
 * (L01.FR.02). No signature is verified (there is no binary to fetch), so
 * `SignatureVerified` always fires. A request that arrives while a train runs
 * cancels it and is answered `AcceptedCanceled` (L01.FR.26): only the new
 * request's train goes on. A `retrieveDateTime` in the future is announced with
 * `DownloadScheduled` right after the answer (L01.FR.13), and the train starts
 * then; a future `installDateTime` is announced with `InstallScheduled` after
 * `SignatureVerified` (L01.FR.16) and `Installing` follows at that time
 * (L01.FR.17). A past or absent time keeps the plain train. `retries` / `retryInterval` are logged,
 * not exercised. A train is separate from the plain UpdateFirmware train.
 */
export function signedFirmwareBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.signedFirmware",
    params: PARAMS,
    onCall: {
      SignedUpdateFirmware: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = request as SignedUpdateFirmwareRequest;
          const check = checkFirmwareSigningCertificate(
            req.firmware.signingCertificate,
            cp.nowDate(),
            cp.certificateStore
              .listRootCertificates(["ManufacturerRootCertificate"])
              .map((root) => root.pem),
          );
          if (!check.ok) {
            cp.logger.warn(
              `SignedUpdateFirmware: InvalidCertificate (${check.problem}): ${check.detail}`,
              LogType.OCPP,
            );
            return {
              response: { status: "InvalidCertificate" },
              after: async () => {
                await cp
                  .sendSecurityEventNotification(
                    "InvalidFirmwareSigningCertificate",
                    check.detail,
                  )
                  .catch(() => undefined);
              },
            };
          }
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
          const installDate = new Date(
            req.firmware.installDateTime ?? Number.NaN,
          );
          const installAt = Number.isNaN(installDate.getTime())
            ? undefined
            : installDate.getTime();
          // L01.FR.26: a request while a train runs cancels it. Taking the
          // next run number is the cancellation: the old train notices at its
          // next step and sends nothing more.
          const cancelsRunning = ctx.state.inFlight === true;
          const run = Number(ctx.state.run ?? 0) + 1;
          ctx.state.run = run;
          if (cancelsRunning) {
            cp.logger.info(
              "SignedUpdateFirmware: cancelling the running update (L01.FR.26)",
              LogType.OCPP,
            );
          }
          return {
            response: {
              status: cancelsRunning ? "AcceptedCanceled" : "Accepted",
            },
            after: async () => {
              if (ctx.state.run !== run) return;
              ctx.state.inFlight = true;
              try {
                // L01.FR.13: a retrieveDateTime in the future is announced.
                if (startsAt > ctx.now()) {
                  ctx.notify.signedFirmwareStatus(
                    "DownloadScheduled",
                    req.requestId,
                  );
                }
                await ctx.sleep(Math.max(0, startsAt - ctx.now()));
                for (const step of [
                  "Downloading",
                  "Downloaded",
                  "SignatureVerified",
                  "Installing",
                  "Installed",
                ]) {
                  if (ctx.state.run !== run) return;
                  if (
                    step === "Installing" &&
                    installAt !== undefined &&
                    installAt > ctx.now()
                  ) {
                    // L01.FR.16/17: a future installDateTime is announced
                    // once the signature is verified, and the install waits
                    // for it.
                    ctx.notify.signedFirmwareStatus(
                      "InstallScheduled",
                      req.requestId,
                    );
                    await ctx.sleep(installAt - ctx.now());
                    if (ctx.state.run !== run) return;
                  }
                  ctx.notify.signedFirmwareStatus(step, req.requestId);
                  if (step === "Installed") {
                    // L01.FR.33: right after Installed.
                    await cp
                      .sendSecurityEventNotification("FirmwareUpdated")
                      .catch(() => undefined);
                  }
                  await ctx.sleep(ctx.params.stepMs as number);
                }
              } finally {
                if (ctx.state.run === run) ctx.state.inFlight = false;
              }
            },
          };
        },
      },
    },
  };
}
