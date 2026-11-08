import type {
  Behavior,
  BehaviorContext,
  BehaviorParams,
  JsonValue,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { checkFirmwareSigningCertificate } from "../../../domain/security/signingCertificate";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { LogType } from "../../../shared/Logger";

/**
 * The knobs of the 1.6 simulated update (docs/entities/default-behaviors.md).
 * The defaults are what the behavior did before it had params, so with nothing
 * selected the wire is unchanged.
 */
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
      failAt: {
        type: "string",
        enum: [
          "none",
          "DownloadFailed",
          "InstallationFailed",
          "InvalidSignature",
          "InstallVerificationFailed",
        ],
        title: "Fail at",
        description:
          "End every update with this failure instead of Installed. The one-shot SimulatedFirmwareUpdateFailure configuration key does the same for one update. InvalidSignature and InstallVerificationFailed exist on OCPP 2.x only and are ignored, with a warning, on 1.6; InvalidSignature fails the signature check even when the request carries no signature",
      },
      startAt: {
        type: "string",
        enum: ["retrieveDate", "now"],
        title: "Start at",
        description:
          "Wait for the request's retrieveDate, or start as soon as the answer settled. now is deliberately not conformant: it retrieves before retrieveDate (OCPP 1.6 §5.16, §6.55 / errata 3.63); use it to test CSMS handling",
      },
      train: {
        type: "boolean",
        title: "Status train (OCPP 2.x)",
        description:
          "OCPP 2.x only: walk the status train with the request's requestId (Downloading, Downloaded, SignatureVerified or InvalidSignature when a signature is present, Installing, Installed) instead of only acknowledging. A second request replaces a train in progress and is answered AcceptedCanceled (L01.FR.24). Off: acknowledge only. OCPP 1.6 always walks its train",
      },
      waitForTransactions: {
        type: "boolean",
        title: "Wait for transactions",
        description:
          "Hold the installation until no transaction is running on any connector (OCPP 1.6 §5.19; 2.x L01.FR.06)",
      },
      connectorsUnavailable: {
        type: "boolean",
        title: "Connectors unavailable",
        description:
          "Set idle connectors Unavailable from the wait for transactions until the update ends, and any connector that becomes idle meanwhile (OCPP 1.6 §5.19; 2.x L01.FR.07). The change is not persisted and is undone when the update ends",
      },
      reboot: {
        type: "string",
        enum: ["none", "afterInstalled", "beforeInstalled"],
        title: "Reboot",
        description:
          "none: no reboot. beforeInstalled: send BootNotification after Installing and report Installed once the CSMS accepted it (OCPP 1.6 §5.19 automatic reboot; 2.x L01.FR.32 a, with InstallRebooting). afterInstalled: report Installed, then send BootNotification (L01.FR.32 b)",
      },
      jitterMs: {
        type: "integer",
        minimum: 0,
        maximum: 3_600_000,
        title: "Jitter (ms)",
        description:
          "Add a seeded random 0..jitterMs to every step: the same seed gives the same timing. 0 draws nothing",
      },
    },
  },
  defaults: {
    stepMs: 2000,
    failAt: "none",
    startAt: "retrieveDate",
    train: false,
    waitForTransactions: false,
    connectorsUnavailable: false,
    reboot: "none",
    jitterMs: 0,
  },
};

interface UpdateFirmwareRequest {
  location?: string;
  retrieveDate?: string;
  retries?: number | null;
  retryInterval?: number | null;
  requestId?: number;
  /** OCPP 2.x */
  firmware?: {
    retrieveDateTime?: string;
    installDateTime?: string;
    signature?: string;
    signingCertificate?: unknown;
  };
}

type Params = Readonly<Record<string, JsonValue>>;

/** How often the wait for transactions looks again. */
const POLL_MS = 1000;

/** `failAt` values that exist on OCPP 2.x only. */
const FAIL_AT_V2_ONLY = ["InvalidSignature", "InstallVerificationFailed"];

/** Connectors this update made Unavailable, in `ctx.state`. */
const HELD = "heldConnectors";

/** One status interval: `stepMs`, plus a seeded draw when `jitterMs` is set. */
function stepPause(ctx: BehaviorContext): Promise<void> {
  const params: Params = ctx.params;
  const jitterMs = params.jitterMs as number;
  const extra = jitterMs > 0 ? ctx.random("firmware").int(0, jitterMs) : 0;
  return ctx.sleep((params.stepMs as number) + extra);
}

function heldIds(ctx: BehaviorContext): number[] {
  const held = ctx.state[HELD];
  return Array.isArray(held)
    ? held.filter((id): id is number => typeof id === "number")
    : [];
}

