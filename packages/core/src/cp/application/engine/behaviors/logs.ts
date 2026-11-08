import type {
  Behavior,
  BehaviorParams,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

/** The knobs of the 1.6 upload; the default is the former constant. */
const PARAMS: BehaviorParams = {
  schema: {
    type: "object",
    properties: {
      uploadMs: {
        type: "integer",
        minimum: 0,
        maximum: 3_600_000,
        title: "Upload time (ms)",
        description: "Time between Uploading and Uploaded",
      },
      auto: {
        type: "boolean",
        title: "Automatic upload (OCPP 2.x)",
        description:
          "OCPP 2.x only: send Uploading and Uploaded after an accepted GetLog, and answer AcceptedCanceled to a GetLog that replaces an upload in progress (N01.FR.12). Off: acknowledge only, the control plane drives the notifications. OCPP 1.6 always uploads",
      },
    },
  },
  defaults: { uploadMs: 2000, auto: true },
};

interface GetLogRequest {
  logType?: string;
  requestId?: number;
}

/**
 * The default behavior of GetLog.
 *
 * OCPP 1.6 Security Whitepaper: the response returns the log's file name,
 * then, once it settled, the station sends LogStatusNotification `Uploading`
 * and, two seconds later, `Uploaded`, both carrying `requestId`. There is no
 * real log to upload, so the sequence is timer-driven.
 *
 * OCPP 2.x (N01): the request is accepted with a file name and, once the
 * answer settled, the station sends LogStatusNotification `Uploading` and,
 * `uploadMs` later, `Uploaded`, both carrying the request's `requestId`
 * (N01.FR.07 to FR.09; #601). A GetLog that arrives during an upload is
 * answered `AcceptedCanceled`; the upload it replaces ends with a
 * LogStatusNotification `AcceptedCanceled` for its own `requestId`
 * (N01.FR.12, FR.20) and never reports `Uploaded`. With `auto` off the
 * station reports nothing on its own and the control plane drives the
 * notifications, as before #601.
 */
export function logsBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.logs",
    params: PARAMS,
    onCall: {
      GetLog: {
        mode: "replace",
        handle: (request, ctx) => {
          const req = (request ?? {}) as GetLogRequest;
          if (isOcpp2Version(cp.ocppVersion)) {
            if (typeof req.requestId === "number") {
              cp.noteLogRequest(req.requestId);
            }
            const logType = req.logType ?? "DiagnosticsLog";
            const auto = ctx.params.auto === true;
            const previous = ctx.state.uploadingRequestId;
            const replaces =
              auto && previous !== undefined && previous !== null;
            return {
              response: {
                status: replaces ? "AcceptedCanceled" : "Accepted",
                // GetLogResponse.filename is bounded at 255 in the 2.0.1 schema.
                filename: `${cp.id}-${logType}-${req.requestId ?? 0}.log`.slice(
                  -255,
                ),
              },
              after: auto
                ? async (): Promise<void> => {
                    const generation =
                      (typeof ctx.state.uploadGeneration === "number"
                        ? ctx.state.uploadGeneration
                        : 0) + 1;
                    ctx.state.uploadGeneration = generation;
                    const requestId = req.requestId ?? 0;
                    if (typeof previous === "number") {
                      // N01.FR.20: the cancelled upload reports it.
                      ctx.notify.logStatus("AcceptedCanceled", {
                        requestId: previous,
                      });
                    }
                    ctx.state.uploadingRequestId = requestId;
                    try {
                      ctx.notify.logStatus("Uploading", { requestId });
                      await ctx.sleep(ctx.params.uploadMs as number);
                      if (
                        ctx.stopping ||
                        ctx.state.uploadGeneration !== generation
                      ) {
                        return;
                      }
                      ctx.notify.logStatus("Uploaded", { requestId });
                    } finally {
                      if (ctx.state.uploadGeneration === generation) {
                        ctx.state.uploadingRequestId = null;
                      }
                    }
                  }
                : undefined,
            };
          }

          cp.logger.info(
            `GetLog request received: logType=${req.logType} requestId=${req.requestId}`,
            LogType.DIAGNOSTICS,
          );
          return {
            response: {
              status: "Accepted",
              filename: `${cp.id}-${req.logType}-${req.requestId}.log`,
            },
            // Status notifications follow the CALLRESULT, never precede it.
            after: async (): Promise<void> => {
              ctx.notify.logStatus("Uploading", { requestId: req.requestId });
              await ctx.sleep(ctx.params.uploadMs as number);
              ctx.notify.logStatus("Uploaded", { requestId: req.requestId });
            },
          };
        },
      },
    },
  };
}
