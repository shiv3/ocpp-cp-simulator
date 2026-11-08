import type { Behavior, BehaviorParams } from "@ocpp-cp-sim/contracts/behavior";
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
        description: "Time between Uploading and Uploaded (OCPP 1.6 only)",
      },
    },
  },
  defaults: { uploadMs: 2000 },
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
 * OCPP 2.x (N01): the request is accepted with a file name and its
 * `requestId` remembered for the LogStatusNotification reports the control
 * plane drives; the station reports nothing on its own. A user behavior can
 * opt in to a sequence.
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
            return {
              response: {
                status: "Accepted",
                // GetLogResponse.filename is bounded at 255 in the 2.0.1 schema.
                filename: `${cp.id}-${logType}-${req.requestId ?? 0}.log`.slice(
                  -255,
                ),
              },
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