/**
 * OCPP 1.6 §5.19 / 2.x L01.FR.07: connectors that are not in use are set
 * Unavailable while the station waits for the sessions to end, and one that
 * becomes available meanwhile follows. Neither the availability nor the status
 * is persisted by the hold itself; {@link releaseConnectors} undoes it.
 */
function holdIdleConnectors(cp: ChargePoint, ctx: BehaviorContext): void {
  const held = heldIds(ctx);
  for (const connector of cp.connectors.values()) {
    if (
      held.includes(connector.id) ||
      connector.transaction ||
      connector.availability !== "Operative" ||
      connector.status !== OCPPStatus.Available
    ) {
      continue;
    }
    connector.availability = "Inoperative";
    cp.updateConnectorStatus(connector.id, OCPPStatus.Unavailable);
    held.push(connector.id);
  }
  ctx.state[HELD] = held;
}

function releaseConnectors(cp: ChargePoint, ctx: BehaviorContext): void {
  for (const id of heldIds(ctx)) {
    const connector = cp.getConnector(id);
    if (!connector) continue;
    connector.availability = "Operative";
    if (connector.status === OCPPStatus.Unavailable) {
      cp.updateConnectorStatus(id, OCPPStatus.Available);
    }
  }
  ctx.state[HELD] = [];
}

const hasTransaction = (cp: ChargePoint): boolean =>
  [...cp.connectors.values()].some((connector) => connector.transaction);

/**
 * The step before Installing: wait for the running transactions when asked
 * (1.6 §5.19; 2.x L01.FR.06), holding connectors Unavailable when asked.
 * Returns false when the update was cancelled meanwhile. With neither param
 * set it does nothing, and awaits nothing.
 */
async function prepareInstall(
  cp: ChargePoint,
  ctx: BehaviorContext,
  cancelled: () => boolean,
  onWait?: () => void,
): Promise<boolean> {
  const hold = ctx.params.connectorsUnavailable === true;
  if (ctx.params.waitForTransactions === true) {
    if (hold) holdIdleConnectors(cp, ctx);
    if (hasTransaction(cp)) onWait?.();
    while (hasTransaction(cp)) {
      await ctx.sleep(POLL_MS);
      if (cancelled()) return false;
      if (hold) holdIdleConnectors(cp, ctx);
    }
  } else if (hold) {
    holdIdleConnectors(cp, ctx);
  }
  return !cancelled();
}

/** The failure to end with: `failAt`, else the one-shot key (consumed). */
function resolveFailure(
  cp: ChargePoint,
  ctx: BehaviorContext,
  v2: boolean,
): string | undefined {
  const configured = cp.configuration.getString(
    "SimulatedFirmwareUpdateFailure",
  );
  const failAt = ctx.params.failAt as string;
  // One-shot: the next UpdateFirmware runs the happy path unless the key is
  // armed again.
  if (configured)
    cp.configuration.applyChange("SimulatedFirmwareUpdateFailure", "");
  if (!v2 && FAIL_AT_V2_ONLY.includes(failAt)) {
    cp.logger.warn(
      `UpdateFirmware: failAt ${failAt} exists on OCPP 2.x only; ignored on 1.6`,
      LogType.OCPP,
    );
    return configured;
  }
  return failAt === "none" ? configured : failAt;
}

function startTime(ctx: BehaviorContext, date: string | undefined): number {
  const parsed = new Date(date ?? Number.NaN).getTime();
  return Number.isNaN(parsed) || ctx.params.startAt === "now"
    ? ctx.now()
    : parsed;
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
 * OCPP 2.x (L01): a `firmware.signingCertificate` is validated first
 * (L01.FR.21): one that does not parse, is outside its validity period or is
 * not issued by an installed ManufacturerRootCertificate is answered
 * `InvalidCertificate` (L01.FR.22), no `requestId` is remembered and an
 * `InvalidFirmwareSigningCertificate` SecurityEventNotification follows
 * (L01.FR.02). Otherwise (or without a certificate) the request is accepted
 * and its `requestId` remembered for the FirmwareStatusNotification reports
 * the control plane drives; the station reports nothing on its own, unless the
 * `train` param is set (#600): then the train below runs, and a request that
 * replaces one in progress is answered `AcceptedCanceled` (L01.FR.24).
 *
 * Params: `stepMs`, `failAt`, `startAt` (#654); `train`,
 * `waitForTransactions`, `connectorsUnavailable`, `reboot`, `jitterMs` (#600),
 * all off by default so the default wire output is unchanged. `failAt` set to
 * a failure wins over the one-shot configuration key, which is still read and
 * cleared.
 *
 * The 2.x train (L01.FR.01, FR.10: every report carries `requestId`):
 * DownloadScheduled when `retrieveDateTime` is in the future (FR.13);
 * Downloading, retried `retries` more times `retryInterval` seconds apart
 * before DownloadFailed (FR.30); Downloaded; SignatureVerified, or
 * InvalidSignature with the InvalidFirmwareSignature security event (FR.03),
 * when the request carries a signature (FR.04); InstallScheduled while
 * `installDateTime` is in the future (FR.16) or the install waits for a
 * transaction (FR.34); Installing; InstallRebooting and a boot before
 * Installed (FR.32 a) or Installed then a boot (FR.32 b); Installed with the
 * FirmwareUpdated security event (FR.31).
 */
export function firmwareBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.firmware",
    params: PARAMS,
    onCall: {
      UpdateFirmware: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = (request ?? {}) as UpdateFirmwareRequest;
          if (isOcpp2Version(cp.ocppVersion)) {
            const signingCertificate = req.firmware?.signingCertificate;
            if (signingCertificate !== undefined) {
              const check = checkFirmwareSigningCertificate(
                signingCertificate,
                cp.nowDate(),
                cp.certificateStore
                  .listRootCertificates(["ManufacturerRootCertificate"])
                  .map((root) => root.pem),
              );
              if (!check.ok) {
                cp.logger.warn(
                  `UpdateFirmware: InvalidCertificate (${check.problem}): ${check.detail}`,
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
            }
            if (typeof req.requestId === "number") {
              cp.noteFirmwareRequest(req.requestId);
            }
            if (ctx.params.train !== true) {
              return { response: { status: "Accepted" } };
            }
            const replaces = ctx.state.inFlight === true;
            return {
              response: { status: replaces ? "AcceptedCanceled" : "Accepted" },
              after: () => train2(cp, ctx, req),
            };
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

          const startsAt = startTime(ctx, req.retrieveDate);
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
                const failureMode = resolveFailure(cp, ctx, false);
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
                    step === "Installing" &&
                    // Nothing asked: no extra turn, the former timing.
                    (ctx.params.waitForTransactions === true ||
                      ctx.params.connectorsUnavailable === true) &&
                    !(await prepareInstall(cp, ctx, () => ctx.stopping))
                  ) {
                    return;
                  }
                  if (
                    step === "Installed" &&
                    failureMode === "InstallationFailed"
                  ) {
                    ctx.notify.firmwareStatus("InstallationFailed");
                    return;
                  }
                  if (
                    step === "Installed" &&
                    ctx.params.reboot === "beforeInstalled"
                  ) {
                    // §5.19 "automatic reboot": Installed follows the boot.
                    releaseConnectors(cp, ctx);
                    if (!(await rebootAndWait(cp, ctx))) return;
                    ctx.notify.firmwareStatus("Installed");
                    await stepPause(ctx);
                    return;
                  }
                  ctx.notify.firmwareStatus(step);
                  await stepPause(ctx);
                }
                if (ctx.params.reboot === "afterInstalled") {
                  releaseConnectors(cp, ctx);
                  cp.boot();
                }
              } finally {
                ctx.state.inFlight = false;
                if (heldIds(ctx).length > 0) releaseConnectors(cp, ctx);
              }
            },
          };
        },
      },
    },
  };
}

/** How long a reboot waits for the CSMS to accept the BootNotification. */
const BOOT_WAIT_MS = 600_000;

/**
 * Send BootNotification and wait for the CSMS to accept it, so Installed is
 * the first thing the new firmware reports (1.6 §5.19, "automatic reboot";
 * 2.x L01.FR.32 a). False when it was not accepted within {@link BOOT_WAIT_MS}.
 */
async function rebootAndWait(
  cp: ChargePoint,
  ctx: BehaviorContext,
): Promise<boolean> {
  let unsubscribe = (): void => undefined;
  const accepted = new Promise<void>((resolve) => {
    unsubscribe = cp.events.on("bootNotificationResult", (result) => {
      if (result.status === "Accepted") resolve();
    });
  });
  try {
    cp.boot();
    await ctx.until(accepted, { ms: BOOT_WAIT_MS });
    // The boot gate opens right after the event; let it.
    await ctx.sleep(0);
    return !ctx.stopping;
  } catch {
    cp.logger.warn(
      "UpdateFirmware: the reboot was not accepted by the CSMS; Installed is not reported",
      LogType.OCPP,
    );
    return false;
  } finally {
    unsubscribe();
  }
}

/** L01.FR.31: the security event that follows Installed. */
function reportFirmwareUpdated(cp: ChargePoint): void {
  reportSecurityEvent(cp, "FirmwareUpdated");
}

function reportSecurityEvent(cp: ChargePoint, type: string): void {
  cp.sendSecurityEventNotification(type).catch((error: unknown) => {
    cp.logger.warn(
      `${type} not sent: ${error instanceof Error ? error.message : String(error)}`,
      LogType.OCPP,
    );
  });
}

/**
 * The OCPP 2.x status train (L01). A newer request bumps `state.generation`;
 * the train it replaces notices after its next wait and ends without a word
 * (L01.FR.24 allows DownloadFailed / InstallationFailed for it, never
 * requires them). Only the train that still owns the generation clears the
 * in-flight flag and gives the connectors back.
 */
async function train2(
  cp: ChargePoint,
  ctx: BehaviorContext,
  req: UpdateFirmwareRequest,
): Promise<void> {
  const generation =
    (typeof ctx.state.generation === "number" ? ctx.state.generation : 0) + 1;
  ctx.state.generation = generation;
  ctx.state.inFlight = true;
  const cancelled = (): boolean =>
    ctx.stopping || ctx.state.generation !== generation;
  const status = (value: string): void =>
    ctx.notify.firmwareStatus(value, { requestId: req.requestId });
  const failure = resolveFailure(cp, ctx, true);
  const firmware = req.firmware ?? {};
  try {
    const startsAt = startTime(ctx, firmware.retrieveDateTime);
    if (startsAt > ctx.now()) status("DownloadScheduled"); // L01.FR.13
    await ctx.sleep(Math.max(0, startsAt - ctx.now()));
    if (cancelled()) return;

    // Downloading, with the retries of the request (L01.FR.30).
    const attempts = 1 + Math.max(0, req.retries ?? 0);
    for (let attempt = 1; ; attempt += 1) {
      status("Downloading");
      await stepPause(ctx);
      if (cancelled()) return;
      if (failure !== "DownloadFailed") break;
      if (attempt >= attempts) {
        status("DownloadFailed");
        return;
      }
      await ctx.sleep(Math.max(0, req.retryInterval ?? 0) * 1000);
      if (cancelled()) return;
    }
    status("Downloaded");
    await stepPause(ctx);
    if (cancelled()) return;

    // L01.FR.04: the signature is checked when the request has one.
    const signed =
      typeof firmware.signature === "string" && firmware.signature !== "";
    if (failure === "InvalidSignature") {
      status("InvalidSignature");
      reportSecurityEvent(cp, "InvalidFirmwareSignature"); // L01.FR.03
      return;
    }
    if (signed) {
      status("SignatureVerified");
      await stepPause(ctx);
      if (cancelled()) return;
    }

    // L01.FR.05, FR.16: not before installDateTime.
    const installAt = new Date(
      firmware.installDateTime ?? Number.NaN,
    ).getTime();
    if (!Number.isNaN(installAt) && installAt > ctx.now()) {
      status("InstallScheduled");
      if (ctx.params.connectorsUnavailable === true) {
        holdIdleConnectors(cp, ctx);
      }
      await ctx.sleep(installAt - ctx.now());
      if (cancelled()) return;
    }
    // L01.FR.06, FR.07, FR.34.
    const wait = (): void => status("InstallScheduled");
    if (
      !(await prepareInstall(
        cp,
        ctx,
        cancelled,
        !Number.isNaN(installAt) ? undefined : wait,
      ))
    ) {
      return;
    }

    status("Installing");
    await stepPause(ctx);
    if (cancelled()) return;
    if (
      failure === "InstallationFailed" ||
      failure === "InstallVerificationFailed"
    ) {
      status(failure); // L01.FR.29 for the latter
      return;
    }
    if (ctx.params.reboot === "beforeInstalled") {
      // L01.FR.15, FR.32 a: the new firmware reports Installed after the boot.
      status("InstallRebooting");
      releaseConnectors(cp, ctx);
      if (!(await rebootAndWait(cp, ctx)) || cancelled()) return;
      status("Installed");
      reportFirmwareUpdated(cp);
      return;
    }
    status("Installed"); // L01.FR.28
    reportFirmwareUpdated(cp); // L01.FR.31
    if (ctx.params.reboot === "afterInstalled") {
      await stepPause(ctx);
      if (cancelled()) return;
      releaseConnectors(cp, ctx);
      cp.boot(); // L01.FR.32 b
    }
  } finally {
    if (ctx.state.generation === generation) {
      ctx.state.inFlight = false;
      if (heldIds(ctx).length > 0) releaseConnectors(cp, ctx);
    }
  }
}
